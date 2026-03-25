import { EXCLUDED_EXTENSIONS } from './constants.js';

// Helper function to extract file path from a diff line
export const extractFilePath = (line) => {
    // Tries to match common diff line formats to extract the file path
    const diffGitMatch = line.match(/diff --git a\/(.+?) b\//);

    // If match found for diff --git format, return the file path
    if (diffGitMatch) return diffGitMatch[1];

    // Matches lines starting with --- or +++ which indicate file paths in diffs
    const minusMatch = line.match(/^--- a\/(.+)$/);

    // If match found for --- format, return the file path
    if (minusMatch) return minusMatch[1];

    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);

    // If match found for +++ format, return the file path, otherwise null
    return plusMatch ? plusMatch[1] : null;
};

// Simple function to check if a file path is a source file based on file extension
const hasExcludedExtension = (text, excludedExtensions) => {
    return excludedExtensions.some((ext) => text.toLowerCase().includes(ext));
};

// Function to check if a file path should be excluded based on its extension or an optional exclude pattern
const matchesExcludePattern = (filePath, excludePattern) => {
    // If no exclude pattern provided, don't exclude based on pattern
    if (!excludePattern) {
        return false;
    }

    // Try to create regex from exclude pattern and test the file path against it
    try {
        const regex = new RegExp(excludePattern);
        return regex.test(filePath);
    } catch (error) {
        // If regex is invalid, log a warning and don't exclude based on pattern
        core.warning(`Invalid exclude-pattern regex: ${excludePattern}. Error: ${error.message}`);
        return false;
    }
};

// Function that checks if current line provided as param matches for diff line
const isDiffLine = (line) => {
    // Lines that start with +, -, ---, +++ are typically part of the diff output indicating changes or file paths
    return line.startsWith('+++') || line.startsWith('---') || line.startsWith('+') || line.startsWith('-');
};

// Function to check if file path should be excluded based on extention or exclude pattern
const isExcludedFile = (line, excludedExtensions, excludePattern) => {
    // Get file path from the line using the helper function
    const filePath = extractFilePath(line);

    // If no file path could be extracted, check if the line itself matches excluded extensions (some diffs might not have standard format)
    if (!filePath) {
        return hasExcludedExtension(line, excludedExtensions);
    }

    // Check if the extracted file path has an excluded extension
    if (hasExcludedExtension(filePath, excludedExtensions)) {
        return true;
    }

    // If file path doesn't have an excluded extension, check if it matches the exclude pattern
    return matchesExcludePattern(filePath, excludePattern);
};

// Function to filter raw diff by removing lines
// related to files that not be included based on their extension
// or an optional exclude pattern provided by the user
export function filterDiff(rawDiff, excludePattern) {
    // Split the raw diff by new lines
    const lines = rawDiff.split('\n');

    // Empty array which will hold filtered lines
    const filtered = [];

    // Boolean to keep track if current file being processed should be skipped based on its extension or exclude pattern
    let shouldSkipFile = false;

    // Loop over the lines
    for (const line of lines) {
        // If line indicates start of file diff
        if (line.startsWith('diff --git')) {
            // Check if file should be skipped based on extension
            shouldSkipFile = isExcludedFile(line, EXCLUDED_EXTENSIONS, excludePattern);
            continue;
        }

        // If current file should be skipped, just continue
        // If not diff line, generally context line which should be excluded
        if (shouldSkipFile || !isDiffLine(line)) {
            continue;
        }

        // If line is part of a file that shouldn't be skipped and is a diff line, include it in the filtered results
        filtered.push(line);
    }

    // Finally join filtered lines and return
    return filtered.join('\n');
}

// Function to extract changed file paths from a raw diff string
export const getChangedFilesFromDiff = (rawDiff) => {
    const lines = rawDiff.split('\n');
    return Array.from(new Set(lines.map(extractFilePath).filter(Boolean)));
};
