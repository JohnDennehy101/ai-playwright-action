import { ClaudeProvider } from './ClaudeProvider.js';
import { HuggingFaceProvider } from './HuggingFaceProvider.js';
import { SelfHostedProvider } from './SelfHostedProvider.js';

// Factory that initialises correct provider based on host value passed
export class ProviderFactory {
    static create(host, apiKey, modelId) {
        switch (host) {
            case 'claude':
                return new ClaudeProvider(apiKey, modelId);
            case 'huggingface':
                return new HuggingFaceProvider(apiKey, modelId);
            default:
                // Any other host value is treated as a self-hosted GPU server address
                // In this example, Digital Ocean GPU droplets was this scenario when availability
                // wasn't an issue
                return new SelfHostedProvider(host, apiKey, modelId);
        }
    }
}
