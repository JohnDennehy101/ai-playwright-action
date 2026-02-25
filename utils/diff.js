const EXCLUDED_EXTENSIONS = ['.json', '.lock', '.md', '.txt', '.png', '.jpg', '.pdf', '.yml', '.yaml'];

export const extractFilePath = (line) => {
    const diffGitMatch = line.match(/diff --git a\/(.+?) b\//);
    if (diffGitMatch) return diffGitMatch[1];
    const minusMatch = line.match(/^--- a\/(.+)$/);
    if (minusMatch) return minusMatch[1];
    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    return plusMatch ? plusMatch[1] : null;
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

const isDiffLine = (line) => {
    return line.startsWith('+++') || line.startsWith('---') || line.startsWith('+') || line.startsWith('-');
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

export function filterDiff(rawDiff, excludePattern) {
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

export const getChangedFilesFromDiff = (rawDiff) => {
    const lines = rawDiff.split('\n');
    return Array.from(new Set(lines.map(extractFilePath).filter(Boolean)));
};