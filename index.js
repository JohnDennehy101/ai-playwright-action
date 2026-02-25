import * as core from '@actions/core';
import * as github from '@actions/github';
import { postTestComment, logDiffInfo } from './utils/comment.js';
import { GitHubClient } from './services/GitHubClientService.js';
import { ContextService } from './services/ContextService.js';
import { filterDiff } from './utils/diff.js';

const parseCommaSeparated = (value, defaults) => {
    if (!value) return defaults;
    return value.split(',').map(v => v.trim()).filter(Boolean);
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
    try {
        const inputs = {
            token: core.getInput('github-token'),
            apiKey: core.getInput('llm-api-key'),
            host: core.getInput('llm-host'),
            modelId: core.getInput('model-id'),
            excludePattern: core.getInput('exclude-pattern'),
            includeExistingTests: core.getInput('include-existing-tests') === 'true',
            includeSourceFiles: core.getInput('include-source-files') === 'true',
            testFileSuffixes: parseCommaSeparated(
                core.getInput('test-file-suffixes'),
                ['.spec', '.test', '.e2e', '.playwright']
            ),
            testFileRoots: parseCommaSeparated(
                core.getInput('test-file-roots'),
                ['src', 'app', 'packages/app']
            )
        };

        const missingInputs = validateInputs(inputs);
        if (missingInputs.length > 0) {
            core.setFailed(`Missing required inputs: ${missingInputs.join(', ')}`);
            return;
        }

        const octokit = github.getOctokit(inputs.token);
        const gh = new GitHubClient(octokit, github.context);
        const contextService = new ContextService(gh);

        if (!gh.prNumber) {
            core.setFailed('No Pull Request found. This action only runs on PRs.');
            return;
        }

        const rawDiff = await gh.getPullRequestDiff();
        const cleanDiff = filterDiff(rawDiff, inputs.excludePattern);

        logDiffInfo(cleanDiff, rawDiff);

        if (!cleanDiff || cleanDiff.length < 10) {
            core.info('Diff is empty or only contains excluded files. Skipping.');
            return;
        }

        const { tests, sources } = await contextService.fetchRelatedFiles(rawDiff, {
            includeTests: inputs.includeExistingTests,
            includeSources: inputs.includeSourceFiles,
            testFileSuffixes: inputs.testFileSuffixes,
            testFileRoots: inputs.testFileRoots
        });

        core.info('TEST MODE: Skipping API call');
        core.info(`Would send to http://${inputs.host}:8000/generate-test with model_id: ${inputs.modelId}`);

        core.info('TEST MODE: Posting test comment to PR...');
        await postTestComment({
            gh,
            cleanDiff,
            existingTests: tests,
            sourceFiles: sources
        });

        core.info('Test complete!');

    } catch (error) {
        if (error.response) {
            core.setFailed(`LLM Server Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else {
            core.setFailed(`Action Error: ${error.message}`);
        }
    }
}

run();