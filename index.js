import * as core from '@actions/core';
import * as github from '@actions/github';
import { logDiffInfo, buildNewFileReviewBody, buildResultsReviewBody } from './utils/comment.js';
import { GitHubClient } from './services/GitHubClientService.js';
import { ContextService } from './services/ContextService.js';
import { LlmService } from './services/LlmService.js';
import { TestRunnerService } from './services/TestRunnerService.js';
import { filterDiff } from './utils/diff.js';
import { COMMIT_MARKER } from './utils/constants.js';

const parseCommaSeparated = (value, defaults) => {
    if (!value) return defaults;
    return value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
};

const validateInputs = (inputs) => {
    const missing = [];
    if (!inputs.token) missing.push('github-token');
    if (!inputs.apiKey) missing.push('llm-api-key');
    if (!inputs.host) missing.push('llm-host');
    if (!inputs.modelId) missing.push('model-id');
    return missing;
};

async function run() {
    let testRunner = null;

    try {
        const inputs = {
            token: core.getInput('github-token'),
            apiKey: core.getInput('llm-api-key'),
            host: core.getInput('llm-host'),
            modelId: core.getInput('model-id'),
            excludePattern: core.getInput('exclude-pattern'),
            includeExistingTests: core.getInput('include-existing-tests') === 'true',
            includeSourceFiles: core.getInput('include-source-files') === 'true',
            testFileSuffixes: parseCommaSeparated(core.getInput('test-file-suffixes'), [
                '.spec',
                '.test',
                '.e2e',
                '.playwright',
            ]),
            testFileRoots: parseCommaSeparated(core.getInput('test-file-roots'), ['src', 'app', 'packages/app']),
            runTests: core.getInput('run-tests') === 'true',
            appDirectory: core.getInput('app-directory') || '.',
            installCommand: core.getInput('install-command') || 'npm ci',
            devServerCommand: core.getInput('dev-server-command') || 'npm run dev',
            devServerUrl: core.getInput('dev-server-url') || 'http://localhost:5175',
            testOutputPath: core.getInput('test-output-path') || 'e2e/ai-generated.spec.ts',
            dryRun: core.getInput('dry-run') === 'true',
        };

        if (!inputs.dryRun) {
            const missingInputs = validateInputs(inputs);
            if (missingInputs.length > 0) {
                core.setFailed(`Missing required inputs: ${missingInputs.join(', ')}`);
                return;
            }
        }

        const octokit = github.getOctokit(inputs.token);
        const gh = new GitHubClient(octokit, github.context);
        const contextService = new ContextService(gh);

        if (!gh.prNumber) {
            core.setFailed('No Pull Request found. This action only runs on PRs.');
            return;
        }

        // Prevent loop: check latest commit message and skip if it was already made by this action
        const latestCommitMessage = await gh.getLatestCommitMessage();
        if (latestCommitMessage.includes(COMMIT_MARKER)) {
            core.info('Latest commit was made by this action. Skipping to prevent loop.');
            return;
        }

        // Also skip if the generated test file already exists on the current branch
        const testFileExists = await gh.fileExistsOnBranch(inputs.testOutputPath);
        if (testFileExists) {
            core.info(`Generated test file ${inputs.testOutputPath} already exists on branch. Skipping.`);
            return;
        }

        const rawDiff = await gh.getPullRequestDiff();
        const cleanDiff = filterDiff(rawDiff, inputs.excludePattern);

        // Remains for now - TODO remove when validate that it is working
        logDiffInfo(cleanDiff, rawDiff);

        if (!cleanDiff || cleanDiff.length < 10) {
            core.info('Diff is empty or only contains excluded files. Skipping.');
            return;
        }

        const { tests, sources } = await contextService.fetchRelatedFiles(rawDiff, {
            includeTests: inputs.includeExistingTests,
            includeSources: inputs.includeSourceFiles,
            testFileSuffixes: inputs.testFileSuffixes,
            testFileRoots: inputs.testFileRoots,
        });

        // In dry-run mode, log what was gathered and exit
        if (inputs.dryRun) {
            core.info(`Dry run complete. Found ${tests.length} test file(s) and ${sources.length} source file(s) for context.`);
            core.info(`Diff length: ${cleanDiff.length} characters`);
            return;
        }

        // Initialise LLM service
        const llm = new LlmService(inputs.host, inputs.apiKey, inputs.modelId, inputs.devServerUrl);

        // Call LLM to generate test code
        const testCode = await llm.generateTestFile(cleanDiff, tests, sources);

        if (inputs.runTests) {
            // Initialise TestRunnerService, which handles
            // writing the test file, installing dependencies, starting
            // dev server, running tests and cleans up after
            testRunner = new TestRunnerService({
                appDirectory: inputs.appDirectory,
                installCommand: inputs.installCommand,
                devServerCommand: inputs.devServerCommand,
                devServerUrl: inputs.devServerUrl,
                testOutputPath: inputs.testOutputPath,
            });

            // Write generated test file to disk
            testRunner.writeTestFile(testCode);

            // Install dependencies
            testRunner.installDependencies();

            // Install Playwright browsers
            testRunner.installPlaywrightBrowsers();

            // Start the dev server before running tests against it
            await testRunner.startDevServer();

            // Run the tests and extract the results
            const result = testRunner.runTests();

            // Prepare the body of PR review comment with test results
            const reviewBody = buildResultsReviewBody({
                filePath: inputs.testOutputPath,
                passed: result.passed,
                exitCode: result.exitCode,
                output: result.output,
            });

            // If the tests are passing, commit generated test file
            // and post review with results.
            if (result.passed) {
                // Commit the file to the PR branch
                await gh.createOrUpdateFile(
                    inputs.testOutputPath,
                    testCode,
                    `test: add AI-generated Playwright tests\n\nGenerated end-to-end tests based on PR diff.`
                );
                core.info(`Tests passed — committed generated test file to ${inputs.testOutputPath}`);
                await gh.createReview(reviewBody);
            } else {
                // As tests failed don't commit, just post the results on the PR
                core.setFailed(`Playwright tests failed with exit code ${result.exitCode}`);

                // Call the API to create review with the generated test results
                await gh.createReview(reviewBody);
            }
        } else {
            // No test run — commit directly and let the reviewer decide whether
            // to include generated files or not
            await gh.createOrUpdateFile(
                inputs.testOutputPath,
                testCode,
                `test: add AI-generated Playwright tests\n\nGenerated end-to-end tests based on PR diff.`
            );
            core.info(`Committed generated test file to ${inputs.testOutputPath}`);

            // Call the API to create review with generated test file info
            await gh.createReview(buildNewFileReviewBody(inputs.testOutputPath));
        }
    } catch (error) {
        if (error.response) {
            core.setFailed(`LLM Server Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else {
            core.setFailed(`Action Error: ${error.message}`);
        }
    } finally {
        // Cleanup after the action is completed or if any error in place
        if (testRunner) {
            testRunner.cleanup();
        }
    }
}

run();
