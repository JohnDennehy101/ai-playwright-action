import { getChangedFilesFromDiff } from '../utils/diff.js';
import {
    buildSameDirectoryTestPaths,
    buildSiblingTestsPaths,
    buildRootMirrorTestPaths,
    isSourceFilePath,
    getLogicalNameFromTest,
} from '../utils/filePaths.js';
import { TARGET_SOURCE_EXTENSIONS } from '../utils/constants.js';

export class ContextService {
    // The ContextService analyses the git diff of the pull request
    // to identify which files have changed
    // and then fetches the relevant test files and source files based on changes.
    // GitHub client used to interact with the repo.
    constructor(ghClient) {
        // Pass GitHub client instance for API calls to GitHub
        this.githubClient = ghClient;

        // Limit file numbers and file size for focusing context for model
        this.MAX_FILES = 10;
        this.MAX_FILE_SIZE = 20000;
    }

    // Public function that fetches relevant files based on the pull request diff
    async fetchRelatedFiles(rawDiff, config, sourceExtensions = TARGET_SOURCE_EXTENSIONS) {
        // Get base and head refs for pull request
        const baseRef = await this.githubClient.getBaseRef();
        const headRef = await this.githubClient.getHeadRef();

        // Extract changed files from the diff and filter down to relevant files
        const changedFiles = getChangedFilesFromDiff(rawDiff);

        // Define set to keep track of seen file paths
        // Avoids duplicates
        const seenPaths = new Set();

        // For each changed file, find related test files and source files in parallel
        // Using the helper functions for finding test files
        const tasks = changedFiles.map(async (filePath) => {
            const fileResults = { tests: [], source: null };

            // If set to include tests, find related test files for this change
            if (config.includeTests) {
                // Find test files related to this changed file and add to results
                fileResults.tests = await this.#findTestsForFile(
                    filePath,
                    baseRef,
                    config,
                    seenPaths,
                    sourceExtensions
                );
            }

            // If set to include source files, find the relevant source file for this change
            if (config.includeSources) {
                // Determine if the changed file is a source file or a test file based on its path and extension
                const isSource = isSourceFilePath(filePath, sourceExtensions, config.testFileSuffixes);

                // If it's a source file, find the source file directly, otherwise find the source file relative to the test file
                if (isSource) {
                    fileResults.source = await this.#findSourceFile(filePath, headRef, seenPaths);
                } else {
                    fileResults.source = await this.#findSourcePathForTestFile(filePath, headRef, config, seenPaths);
                }
            }

            // Return the found relevant files for this changed file
            return fileResults;
        });

        // Wait for all file processing tasks to complete before progressing
        const allResults = await Promise.all(tasks);

        // Flatten and limit to max files based on config for tests
        const finalTests = allResults.flatMap((r) => r.tests).slice(0, this.MAX_FILES);

        // Likewise for source files, filter and limit to max files value
        const finalSources = allResults
            .map((r) => r.source)
            .filter(Boolean)
            .slice(0, this.MAX_FILES);

        // Return releavant test files and source files which are
        // provided as context to the model for test generation
        return { tests: finalTests, sources: finalSources };
    }

    // Public function to find the tests if any for the existing
    // file path
    async #findTestsForFile(filePath, ref, config, seenPaths, sourceExtensions) {
        // First check if file is test file, if so return empty array
        const targetExtension = sourceExtensions.find((e) => filePath.endsWith(e));
        if (!targetExtension) return [];

        // If it is a code file, want to actually find any test files that test the code in the file
        const withoutExtension = filePath.slice(0, -targetExtension.length);

        // Get the test file suffixes from config which determine the naming convention for test files
        const suffixes = config.testFileSuffixes;

        // Make a candidate set for file paths for potential test files
        const candidates = new Set([
            ...buildSameDirectoryTestPaths(withoutExtension, targetExtension, suffixes),
            ...buildSiblingTestsPaths(withoutExtension, targetExtension, suffixes),
            ...buildRootMirrorTestPaths(filePath, targetExtension, suffixes, config.testFileRoots),
        ]);

        // Initialise to empty list
        const foundFiles = [];

        // Loop over the candidate paths
        for (const path of candidates) {
            // If we've hit the max files limit, break out of the loop
            if (foundFiles.length >= this.MAX_FILES) break;

            // Skip files that have already been seen to avaoid duplicates
            if (seenPaths.has(path)) continue;

            // Use the authenticated GitHub client to try fetch the file contents for the path
            const file = await this.githubClient.getFileContent(path, ref);

            // If a file actually found at the candidate path,
            // add it to results and add to seen paths to avoid duplicate checks
            if (file) {
                seenPaths.add(path);
                foundFiles.push({
                    path: file.path,
                    content: file.content.substring(0, this.MAX_FILE_SIZE),
                });
            }
        }

        // Finally, return the found test files for the changed code file if any
        return foundFiles;
    }

    // Private function which checks if the path hasn't already been seent
    #isValidContextPath(path, originalPath, seenPaths) {
        return path && path !== originalPath && !seenPaths.has(path);
    }

    // Private function to find the most relevant source file for a test file based on naming conventions
    async #findSourcePathForTestFile(testPath, ref, config, seenPaths) {
        // Use helper function to get the name of the source file being tested based on test file name
        const logicalFileName = getLogicalNameFromTest(testPath, config.testFileSuffixes);

        // If no logical file name could be extracted, return null
        if (!logicalFileName) return null;

        // Try find the source file based on the logical name and check it's valid before returning it as context for the model
        const discoveredPath = await this.githubClient.findFileByName(logicalFileName);
        if (!this.#isValidContextPath(discoveredPath, testPath, seenPaths)) {
            return null;
        }

        // If valid, fetch file content and return as context for the model
        const file = await this.githubClient.getFileContent(discoveredPath, ref);
        if (file) {
            seenPaths.add(discoveredPath);
            return {
                path: file.path,
                content: file.content.substring(0, this.MAX_FILE_SIZE),
            };
        }

        // If file not found or not valid, return null
        return null;
    }

    // Private function to find the source file directly
    async #findSourceFile(filePath, ref, seenPaths) {
        // Check if file path is valid and hasn't already been seen
        if (seenPaths.has(filePath)) return null;

        // Fetch file content and return as context for the model if valid
        const file = await this.githubClient.getFileContent(filePath, ref);
        if (file) {
            seenPaths.add(filePath);
            return {
                path: file.path,
                content: file.content.substring(0, this.MAX_FILE_SIZE),
            };
        }

        // Otherwise, if file not found or not valid, return null
        return null;
    }
}
