import * as core from '@actions/core';
import * as github from '@actions/github';
import axios from 'axios';

const EXCLUDED_EXTENSIONS = ['.json', '.lock', '.md', '.txt', '.png', '.jpg', '.pdf'];

const isExcludedFile = (line, excludedExtensions) => {
    return excludedExtensions.some(ext => line.toLowerCase().includes(ext));
};

const isDiffLine = (line) => {
    return line.startsWith('+++') || line.startsWith('---') || line.startsWith('+') || line.startsWith('-');
};

function filterDiff(rawDiff) {
    const lines = rawDiff.split('\n');
    const filtered = [];
    let shouldSkipFile = false;

    for (const line of lines) {
        if (line.startsWith('diff --git')) {
            shouldSkipFile = isExcludedFile(line, EXCLUDED_EXTENSIONS);
            continue;
        }

        if (shouldSkipFile || !isDiffLine(line)) {
            continue;
        }

        filtered.push(line);
    }

    return filtered.join('\n');
}

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
        const token = core.getInput('github-token');
        const apiKey = core.getInput('llm-api-key');
        const host = core.getInput('llm-host');
        const modelId = core.getInput('model-id');

        const missingInputs = validateInputs({ token, apiKey, host, modelId });
        if (missingInputs.length > 0) {
            core.setFailed(`Missing required inputs: ${missingInputs.join(', ')}`);
            return;
        }

        const endpoint = `http://${host}:8000/generate-test`;
        const octokit = github.getOctokit(token);
        const context = github.context;

        if (!context.payload.pull_request) {
            core.setFailed('No Pull Request found. This action only runs on PRs.');
            return;
        }

        core.info('Fetching PR diff...');
        const { data: rawDiff } = await octokit.rest.pulls.get({
            owner: context.repo.owner,
            repo: context.repo.repo,
            pull_number: context.payload.pull_request.number,
            mediaType: { format: 'diff' },
        });

        const cleanDiff = filterDiff(rawDiff);

        core.info('=== FILTERED DIFF ===');
        core.info(cleanDiff);
        core.info('=== END FILTERED DIFF ===');
        core.info(`Filtered diff length: ${cleanDiff.length} characters`);
        core.info(`Original diff length: ${rawDiff.length} characters`);

        if (!cleanDiff || cleanDiff.length < 10) {
            core.info('Diff is empty or only contains excluded files. Skipping.');
            return;
        }

        core.info('TEST MODE: Skipping API call');
        core.info(`Would send to ${endpoint} with model_id: ${modelId}`);
        core.info(`Would send diff (first 500 chars): ${cleanDiff.substring(0, 500)}...`);

        core.info('TEST MODE: Posting test comment to PR...');

        const diffPreview = cleanDiff.length > 5000
            ? cleanDiff.substring(0, 5000) + '\n\n... (truncated, see logs for full diff)'
            : cleanDiff;

        core.info('TEST MODE: Posting test comment to PR...');
        await octokit.rest.issues.createComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: context.payload.pull_request.number,
            body: `### Generated Diff


            #### Filtered Diff Sent to Model:
\`\`\`diff
${diffPreview}
\`\`\`

---
*Note: This is a test run. The actual API call was skipped.*`
        });

        core.info('Test comment posted successfully!');

        /*
        core.info(`Sending filtered diff to Qwen at ${ host }...`);
        const response = await axios.post(endpoint, {
          diff: cleanDiff,
          model_id: modelId
        }, {
          headers: { 'X-API-KEY': apiKey },
          timeout: 60000
        });
    
        const generatedCode = response.data.generated_code;
    
        core.info('Posting generated test to PR...');
        await octokit.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: context.payload.pull_request.number,
          body: `### Generated Playwright Test\n\n\`\`\`javascript\n${generatedCode}\n\`\`\``
        });
        */

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