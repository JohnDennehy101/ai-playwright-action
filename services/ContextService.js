import { getChangedFilesFromDiff } from '../utils/diff.js';
import {
    buildSameDirectoryTestPaths,
    buildSiblingTestsPaths,
    buildRootMirrorTestPaths,
    isSourceFilePath
} from '../utils/filePaths.js';

export class ContextService {
    constructor(ghClient) {
        this.gh = ghClient;
        this.MAX_FILES = 10;
        this.MAX_FILE_SIZE = 4000;
    }

    async fetchRelatedFiles(rawDiff, config) {
        const baseRef = await this.gh.getBaseRef();
        const headRef = await this.gh.getHeadRef();

        const changedFiles = getChangedFilesFromDiff(rawDiff);
        const seenPaths = new Set();
        const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

        const tasks = changedFiles.map(async (filePath) => {
            const fileResults = { tests: [], source: null };

            if (config.includeTests) {
                fileResults.tests = await this.#findTestsForFile(filePath, baseRef, config, seenPaths);
            }

            if (config.includeSources) {
                const isSource = isSourceFilePath(filePath, SOURCE_EXTS, config.testFileSuffixes);

                if (isSource) {
                    fileResults.source = await this.#findSourceFile(filePath, headRef, config, seenPaths);
                } else {
                    fileResults.source = await this.#findLogicForTestFile(
                        filePath,
                        headRef,
                        config.testFileSuffixes,
                        seenPaths
                    );
                }
            }

            return fileResults;
        });

        const allResults = await Promise.all(tasks);

        const finalTests = allResults
            .flatMap(r => r.tests)
            .slice(0, this.MAX_FILES);

        const finalSources = allResults
            .map(r => r.source)
            .filter(Boolean)
            .slice(0, this.MAX_FILES);

        return { tests: finalTests, sources: finalSources };
    }

    async #findTestsForFile(filePath, ref, config, seenPaths) {
        const exts = ['.ts', '.tsx', '.js', '.jsx'];
        const ext = exts.find(e => filePath.endsWith(e));
        if (!ext) return [];

        const withoutExt = filePath.slice(0, -ext.length);
        const suffixes = config.testFileSuffixes;

        const candidates = new Set([
            ...buildSameDirectoryTestPaths(withoutExt, ext, suffixes),
            ...buildSiblingTestsPaths(withoutExt, ext, suffixes),
            ...buildRootMirrorTestPaths(filePath, ext, suffixes, config.testFileRoots)
        ]);

        const foundFiles = [];
        for (const path of candidates) {
            if (seenPaths.has(path) || foundFiles.length >= this.MAX_FILES) continue;

            const file = await this.gh.getFileContent(path, ref);
            if (file) {
                seenPaths.add(path);
                foundFiles.push({
                    path: file.path,
                    content: file.content.substring(0, this.MAX_FILE_SIZE)
                });
            }
        }
        return foundFiles;
    }

    async #findLogicForTestFile(testPath, ref, testSuffixes, seenPaths) {
        let potentialLogicPath = testPath;
        for (const suffix of testSuffixes) {
            potentialLogicPath = potentialLogicPath.replace(suffix, '');
        }

        if (potentialLogicPath === testPath || seenPaths.has(potentialLogicPath)) {
            return null;
        }

        const file = await this.gh.getFileContent(potentialLogicPath, ref);
        if (file) {
            seenPaths.add(potentialLogicPath);
            return {
                path: file.path,
                content: file.content.substring(0, this.MAX_FILE_SIZE)
            };
        }
        return null;
    }

    async #findSourceFile(filePath, ref, config, seenPaths) {
        if (seenPaths.has(filePath)) return null;

        const file = await this.gh.getFileContent(filePath, ref);
        if (file) {
            seenPaths.add(filePath);
            return {
                path: file.path,
                content: file.content.substring(0, this.MAX_FILE_SIZE)
            };
        }
        return null;
    }
}