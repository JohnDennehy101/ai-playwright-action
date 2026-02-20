var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// index.js
var core = __toESM(require("@actions/core"), 1);
var github = __toESM(require("@actions/github"), 1);
var EXCLUDED_EXTENSIONS = [".json", ".lock", ".md", ".txt", ".png", ".jpg", ".pdf"];
var isExcludedFile = (line, excludedExtensions) => {
  return excludedExtensions.some((ext) => line.toLowerCase().includes(ext));
};
var isDiffLine = (line) => {
  return line.startsWith("+++") || line.startsWith("---") || line.startsWith("+") || line.startsWith("-");
};
function filterDiff(rawDiff) {
  const lines = rawDiff.split("\n");
  const filtered = [];
  let shouldSkipFile = false;
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      shouldSkipFile = isExcludedFile(line, EXCLUDED_EXTENSIONS);
      continue;
    }
    if (shouldSkipFile || !isDiffLine(line)) {
      continue;
    }
    filtered.push(line);
  }
  return filtered.join("\n");
}
var validateInputs = (inputs) => {
  const missing = [];
  if (!inputs.token)
    missing.push("github-token");
  if (!inputs.apiKey)
    missing.push("llm-api-key");
  if (!inputs.host)
    missing.push("llm-host");
  if (!inputs.modelId)
    missing.push("model-id");
  return missing;
};
async function run() {
  try {
    const token = core.getInput("github-token");
    const apiKey = core.getInput("llm-api-key");
    const host = core.getInput("llm-host");
    const modelId = core.getInput("model-id");
    const missingInputs = validateInputs({ token, apiKey, host, modelId });
    if (missingInputs.length > 0) {
      core.setFailed(`Missing required inputs: ${missingInputs.join(", ")}`);
      return;
    }
    const endpoint = `http://${host}:8000/generate-test`;
    const octokit = github.getOctokit(token);
    const context2 = github.context;
    if (!context2.payload.pull_request) {
      core.setFailed("No Pull Request found. This action only runs on PRs.");
      return;
    }
    core.info("Fetching PR diff...");
    const { data: rawDiff } = await octokit.rest.pulls.get({
      owner: context2.repo.owner,
      repo: context2.repo.repo,
      pull_number: context2.payload.pull_request.number,
      mediaType: { format: "diff" }
    });
    const cleanDiff = filterDiff(rawDiff);
    core.info("=== FILTERED DIFF ===");
    core.info(cleanDiff);
    core.info("=== END FILTERED DIFF ===");
    core.info(`Filtered diff length: ${cleanDiff.length} characters`);
    core.info(`Original diff length: ${rawDiff.length} characters`);
    if (!cleanDiff || cleanDiff.length < 10) {
      core.info("Diff is empty or only contains excluded files. Skipping.");
      return;
    }
    core.info("TEST MODE: Skipping API call");
    core.info(`Would send to ${endpoint} with model_id: ${modelId}`);
    core.info(`Would send diff (first 500 chars): ${cleanDiff.substring(0, 500)}...`);
    const mockGeneratedCode = `// Generated Playwright Test (TEST MODE) 
   // test('should test the changes', async ({ page }) => {
  // This is a test comment to verify the PR comment functionality
  await page.goto('/');
  // Add your test assertions here
});`;
    core.info("TEST MODE: Posting test comment to PR...");
    await octokit.rest.issues.createComment({
      owner: context2.repo.owner,
      repo: context2.repo.repo,
      issue_number: context2.payload.pull_request.number,
      body: `### Generated Playwright Test (TEST MODE)

\`\`\`javascript
${mockGeneratedCode}
\`\`\``
    });
    core.info("Test comment posted successfully!");
    core.info("Test complete!");
  } catch (error) {
    if (error.response) {
      core.setFailed(`LLM Server Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else {
      core.setFailed(`Action Error: ${error.message}`);
    }
  }
}
run();
