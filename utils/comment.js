import * as core from '@actions/core';

const MAX_COMMENT_LENGTH = 60000;

export const buildDiffCommentBody = (diffPreview) => {
    return `### Generated Diff

#### Filtered Diff Sent to Model:
\`\`\`diff
${diffPreview}
\`\`\`

---
*Note: This is a test run. The actual API call was skipped.*`;
};

export const buildFilesCommentBody = (title, chunkIndex, totalChunks, filesChunk) => {
    let body = `### ${title} (${chunkIndex + 1}/${totalChunks})\n`;
    for (const file of filesChunk) {
        body += `\n**${file.path}** (${file.content.length} chars):\n`;
        body += `\`\`\`typescript\n${file.content.substring(0, 500)}${file.content.length > 500 ? '...' : ''}\n\`\`\`\n`;
    }
    return body;
};

export const chunkExistingFilesForComments = (existingFiles) => {
    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;

    for (const file of existingFiles) {
        const estimatedLength = file.path.length + file.content.substring(0, 500).length + 200;

        if (currentLength + estimatedLength > MAX_COMMENT_LENGTH && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentLength = 0;
        }

        currentChunk.push(file);
        currentLength += estimatedLength;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
};

const postFileChunks = async ({ gh, title, files }) => {
    if (!files || !files.length) return;

    const chunks = chunkExistingFilesForComments(files);
    const totalChunks = chunks.length;

    for (let i = 0; i < totalChunks; i++) {
        const body = buildFilesCommentBody(title, i, totalChunks, chunks[i]);
        await gh.createComment(body);

        if (i < totalChunks - 1) await new Promise(r => setTimeout(r, 1500));
    }
};

export const postTestComment = async ({
    gh,
    cleanDiff,
    existingTests = [],
    sourceFiles = [],
}) => {
    const diffPreview = cleanDiff.length > 5000
        ? cleanDiff.substring(0, 5000) + '\n\n... (truncated, see logs for full diff)'
        : cleanDiff;

    await gh.createComment(buildDiffCommentBody(diffPreview));

    await postFileChunks({
        gh,
        title: 'Existing Test Files Included for Context',
        files: existingTests,
    });

    await postFileChunks({
        gh,
        title: 'Existing Source Files Included for Context',
        files: sourceFiles,
    });
};

export const logDiffInfo = (cleanDiff, rawDiff) => {
    core.info('=== FILTERED DIFF ===');
    core.info(cleanDiff);
    core.info('=== END FILTERED DIFF ===');
    core.info(`Filtered diff length: ${cleanDiff.length} characters`);
    core.info(`Original diff length: ${rawDiff.length} characters`);
};