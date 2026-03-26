/**
 * Gets Playwright test code from the raw LLM response.
 * Handles cases where models wrap code in markdown fences
 * or include comments alongside the code.
 */
export function extractTypeScript(raw) {
    // First look for code blocks identified by ```
    const blockPattern = /```(\w*)\s*\n([\s\S]*?)```/g;

    // Define empty array
    const blocks = [];

    // Initialise match variable
    let match;

    // Loop through all matches found in raw ressponse
    while ((match = blockPattern.exec(raw)) !== null) {
        blocks.push({ language: match[1], content: match[2] });
    }

    // First check if any code blocks with test code
    const hasTest = (code) => /\btest\s*\(/.test(code);

    // If code block found and test within it, return immediately
    for (const block of blocks) {
        if (['typescript', 'ts'].includes(block.language) && hasTest(block.content)) {
            return block.content.trim();
        }
    }

    // No test block found but typescript or ts block found — should be able to run
    for (const block of blocks) {
        if (['typescript', 'ts'].includes(block.language)) {
            return block.content.trim();
        }
    }

    // No typescript block found but a block with test() found — should be usable
    for (const block of blocks) {
        if (hasTest(block.content)) {
            return block.content.trim();
        }
    }

    // If no code blocks matched, try regex scans for import statements, test blocks, test definitions
    const fallbackPatterns = [/import\s+\{[^}]*test[^}]*\}.*/s, /test\.describe\s*\(.*/s, /test\s*\(.*/s];

    for (const pattern of fallbackPatterns) {
        const fallbackMatch = pattern.exec(raw);
        if (fallbackMatch) {
            return fallbackMatch[0].trim();
        }
    }

    // If no match for any, just return the raw response
    return raw;
}
