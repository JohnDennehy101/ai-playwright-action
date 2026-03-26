import * as core from '@actions/core';
import { extractTypeScript } from '../utils/extractGeneratedTestCode.js';
import { ProviderFactory } from '../providers/ProviderFactory.js';

export class LlmService {
    // The LlmService interacts with the GPU running via API to generate Playwright test code based on the provided diff and context.
    constructor(host, apiKey, modelId, baseUrl) {
        // host: address of the LLM API server
        // apiKey: API key for authenticating with the LLM service
        // modelId: identifier of the specific LLM model to use for generation (Hugging Face)
        // baseUrl: base URL of the application under test, used in generated test code
        this.host = host;
        this.apiKey = apiKey;
        this.modelId = modelId;
        this.baseUrl = baseUrl;
    }

    // Private function that constructs an MCP enhanced prompt that tells the model to explore the running app first
    // Used when MCP tools (e.g. Playwright MCP) are available
    #buildMcpPrompt(diff, existingTests, sourceFiles) {
        // Start prompt initialisation
        // Tell the model to browse the app before writing tests
        let prompt =
            'You have access to a Playwright MCP server that lets you interact with a running web app.\n\n' +
            `The app is running at ${this.baseUrl}\n\n` +
            'TASK: Generate Playwright e2e tests for the following code change.\n' +
            'Before writing any tests, use your Playwright tools to:\n' +
            `1. Navigate to ${this.baseUrl}\n` +
            '2. Take a snapshot to see the current UI structure\n' +
            '3. Interact with the changed functionality to understand how it works\n' +
            '4. Then write comprehensive Playwright test code\n\n' +
            // Proven chain-of-thought structure for test generation
            'Analyze the following data step-by-step:\n' +
            '1. Identify the UI change from the diff.\n' +
            '2. Map the change to the implementation in the source code.\n' +
            '3. Outline the test steps.\n' +
            '4. Write the final Playwright test code.\n\n';

        // Add the diff as the data for the model to analyse
        prompt += `Data:\n### GIT DIFF:\n\n${diff}\n`;

        // And also add the source code files if present
        if (sourceFiles.length > 0) {
            prompt += '\n### SOURCE CODE FILE:\n\n';
            for (const file of sourceFiles) {
                prompt += `// ${file.path}\n${file.content}\n`;
            }
        }

        // Finally add any existing tests
        // so the model has as much context as possible
        if (existingTests.length > 0) {
            prompt += '\n### EXISTING TEST FILE:\n\n';
            for (const file of existingTests) {
                prompt += `// ${file.path}\n${file.content}\n`;
            }
        }

        // Closing instruction matching the proven prompt format
        prompt +=
            '\n\nIMPORTANT: Return ONLY the Playwright test code (TypeScript) in a ```typescript code block.\n' +
            "Use @playwright/test imports. The tests should be runnable with 'npx playwright test'.\n";

        // Return prompt
        return prompt;
    }

    // Private function to build the prompt actually passed to the model
    #buildPrompt(diff, existingTests, sourceFiles) {
        // Most successful prompt was chain-of-though for open-source models
        let prompt =
            'Analyze the following data step-by-step:\n' +
            '1. Identify the UI change from the diff.\n' +
            '2. Map the change to the implementation in the source code.\n' +
            '3. Outline the test steps.\n' +
            '4. Write the final Playwright test code.\n\n' +
            'IMPORTANT REQUIREMENTS for the final code:\n' +
            "- Start with: import { test, expect } from '@playwright/test';\n" +
            `- Use ${this.baseUrl} as the base URL for page.goto()\n` +
            '- Output ONLY raw TypeScript code — no markdown fences (```), no explanations\n' +
            '- Ensure the code is syntactically valid TypeScript\n';

        // If existing tests already prsent, ask the model to match their style
        if (existingTests.length > 0) {
            prompt += '- Match the style of the existing test files provided below.\n';
        }

        // Add the diff within the prompt
        prompt += `Data:\n### GIT DIFF:\n\n${diff}\n`;

        // If source code files provided, add to prompt
        if (sourceFiles.length > 0) {
            prompt += '\n### SOURCE CODE FILE:\n\n';
            for (const file of sourceFiles) {
                prompt += `// ${file.path}\n${file.content}\n`;
            }
        }

        // If existing test files provided, add to prompt
        if (existingTests.length > 0) {
            prompt += '\n### EXISTING TEST FILE:\n\n';
            for (const file of existingTests) {
                prompt += `// ${file.path}\n${file.content}\n`;
            }
        }

        // Return final constructed prompt
        return prompt;
    }

    // Public function to actually call the LLM API and generate test code
    // Note that mcpService is optional — pass it to enable MCP tool use with Claude
    // MCP tools are only supported with Claude — HuggingFace
    // does not reliably support tool use, so MCP is skipped if not Claude
    async generateTestFile(diff, existingTests = [], sourceFiles = [], mcpService = null) {
        // Only use MCP enhanced prompts with Claude, as other providers don't support tool use
        const useMcp = this.host === 'claude' && mcpService?.hasTools();
        const prompt = useMcp
            ? this.#buildMcpPrompt(diff, existingTests, sourceFiles)
            : this.#buildPrompt(diff, existingTests, sourceFiles);

        if (mcpService?.hasTools() && this.host !== 'claude') {
            core.warning('MCP tools are configured but only supported with Claude (llm-host: claude). Skipping tools.');
        }

        // Route to the relevant provider based on host value
        const provider = ProviderFactory.create(this.host, this.apiKey, this.modelId);
        let testCode = await provider.call(prompt, mcpService);

        // Store the raw output for visibility before extracting code
        const rawOutput = testCode;

        // Extract the actual TypeScript test code from the raw LLM response
        // Handles markdown blocks, commentary, and other non-code output
        testCode = extractTypeScript(testCode);

        // If it is empty after cleaning and parsing, throw error
        if (!testCode) {
            throw new Error(
                'LLM returned empty test code. The model may have used all tokens on tool calls without generating code.'
            );
        }

        // Check if the extracted code looks like a valid Playwright test
        if (!/\btest\s*\(/.test(testCode) && !/\btest\.describe\s*\(/.test(testCode)) {
            core.warning(
                'Generated code does not contain test() or test.describe() — may not be valid Playwright test code'
            );
        }

        // Log for debugging
        core.info(`Generated test file (${testCode.length} chars from ${rawOutput.length} chars raw)`);

        // Return both the extracted test code and the raw LLM output
        return { testCode, rawOutput };
    }
}
