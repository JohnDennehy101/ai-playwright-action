import * as core from '@actions/core';
import { RequestService } from '../services/RequestService.js';

export class SelfHostedProvider {
    // Self hosted provider handles calls to any custom GPU server
    // running an inference service that can accept API requests
    constructor(host, apiKey, modelId) {
        // Store the host, API key and model ID for use in API calls
        this.host = host;
        this.apiKey = apiKey;
        this.modelId = modelId;
    }

    // Call the GPU server
    async call(prompt) {
        // Log for debugging
        core.info(`Calling self-hosted LLM at http://${this.host}:8000/generate-test with model: ${this.modelId}`);

        // Use the RequestService with retry logic to make the request
        const response = await RequestService.post(
            `http://${this.host}:8000/generate-test`,
            { model_id: this.modelId, prompt },
            { apiKey: this.apiKey, timeout: 120000 }
        );

        // Checks for different possible fields in response for flexibility and returns the generated test code
        return response.data.generated_test || response.data.output || response.data.text || '';
    }
}
