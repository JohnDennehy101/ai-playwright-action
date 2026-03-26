import * as core from '@actions/core';
import { RequestService } from '../services/RequestService.js';

export class HuggingFaceProvider {
    // HuggingFace provider manages API calls to the HuggingFace Inference API
    // via the router endpoint
    constructor(apiKey, modelId) {
        // Store the API key and model ID for use in API calls
        this.apiKey = apiKey;
        this.modelId = modelId;
    }

    // Calls the HuggingFace Inference API
    async call(prompt) {
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
}
