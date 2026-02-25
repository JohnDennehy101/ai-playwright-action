
export const buildSameDirectoryTestPaths = (withoutExt, ext, suffixes) => {
    return suffixes.map(suffix => `${withoutExt}${suffix}${ext}`);
};

export const buildSiblingTestsPaths = (withoutExt, ext, suffixes) => {
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

export const isSourceFilePath = (filePath, sourceExts, testSuffixes) => {
    if (!filePath || typeof filePath !== 'string') return false;

    const hasSourceExt = sourceExts.some(ext => filePath.endsWith(ext));
    if (!hasSourceExt) return false;

    const fileName = filePath.split('/').pop();
    const isTestFile = testSuffixes.some(suffix => fileName.includes(suffix));

    return !isTestFile;
};

export const buildRootMirrorTestPaths = (filePath, ext, suffixes, roots) => {
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

export const getCandidateTestPathsForFile = (filePath, testFileSuffixes, testFileRoots) => {
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

export const getLogicNameFromTest = (filePath, testSuffixes) => {
    const fileName = filePath.split('/').pop();

    const exts = ['.tsx', '.ts', '.jsx', '.js'];
    const ext = exts.find(e => fileName.endsWith(e));
    if (!ext) return null;

    let baseName = fileName.slice(0, -ext.length);

    for (const suffix of testSuffixes) {
        if (baseName.endsWith(suffix)) {
            baseName = baseName.slice(0, -suffix.length);
            break;
        }
    }

    return `${baseName}${ext}`;
};