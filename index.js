import * as path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { logDiffInfo, buildNewFileReviewBody, buildResultsReviewBody } from './utils/comment.js';
import { GitHubClient } from './services/GitHubClientService.js';
import { ContextService } from './services/ContextService.js';
import { LlmService } from './services/LlmService.js';
import { McpService } from './services/McpService.js';
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
    let mcpService = null;

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
            startDevServer: core.getInput('start-dev-server') !== 'false',
            mcpServers: core.getInput('mcp-servers'),
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

        // Build unique test file name using PR number (e.g. e2e/ai-generated-pr-42.spec.ts)
        // Double extensions like .spec.ts need to be covered correctly
        const testOutputDirectory = path.dirname(inputs.testOutputPath);
        const fullFileName = path.basename(inputs.testOutputPath);

        // Split on first full stop to get base name and full extension (e.g. "ai-generated", ".spec.ts")
        const firstDotIndex = fullFileName.indexOf('.');
        const baseName = firstDotIndex > 0 ? fullFileName.slice(0, firstDotIndex) : fullFileName;
        const fullExtension = firstDotIndex > 0 ? fullFileName.slice(firstDotIndex) : '';

        // Create unique file name with PR number
        const uniqueTestFileName = `${baseName}-pr-${gh.prNumber}${fullExtension}`;

        // Combine directory and unique file name to get full path for generated test file
        const testOutputPath = path.join(testOutputDirectory, uniqueTestFileName);

        // Determine file paths for relevant test and source files based on diff and configuration value
        const repoRelativeTestPath =
            inputs.appDirectory === '.' ? testOutputPath : path.join(inputs.appDirectory, testOutputPath);

        // Prevent loop: check latest commit message and skip if it was already made by this action
        const latestCommitMessage = await gh.getLatestCommitMessage();
        if (latestCommitMessage.includes(COMMIT_MARKER)) {
            core.info('Latest commit was made by this action. Skipping to prevent loop.');
            return;
        }

        // Also skip if the generated test file already exists on the current branch
        const testFileExists = await gh.fileExistsOnBranch(repoRelativeTestPath);
        if (testFileExists) {
            core.info(`Generated test file ${repoRelativeTestPath} already exists on branch. Skipping.`);
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
            core.info(
                `Dry run complete. Found ${tests.length} test file(s) and ${sources.length} source file(s) for context.`
            );
            core.info(`Diff length: ${cleanDiff.length} characters`);
            return;
        }

        // When MCP configuration is passed, the dev server must be running before the LLM call
        // so that the LLM can interact with the running app
        // Therefore, calling TestRunnerService early to handle dependencies and server startup.
        const hasMcp = !!inputs.mcpServers;
        if (hasMcp || inputs.runTests) {
            testRunner = new TestRunnerService({
                appDirectory: inputs.appDirectory,
                installCommand: inputs.installCommand,
                devServerCommand: inputs.devServerCommand,
                devServerUrl: inputs.devServerUrl,
                testOutputPath,
            });

            // Install dependencies and browsers needed for both MCP browsing and test execution
            testRunner.installDependencies();
            await testRunner.installPlaywrightBrowsers();

            // Start the dev server so MCP tools can browse the running app
            if (hasMcp || inputs.startDevServer) {
                await testRunner.startDevServer();
            }
        }

        // Initialise MCP service if servers are configured
        if (inputs.mcpServers) {
            try {
                // Parse the config that has been passed for MCP
                const serversConfig = JSON.parse(inputs.mcpServers);

                // Initialise the mcp service
                mcpService = new McpService();

                // Connect to MCP servers
                await mcpService.connect(serversConfig);
            } catch (err) {
                core.warning(`Failed to initialise MCP servers: ${err.message}`);
            }
        }

        // Initialise LLM service
        const llm = new LlmService(inputs.host, inputs.apiKey, inputs.modelId, inputs.devServerUrl);

        // Call LLM to generate test code (passes mcpService for tool use if available)
        const { testCode, rawOutput } = await llm.generateTestFile(cleanDiff, tests, sources, mcpService);

        // Log raw LLM output and extracted code for debugging
        core.info('=== RAW LLM OUTPUT ===');
        core.info(rawOutput);
        core.info('=== END RAW LLM OUTPUT ===');
        core.info('=== EXTRACTED TEST CODE ===');
        core.info(testCode);
        core.info('=== END EXTRACTED TEST CODE ===');

        if (inputs.runTests) {
            // Write generated test file to disk
            testRunner.writeTestFile(testCode);

            // Run the tests and extract the results
            const result = testRunner.runTests();

            // Log test output for debugging
            core.info('=== TEST OUTPUT ===');
            core.info(result.output);
            core.info('=== END TEST OUTPUT ===');

            // For full visibility, include MCP tool calls
            const mcpSummary = mcpService ? mcpService.getToolCallSummary() : '';

            // Pass in mcp tool call summary and raw output to the review body
            const reviewBody = buildResultsReviewBody({
                filePath: repoRelativeTestPath,
                passed: result.passed,
                exitCode: result.exitCode,
                output: result.output,
                mcpSummary,
                rawOutput,
                testCode,
            });

            if (result.passed) {
                // Tests passed — commit the file and request review to approve/reject
                // For easy experience for users
                await gh.createOrUpdateFile(
                    repoRelativeTestPath,
                    testCode,
                    `test: add AI-generated Playwright tests (PR #${gh.prNumber})\n\nGenerated end-to-end tests based on PR diff.`
                );
                core.info(`Tests passed — committed generated test file to ${repoRelativeTestPath}`);

                // Note posting as REQUEST_CHANGES type so PR is blocked until the reviewer
                // dismisses (keeps the test file) or deletes the file (removes the file)
                await gh.createReview(reviewBody, 'REQUEST_CHANGES');
            } else {
                // Tests failed — don't commit, just post results as a comment
                // For full visibility
                core.setFailed(`Playwright tests failed with exit code ${result.exitCode}`);
                await gh.createReview(reviewBody);
            }
        } else {
            // No test run — commit the file and request review to approve/reject
            await gh.createOrUpdateFile(
                repoRelativeTestPath,
                testCode,
                `test: add AI-generated Playwright tests (PR #${gh.prNumber})\n\nGenerated end-to-end tests based on PR diff.`
            );
            core.info(`Committed generated test file to ${repoRelativeTestPath}`);

            // Get summary of MCP tool calls for full visibility of work completed by the model
            const mcpSummary = mcpService ? mcpService.getToolCallSummary() : '';

            // Note posting as REQUEST_CHANGES type so PR is blocked until the reviewer
            // dismisses (keeps the test file) or deletes the file (removes the file)
            await gh.createReview(
                buildNewFileReviewBody(repoRelativeTestPath, mcpSummary, rawOutput),
                'REQUEST_CHANGES'
            );
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

        // Disconnect from MCP server if it was connected
        if (mcpService) {
            await mcpService.disconnect();
        }
    }
}

run();
