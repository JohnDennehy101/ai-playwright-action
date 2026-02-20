import * as core from '@actions/core';
import * as github from '@actions/github';
import axios from 'axios';

const EXCLUDED_EXTENSIONS = ['.json', '.lock', '.md', '.txt', '.png', '.jpg', '.pdf', '.yml', '.yaml'];

const extractFilePath = (line) => {
    const diffGitMatch = line.match(/diff --git a\/(.+?) b\//);
    if (diffGitMatch) {
        return diffGitMatch[1];
    }

    const minusMatch = line.match(/^--- a\/(.+)$/);
    if (minusMatch) {
        return minusMatch[1];
    }

    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusMatch) {
        return plusMatch[1];
    }

    return null;
};

const hasExcludedExtension = (text, excludedExtensions) => {
    return excludedExtensions.some(ext => text.toLowerCase().includes(ext));
};

const matchesExcludePattern = (filePath, excludePattern) => {
    if (!excludePattern) {
        return false;
    }

    try {
        const regex = new RegExp(excludePattern);
        return regex.test(filePath);
    } catch (error) {
        core.warning(`Invalid exclude-pattern regex: ${excludePattern}. Error: ${error.message}`);
        return false;
    }
};

const isExcludedFile = (line, excludedExtensions, excludePattern) => {
    const filePath = extractFilePath(line);

    if (!filePath) {
        return hasExcludedExtension(line, excludedExtensions);
    }

    if (hasExcludedExtension(filePath, excludedExtensions)) {
        return true;
    }

    return matchesExcludePattern(filePath, excludePattern);
};

const isDiffLine = (line) => {
    return line.startsWith('+++') || line.startsWith('---') || line.startsWith('+') || line.startsWith('-');
};

function filterDiff(rawDiff, excludePattern) {
    const lines = rawDiff.split('\n');
    const filtered = [];
    let shouldSkipFile = false;

    for (const line of lines) {
        if (line.startsWith('diff --git')) {
            shouldSkipFile = isExcludedFile(line, EXCLUDED_EXTENSIONS, excludePattern);
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

const fetchPRDiff = async (octokit, context) => {
    core.info('Fetching PR diff...');
    const { data: rawDiff } = await octokit.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.payload.pull_request.number,
        mediaType: { format: 'diff' },
    });
    return rawDiff;
};

const postTestComment = async (octokit, context, cleanDiff) => {
    const diffPreview = cleanDiff.length > 5000
        ? cleanDiff.substring(0, 5000) + '\n\n... (truncated, see logs for full diff)'
        : cleanDiff;

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
};

const logDiffInfo = (cleanDiff, rawDiff) => {
    core.info('=== FILTERED DIFF ===');
    core.info(cleanDiff);
    core.info('=== END FILTERED DIFF ===');
    core.info(`Filtered diff length: ${cleanDiff.length} characters`);
    core.info(`Original diff length: ${rawDiff.length} characters`);
};

async function run() {
    try {
        const token = core.getInput('github-token');
        const apiKey = core.getInput('llm-api-key');
        const host = core.getInput('llm-host');
        const modelId = core.getInput('model-id');
        const excludePattern = core.getInput('exclude-pattern');

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

        const rawDiff = await fetchPRDiff(octokit, context);
        const cleanDiff = filterDiff(rawDiff, excludePattern);

        logDiffInfo(cleanDiff, rawDiff)

        if (!cleanDiff || cleanDiff.length < 10) {
            core.info('Diff is empty or only contains excluded files. Skipping.');
            return;
        }

        core.info('TEST MODE: Skipping API call');
        core.info(`Would send to ${endpoint} with model_id: ${modelId}`);
        core.info(`Would send diff (first 500 chars): ${cleanDiff.substring(0, 500)}...`);

        core.info('TEST MODE: Posting test comment to PR...');
        await postTestComment(octokit, context, cleanDiff);
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