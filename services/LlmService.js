import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { MAX_TOOL_ROUNDS } from '../utils/constants.js';
import { extractTypeScript } from '../utils/extractGeneratedTestCode.js';
import { RequestService } from './RequestService.js';

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

    // Call the self-hosted GPU server (Digital Ocean droplet)
    async #callSelfHosted(prompt) {
        core.info(`Calling self-hosted LLM at http://${this.host}:8000/generate-test with model: ${this.modelId}`);

        // Use the RequestService with retry logic to make the request
        const response = await RequestService.post(
            `http://${this.host}:8000/generate-test`,
            { model_id: this.modelId, prompt },
            { apiKey: this.apiKey, timeout: 120000 }
        );

        // Return the generated test code from the response
        // Checks for different possible field in response for flexibility
        return response.data.generated_test || response.data.output || response.data.text || '';
    }

    // Call the HuggingFace Inference API
    async #callHuggingFace(prompt) {
        // Log for debugging
        core.info(`Calling HuggingFace Inference API with model: ${this.modelId}`);

        // POST request to the HuggingFace router API endpoint
        const response = await RequestService.post(
            'https://router.huggingface.co/v1/chat/completions',
            {
                model: `${this.modelId}:nscale`,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 1024,
                temperature: 0,
            },
            { apiKey: this.apiKey, timeout: 180000 }
        );

        // Return the generated test code from the response
        return response.data.choices?.[0]?.message?.content || '';
    }

    // Call Claude with optional MCP tool use
    async #callClaude(prompt, mcpService) {
        // Log for debugging
        core.info(`Calling Claude API with model: ${this.modelId}`);

        // Initialise Anthropic client with the provided API key
        const client = new Anthropic({ apiKey: this.apiKey });

        // Build the request parameters
        // Note longer max tokens limit here
        const requestParameters = {
            model: this.modelId,
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
        };

        // Add MCP tools if available by checking via defined helper function
        if (mcpService?.hasTools()) {
            // Get Claude MCP tools and append to parameters
            requestParameters.tools = mcpService.getToolsForClaude();

            // Log for debugging
            core.info(`Including ${requestParameters.tools.length} MCP tool(s) in Claude request`);
        }

        // Initial API call to Claude - retries with exponential backoff
        // As service can be down
        let response = await RequestService.withRetry(() => client.messages.create(requestParameters));

        // Make tool calls until the model returns a final text response
        const messages = [...requestParameters.messages];
        let rounds = 0;

        // Note limit defined to avoid infinite loops
        while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
            rounds++;

            // Add assistant response to conversation for full visibility
            messages.push({ role: 'assistant', content: response.content });

            // Loop over each tool use block and execute via MCP requests
            // to mcp service
            const toolResults = [];
            for (const block of response.content) {
                if (block.type === 'tool_use') {
                    core.info(`MCP tool call: ${block.name}`);
                    const result = await mcpService.callTool(block.name, block.input);
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: block.id,
                        content: result,
                    });
                }
            }

            // Send tool results back to Claude for the next round
            messages.push({ role: 'user', content: toolResults });

            // Call API again with updated conversation - retries with exponential backoff as service can be down
            response = await RequestService.withRetry(() =>
                client.messages.create({
                    ...requestParameters,
                    messages,
                })
            );
        }

        // Extract text from the final response
        const textBlocks = response.content.filter((b) => b.type === 'text');

        // Return generated test code from the response
        return textBlocks.map((b) => b.text).join('\n');
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

        // Route to Claude, HuggingFace Inference API, or self-hosted GPU based on host value
        let testCode;
        if (this.host === 'claude') {
            testCode = await this.#callClaude(prompt, mcpService);
        } else if (this.host === 'huggingface') {
            testCode = await this.#callHuggingFace(prompt);
        } else {
            testCode = await this.#callSelfHosted(prompt);
        }

        // Store the raw output for visibility before extracting code
        const rawOutput = testCode;

        // Extract the actual TypeScript test code from the raw LLM response
        // Handles markdown blocks, commentary, and other non-code output
        testCode = extractTypeScript(testCode);

        // If it is empty after cleaning, throw error
        if (!testCode) {
            throw new Error('LLM returned empty test code');
        }

        // Log for debugging
        core.info(`Generated test file (${testCode.length} chars from ${rawOutput.length} chars raw)`);

        // Return both the extracted test code and the raw LLM output
        return { testCode, rawOutput };
    }
}
