import axios from 'axios';
import * as core from '@actions/core';

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

    // Call the HuggingFace Inference API
    async #callHuggingFace(prompt) {
        // Log for debugging
        core.info(`Calling HuggingFace Inference API with model: ${this.modelId}`);

        // Simple POST request to the API endpoint
        const response = await axios.post(
            `https://router.huggingface.co/v1/chat/completions`,
            {
                model: `${this.modelId}:nscale`,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 1024,
                temperature: 0,
            },
            {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 180000,
            }
        );

        // Return the generated test code from the response
        return response.data.choices?.[0]?.message?.content || '';
    }

    // Public function to actually call the LLM API and generate test code
    async generateTestFile(diff, existingTests = [], sourceFiles = []) {
        // Call helper function to build the prompt
        const prompt = this.#buildPrompt(diff, existingTests, sourceFiles);

        // Route to HuggingFace Inference API or self-hosted GPU based on host value
        // Needed as Digital Ocean GPU droplet availability is inconsistent
        let testCode;
        if (this.host === 'huggingface') {
            testCode = await this.#callHuggingFace(prompt);
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
