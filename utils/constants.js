export const COMMIT_MARKER = 'AI-generated Playwright tests';
export const TARGET_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
export const EXCLUDED_EXTENSIONS = ['.json', '.lock', '.md', '.txt', '.png', '.jpg', '.pdf', '.yml', '.yaml'];
export const MAX_TOOL_ROUNDS = 10;
export const MAX_RETRIES = 3;
export const INITIAL_RETRY_DELAY_MS = 5000;
export const RETRYABLE_STATUS_CODES = [429, 529];
