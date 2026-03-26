import Anthropic from '@anthropic-ai/sdk';
import * as core from '@actions/core';
import { MAX_TOOL_ROUNDS } from '../utils/constants.js';
import { RequestService } from '../services/RequestService.js';

export class ClaudeProvider {
    // Claude provider manages all calls to the Anthropic API
    // including MCP tool use loops
    constructor(apiKey, modelId) {
        // Initialise anthropic client with api key and set model id
        this.client = new Anthropic({ apiKey });
        this.modelId = modelId;
    }

    // Call Claude API with optional MCP tool use
    async call(prompt, mcpService) {
        // Log the model being used for debugging
        core.info(`Calling Claude API with model: ${this.modelId}`);

        // Build the request parameters
        const requestParameters = {
            model: this.modelId,
            max_tokens: 16384,
            messages: [{ role: 'user', content: prompt }],
        };

        // Add MCP tools if available
        if (mcpService?.hasTools()) {
            requestParameters.tools = mcpService.getToolsForClaude();
            core.info(`Including ${requestParameters.tools.length} MCP tool(s) in Claude request`);
        }

        // Initial API call with retry in place
        let response = await RequestService.withRetry(() => this.client.messages.create(requestParameters));

        // Runs the MCP tool loop if Claude wants to use tools
        // for additional context
        const messages = [...requestParameters.messages];

        // Initialise rounds counter to 0
        // prevents loops endless
        let rounds = 0;

        // Keep looping as long as Claude wants to use tools and max rounds limit has not been reached
        while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
            // Increment the roudns counter
            rounds++;

            // Add assistant message with tool use content
            messages.push({ role: 'assistant', content: response.content });

            // Run each tool call via MCP
            // Calling internal private function
            const toolResults = await this.#processToolCalls(response.content, mcpService);

            // Add tool results to the messages array to send back to Claude for the next round
            messages.push({ role: 'user', content: toolResults });

            // Next API call with retry logic, sending the full message history including tool results so Claude can decide next steps
            response = await RequestService.withRetry(() =>
                this.client.messages.create({ ...requestParameters, messages })
            );
        }

        // If Claude is still trying to use tools after hitting the limit,
        // tell it to stop exploring and write the code
        if (response.stop_reason === 'tool_use' && rounds >= MAX_TOOL_ROUNDS) {
            response = await this.#exitToolCallLoop(response, messages, requestParameters, mcpService);
        }

        // Warn if Claude has hit the token limit before completion
        if (response.stop_reason === 'max_tokens') {
            core.warning('Claude hit max_tokens limit — response may be incomplete.');
        }

        // Extract text from the final response
        const textBlocks = response.content.filter((b) => b.type === 'text');
        return textBlocks.map((b) => b.text).join('\n');
    }

    // Private function that processes tool use blocks from a Claude response and executes each via MCP
    async #processToolCalls(content, mcpService) {
        // Start with empty array to collect the results
        const toolResults = [];

        // Loop over each content block in the response
        for (const block of content) {
            // If it is a too use block, use mcp service to call the tool
            // get the result and push to tool results array to send back to
            // Claude in the next message
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

        // Finally return array of tool results
        return toolResults;
    }

    // When Claude hits the configured tool call limit, send a final message
    // telling it to stop exploring and output the code
    async #exitToolCallLoop(response, messages, requestParameters, mcpService) {
        // Log for debugging
        core.warning(`Hit tool call limit (${MAX_TOOL_ROUNDS} rounds) — asking Claude to output code now`);

        // Add the final tool use content to the messages array before sending the nudge to Claude
        messages.push({ role: 'assistant', content: response.content });

        // Process remaining tool calls so Claude gets the results
        const finalToolResults = await this.#processToolCalls(response.content, mcpService);

        // Remove tools from the request parameters for the final call
        // so that Claude can't use tools again
        messages.push({
            role: 'user',
            content: [
                ...finalToolResults,
                {
                    type: 'text',
                    text: 'You have done enough exploration. Now output ONLY the final Playwright test code as TypeScript in a ```typescript code block. No more tool calls.',
                },
            ],
        });

        // Make final API call with retry logic
        return RequestService.withRetry(() =>
            this.client.messages.create({
                ...requestParameters,
                tools: undefined,
                messages,
            })
        );
    }
}
