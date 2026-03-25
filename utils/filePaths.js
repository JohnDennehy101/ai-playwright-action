import { TARGET_SOURCE_EXTENSIONS } from './constants.js';

// Helper function to build candidate test file paths in the same directory
// as the source file based on common test file naming practices
export const buildSameDirectoryTestPaths = (withoutExtension, extensions, suffixes) => {
    return suffixes.map((suffix) => `${withoutExtension}${suffix}${extensions}`);
};

// Helper function to build candidate test file paths in sibling __tests__ directory
// As __tests__ directory is a common approach
export const buildSiblingTestsPaths = (withoutExtension, extension, suffixes) => {
    // Use current file path to build potential test file paths
    const lastSlash = withoutExtension.lastIndexOf('/');

    // If no slash found, means file is in root directory, so can't have sibling __tests__ directory, return empty array
    if (lastSlash === -1) {
        return [];
    }

    // Build potential test file paths in sibling __tests__ directory with the provided suffixes
    const directory = withoutExtension.slice(0, lastSlash);

    // Base is the file name without the directory, used to construct test file name in __tests__ directory
    const base = withoutExtension.slice(lastSlash + 1);

    // If either directory or base is empty, return empty array as can't build valid test paths
    if (!directory || !base) {
        return [];
    }

    // Map over the provided suffixes to construct potential test file paths in the sibling __tests__ directory
    return suffixes.map((suffix) => `${directory}/__tests__/${base}${suffix}${extension}`);
};

// Function to check if a file path corresponds to a source file based on its extension and whether it includes test suffixes
export const isSourceFilePath = (filePath, sourceExtensions, testSuffixes) => {
    // If file path not provided, can't be valid
    if (!filePath || typeof filePath !== 'string') return false;

    // Check if the current file path has one of the source file extensions
    const hasSourceExtension = sourceExtensions.some((ext) => filePath.endsWith(ext));

    // If it doesn't, not a source code file
    if (!hasSourceExtension) return false;

    // Check if the file name includes any of the test suffixes, if so it's not a source file
    const fileName = filePath.split('/').pop();
    const isTestFile = testSuffixes.some((suffix) => fileName.includes(suffix));

    // If file has a source code extension but also includes test suffix, treat it as a test file, not source file
    return !isTestFile;
};

// Helper function to build candidate test file paths in root-level tests directory that mirror the source file structure
export const buildRootMirrorTestPaths = (filePath, extension, suffixes, roots) => {
    // Initialise array to hold potential test file paths
    const paths = [];

    // Loop over provided root test directories
    for (const rootRaw of roots) {
        // For each, check if file path start with root
        // If it does, build a potential test file path
        const root = rootRaw.endsWith('/') ? rootRaw : `${rootRaw}/`;

        // If not, then skip to the next one
        if (!filePath.startsWith(root)) {
            continue;
        }

        // If it does, build a potential test file path by mirroring the source file structure under the root test directory
        const relativePath = filePath.slice(root.length);

        // If relative path is empty, means file is directly under root, so can't build mirrored test path, skip to next
        if (!relativePath) {
            continue;
        }

        // Loop over the provided suffixes to build potential test file paths for each suffix
        for (const suffix of suffixes) {
            paths.push(`tests/${relativePath.replace(extension, `${suffix}${extension}`)}`);
        }
    }

    // Return candidate test file paths that were built based on the provided roots and suffixes
    return paths;
};

// Helper function to extract logical name from test file path by removing test suffixes and returning the base name
export const getLogicalNameFromTest = (filePath, testSuffixes, sourceExtensions = TARGET_SOURCE_EXTENSIONS) => {
    // Get file name from path
    const fileName = filePath.split('/').pop();

    // Check if file name has a source file extension
    const extension = sourceExtensions.find((e) => fileName.endsWith(e));

    // If not return null as it is not a target source file path
    if (!extension) return null;

    // Extract base name by removing the extension
    let baseName = fileName.slice(0, -extension.length);

    // Loop over provided test suffixes and
    // Remove any from base name to get the most 'logical'
    // name of the source file
    // Note all of these approaches aim for best effort and consistent
    // naming patterns across the repo
    for (const suffix of testSuffixes) {
        if (baseName.endsWith(suffix)) {
            baseName = baseName.slice(0, -suffix.length);
            break;
        }
    }

    // Return the 'logical' name by readding the extension to the base name
    return `${baseName}${extension}`;
};
