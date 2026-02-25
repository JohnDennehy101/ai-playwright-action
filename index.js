import * as core from '@actions/core';
import * as github from '@actions/github';
import axios from 'axios';

const EXCLUDED_EXTENSIONS = ['.json', '.lock', '.md', '.txt', '.png', '.jpg', '.pdf', '.yml', '.yaml'];
const MAX_COMMENT_LENGTH = 60000;

const parseCommaSeparated = (value, defaults) => {
    if (!value) return defaults;
    return value
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
};

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

const buildDiffCommentBody = (diffPreview) => {
    return `### Generated Diff

#### Filtered Diff Sent to Model:
\`\`\`diff
${diffPreview}
\`\`\`

---
*Note: This is a test run. The actual API call was skipped.*`;
};

const buildTestsCommentBody = (chunkIndex, totalChunks, testsChunk) => {
    let body = `### Existing Test Files Included for Context (${chunkIndex + 1}/${totalChunks})\n`;
    for (const testFile of testsChunk) {
        body += `\n**${testFile.path}** (${testFile.content.length} chars):\n`;
        body += `\`\`\`typescript\n${testFile.content.substring(0, 500)}${testFile.content.length > 500 ? '...' : ''}\n\`\`\`\n`;
    }
    return body;
};

const chunkExistingTestsForComments = (existingTests) => {
    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;

    for (const test of existingTests) {
        const estimatedLength =
            test.path.length +
            test.content.substring(0, 500).length +
            200;

        if (currentLength + estimatedLength > MAX_COMMENT_LENGTH && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentLength = 0;
        }

        currentChunk.push(test);
        currentLength += estimatedLength;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const postTestComment = async (octokit, context, cleanDiff, existingTests = []) => {
    const diffPreview = cleanDiff.length > 5000
        ? cleanDiff.substring(0, 5000) + '\n\n... (truncated, see logs for full diff)'
        : cleanDiff;

    const diffBody = buildDiffCommentBody(diffPreview);
    await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.payload.pull_request.number,
        body: diffBody,
    });

    if (existingTests.length === 0) {
        return;
    }

    const chunks = chunkExistingTestsForComments(existingTests);
    const totalChunks = chunks.length;

    for (let i = 0; i < totalChunks; i++) {
        const body = buildTestsCommentBody(i, totalChunks, chunks[i]);
        await octokit.rest.issues.createComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: context.payload.pull_request.number,
            body,
        });

        if (i < totalChunks - 1) {
            await sleep(1500);
        }
    }
};

const logDiffInfo = (cleanDiff, rawDiff) => {
    core.info('=== FILTERED DIFF ===');
    core.info(cleanDiff);
    core.info('=== END FILTERED DIFF ===');
    core.info(`Filtered diff length: ${cleanDiff.length} characters`);
    core.info(`Original diff length: ${rawDiff.length} characters`);
};

const getChangedFilesFromDiff = (rawDiff) => {
    const lines = rawDiff.split('\n');
    const files = new Set();

    for (const line of lines) {
        const filePath = extractFilePath(line);
        if (filePath) {
            files.add(filePath);
        }
    }

    return Array.from(files);
};

const buildSameDirectoryTestPaths = (withoutExt, ext, suffixes) => {
    return suffixes.map(suffix => `${withoutExt}${suffix}${ext}`);
};

const buildSiblingTestsPaths = (withoutExt, ext, suffixes) => {
    const lastSlash = withoutExt.lastIndexOf('/');
    if (lastSlash === -1) {
        return [];
    }

    const dir = withoutExt.slice(0, lastSlash);
    const base = withoutExt.slice(lastSlash + 1);
    if (!dir || !base) {
        return [];
    }

    return suffixes.map(suffix => `${dir}/__tests__/${base}${suffix}${ext}`);
};

const buildRootMirrorTestPaths = (filePath, ext, suffixes, roots) => {
    const paths = [];

    for (const rootRaw of roots) {
        const root = rootRaw.endsWith('/') ? rootRaw : `${rootRaw}/`;
        if (!filePath.startsWith(root)) {
            continue;
        }

        const rel = filePath.slice(root.length);
        if (!rel) {
            continue;
        }

        for (const suffix of suffixes) {
            paths.push(`tests/${rel.replace(ext, `${suffix}${ext}`)}`);
        }
    }

    return paths;
};

const getCandidateTestPathsForFile = (filePath, testFileSuffixes, testFileRoots) => {
    if (!filePath || typeof filePath !== 'string') {
        return [];
    }

    const exts = ['.ts', '.tsx', '.js', '.jsx'];
    const ext = exts.find(e => filePath.endsWith(e));
    if (!ext) {
        return [];
    }

    const withoutExt = filePath.slice(0, -ext.length);
    const candidates = [];

    const isAlreadyTestFile = testFileSuffixes.some(suffix => withoutExt.endsWith(suffix));
    if (isAlreadyTestFile) {
        candidates.push(filePath);
    }

    candidates.push(
        ...buildSameDirectoryTestPaths(withoutExt, ext, testFileSuffixes),
        ...buildSiblingTestsPaths(withoutExt, ext, testFileSuffixes),
        ...buildRootMirrorTestPaths(filePath, ext, testFileSuffixes, testFileRoots),
    );

    return Array.from(new Set(candidates));
};

const fetchBaseRef = async (octokit, context) => {
    const pr = await octokit.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.payload.pull_request.number,
    });
    return pr.data.base.ref;
};

const fetchTestFileContent = async ({ octokit, context, candidatePath, ref, maxFileSize }) => {
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner: context.repo.owner,
            repo: context.repo.repo,
            path: candidatePath,
            ref,
        });

        if (!data) {
            return null;
        }

        if (!('content' in data)) {
            return null;
        }

        if (!data.content) {
            return null;
        }

        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return {
            path: candidatePath,
            content: content.substring(0, maxFileSize),
        };

    } catch (err) {
        core.debug(`No test file at ${candidatePath}: ${err.message}`);
    }
    return null;
};

const collectTestsForFile = async ({
    octokit,
    context,
    filePath,
    baseRef,
    maxFiles,
    maxFileSize,
    seenPaths,
    testFiles,
    testFileSuffixes,
    testFileRoots,
}) => {
    if (testFiles.length >= maxFiles) return;

    const candidatePaths = getCandidateTestPathsForFile(filePath, testFileSuffixes, testFileRoots);
    for (const candidate of candidatePaths) {
        if (testFiles.length >= maxFiles) break;
        if (seenPaths.has(candidate)) continue;

        seenPaths.add(candidate);
        const testFile = await fetchTestFileContent({
            octokit,
            context,
            candidatePath: candidate,
            ref: baseRef,
            maxFileSize,
        });
        if (testFile) {
            testFiles.push(testFile);
            core.info(`Found related test file: ${candidate}`);
        }
    }
};

const fetchExistingTestFiles = async ({ octokit, context, rawDiff, testFileSuffixes, testFileRoots }) => {
    core.info('Fetching existing test files for changed files from base branch...');

    const MAX_FILES = 10;
    const MAX_FILE_SIZE = 4000;

    try {
        const baseRef = await fetchBaseRef(octokit, context);
        const changedFiles = getChangedFilesFromDiff(rawDiff);
        const testFiles = [];
        const seenPaths = new Set();

        for (const filePath of changedFiles) {
            if (testFiles.length >= MAX_FILES) break;

            await collectTestsForFile({
                octokit,
                context,
                filePath,
                baseRef,
                maxFiles: MAX_FILES,
                maxFileSize: MAX_FILE_SIZE,
                seenPaths,
                testFiles,
                testFileSuffixes,
                testFileRoots,
            });
        }

        core.info(`Collected ${testFiles.length} related test file(s) for context`);
        return testFiles;
    } catch (error) {
        core.warning(`Failed to fetch existing test files: ${error.message}`);
        return [];
    }
};

async function run() {
    try {
        const token = core.getInput('github-token');
        const apiKey = core.getInput('llm-api-key');
        const host = core.getInput('llm-host');
        const modelId = core.getInput('model-id');
        const excludePattern = core.getInput('exclude-pattern');
        const includeExistingTests = core.getInput('include-existing-tests') === 'true';
        const testFileSuffixes = parseCommaSeparated(
            core.getInput('test-file-suffixes'),
            ['.spec', '.test', '.e2e', '.playwright']
        );
        const testFileRoots = parseCommaSeparated(
            core.getInput('test-file-roots'),
            ['src', 'app', 'packages/app']
        );


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

        let existingTests = [];
        if (includeExistingTests) {
            existingTests = await fetchExistingTestFiles({
                octokit,
                context,
                rawDiff,
                testFileSuffixes,
                testFileRoots,
            });
        }

        core.info('TEST MODE: Skipping API call');
        core.info(`Would send to ${endpoint} with model_id: ${modelId}`);
        core.info(`Would send diff (first 500 chars): ${cleanDiff.substring(0, 500)}...`);

        core.info('TEST MODE: Posting test comment to PR...');
        await postTestComment(octokit, context, cleanDiff, existingTests);
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