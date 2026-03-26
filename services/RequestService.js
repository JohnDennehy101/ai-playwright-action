import axios from 'axios';
import * as core from '@actions/core';
import { MAX_RETRIES, INITIAL_RETRY_DELAY_MS, RETRYABLE_STATUS_CODES } from '../utils/constants.js';

// This service covers HTTP requests directly made by the action
export class RequestService {
    // Function to wrap API calls with retry logic
    static async withRetry(fn) {
        // Loop retries with exponential backoff for any temporary errors
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Attempt to execute the provided function (e.g. an API call)
                return await fn();
            } catch (err) {
                // Check if error is retryable based on status code
                const status = err?.status || err?.response?.status;
                const isRetryable = RETRYABLE_STATUS_CODES.includes(status);

                // If error is not retryable or all retries have already been made throw the error
                if (!isRetryable || attempt === MAX_RETRIES) {
                    throw err;
                }

                // Exponential backoff for retries
                const delayMilliSeconds = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);

                // Log the retry attempt
                core.warning(
                    `API returned ${status}, retrying in ${delayMilliSeconds / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`
                );

                // Delay before the next retry attempt using a promise to create the delay
                await new Promise((r) => setTimeout(r, delayMilliSeconds));
            }
        }
    }

    // Makes an authenticated POST request with retry logic in place
    static async post(url, body, { apiKey, timeout = 120000 } = {}) {
        // All requests will have JSON content type
        const headers = {
            'Content-Type': 'application/json',
        };

        // Add authorisation header if API key provided
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        // Call the request with retry logic using the withRetry function defined above
        return RequestService.withRetry(async () => {
            const response = await axios.post(url, body, { headers, timeout });
            return response;
        });
    }
}
