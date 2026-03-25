import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { MAX_TOOL_ROUNDS } from '../utils/constants.js';

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
        let prompt =
            'You have access to Playwright MCP tools to interact with a running web application.\n\n' +
            'Follow these steps:\n' +
            `1. Navigate to ${this.baseUrl} and take a snapshot to understand the current UI.\n` +
            '2. Review the git diff below to understand what changed.\n' +
            '3. Use the Playwright tools to interact with the changed functionality — click buttons, fill forms, verify elements.\n' +
            '4. Based on your exploration, write comprehensive Playwright test code.\n\n' +
            'IMPORTANT REQUIREMENTS for the final code:\n' +
            "- Start with: import { test, expect } from '@playwright/test';\n" +
            `- Use ${this.baseUrl} as the base URL for page.goto()\n` +
            '- Use getByRole, getByText, or getByLabel locators\n' +
            '- Include assertions using expect()\n' +
            '- Output ONLY raw TypeScript code — no markdown fences (```), no explanations\n' +
            '- Ensure the code is syntactically valid TypeScript\n';

        // Add tests message if they are present for more context
        if (existingTests.length > 0) {
            prompt += '- Match the style of the existing test files provided below.\n';
        }

        // Add the diff for futher context
        prompt += `\n### GIT DIFF:\n\n${diff}\n`;

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
        prompt += `\nData:\n### GIT DIFF:\n\n${diff}\n`;

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

        const response = await axios.post(
            `http://${this.host}:8000/generate-test`,
            {
                model_id: this.modelId,
                prompt,
            },
            {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 120000,
            }
        );

        return response.data.generated_test || response.data.output || response.data.text || '';
    }

    // Call the HuggingFace Inference API (with optional MCP tool use)
    async #callHuggingFace(prompt, mcpService) {
        // Log for debugging
        core.info(`Calling HuggingFace Inference API with model: ${this.modelId}`);

        // Define initial messages array and request body
        const messages = [{ role: 'user', content: prompt }];
        const requestBody = {
            model: `${this.modelId}:nscale`,
            messages,
            max_tokens: 1024,
            temperature: 0,
        };

        // Add MCP tools if available to add context
        if (mcpService?.hasTools()) {
            requestBody.tools = mcpService.getToolsForOpenAI();

            // Log for debugging
            core.info(`Including ${requestBody.tools.length} MCP tool(s) in HuggingFace request`);
        }

        // Add authorisation header (API key needed)
        const headers = {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
        };

        // Simple POST request to the API endpoint
        let response = await axios.post('https://router.huggingface.co/v1/chat/completions', requestBody, {
            headers,
            timeout: 180000,
        });

        // Keep looping until the model returns a final text response
        let rounds = 0;

        // Note limit defined to avoid infinite loops
        while (response.data.choices?.[0]?.message?.tool_calls && rounds < MAX_TOOL_ROUNDS) {
            rounds++;

            // Extract current assistant message (with potential tool calls)
            const assistantMsg = response.data.choices[0].message;

            // Push to messages array
            messages.push(assistantMsg);

            // Execute each tool call via the MCP server
            for (const toolCall of assistantMsg.tool_calls) {
                // log for debugging
                core.info(`MCP tool call: ${toolCall.function.name}`);

                // Parse args for the tool call
                const args = JSON.parse(toolCall.function.arguments || '{}');

                // Call the MCP service to run the tool call and get the result
                const result = await mcpService.callTool(toolCall.function.name, args);

                // Push tool result back to messages so it will be included in next round
                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: result,
                });
            }

            // Send tool results back to the model for the next round
            response = await axios.post(
                'https://router.huggingface.co/v1/chat/completions',
                { ...requestBody, messages },
                { headers, timeout: 180000 }
            );
        }

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

        // Initial API call to Claude
        let response = await client.messages.create(requestParameters);

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

            // Call API again with updated conversation
            response = await client.messages.create({
                ...requestParameters,
                messages,
            });
        }

        // Extract text from the final response
        const textBlocks = response.content.filter((b) => b.type === 'text');

        // Return generated test code from the response
        return textBlocks.map((b) => b.text).join('\n');
    }

    // Public function to actually call the LLM API and generate test code
    // Note that mcpService is optional — pass it to enable MCP tool use with Claude or HuggingFace
    // In testing, mcp was shown to significantly improve quality and success of generated tests
    async generateTestFile(diff, existingTests = [], sourceFiles = [], mcpService = null) {
        // If MCP service provided but no tools available
        // Make API calls without tools
        // If tools avaialble, use them as well
        const prompt = mcpService?.hasTools()
            ? this.#buildMcpPrompt(diff, existingTests, sourceFiles)
            : this.#buildPrompt(diff, existingTests, sourceFiles);

        // Route to Claude, HuggingFace Inference API, or self-hosted GPU based on host value
        let testCode;
        if (this.host === 'claude') {
            testCode = await this.#callClaude(prompt, mcpService);
        } else if (this.host === 'huggingface') {
            testCode = await this.#callHuggingFace(prompt, mcpService);
        } else {
            testCode = await this.#callSelfHosted(prompt);
        }

        // Clean output to ensure only raw Typescript code is returned
        // Strip any text before start of tests
        testCode = testCode
            .replace(/^```(?:typescript|ts|javascript|js)?\n/m, '')
            .replace(/\n```$/m, '')
            .trim();

        // If it is empty after cleaning, throw error
        if (!testCode) {
            throw new Error('LLM returned empty test code');
        }

        // Log for debugging
        core.info(`Generated test file (${testCode.length} chars)`);

        // Return generated test code
        return testCode;
    }
}
