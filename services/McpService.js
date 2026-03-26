import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as core from '@actions/core';

export class McpService {
    // This service handles connecting to Model Context Protocol (MCP)
    // services if configured
    constructor() {
        // This handles mcp server connections
        this.connections = new Map();
        // Keeps track of available tools from connected MCP servers
        this.tools = new Map();
        // Log of all tool calls made during this session
        // For auditing
        this.toolCallLog = [];
    }

    // Function that connects to configured MCP servers and discovers their available tools
    async connect(serversConfig) {
        // If no servers configured, return
        if (!serversConfig || Object.keys(serversConfig).length === 0) {
            // Log for debugging
            core.info('No MCP servers configured');
            return;
        }

        // Loop over each configured server
        // Attempt to connect and discover tools
        for (const [name, config] of Object.entries(serversConfig)) {
            try {
                // Log for debugging
                core.info(`Connecting to MCP server: ${name}`);

                // Creates an MCP client with the provided config
                const transport = new StdioClientTransport({
                    command: config.command,
                    args: config.args || [],
                    env: { ...process.env, ...(config.env || {}) },
                });

                const client = new Client({ name: `ai-playwright-${name}`, version: '1.0.0' });

                // Tries to connect to the MCP server
                await client.connect(transport);

                // Tries to discover tools from this server
                const { tools } = await client.listTools();

                // Loop over discovered tools
                for (const tool of tools) {
                    // Store tool in the tools map
                    this.tools.set(tool.name, { serverName: name, schema: tool });
                    // Log for debugging
                    core.info(`Discovered tool: ${tool.name}`);
                }

                // Store the client and transport for this server in the connections map
                this.connections.set(name, { client, transport });

                // Log successful connection
                core.info(`Connected to ${name} — ${tools.length} tool(s) available`);
            } catch (err) {
                // Log connection errors but continue with other servers if one fails
                core.warning(`Failed to connect to MCP server "${name}": ${err.message}`);
            }
        }
    }

    // Get tools formatted for the Anthropic API
    getToolsForClaude() {
        // This maps tools to format expected by Anthropic API
        return Array.from(this.tools.values()).map(({ schema }) => ({
            name: schema.name,
            description: schema.description || '',
            input_schema: schema.inputSchema,
        }));
    }

    // Get tools formatted for OpenAI-compatible APIs (HuggingFace)
    getToolsForOpenAI() {
        // This maps tools to format expected by OpenAI API
        // Hugging Face's implementation of OpenAI spec needs a slightly different format for tools than Anthropic API,
        // both helper functions are provided
        return Array.from(this.tools.values()).map(({ schema }) => ({
            type: 'function',
            function: {
                name: schema.name,
                description: schema.description || '',
                parameters: schema.inputSchema,
            },
        }));
    }

    // Run a tool call via the appropriate MCP server
    // Logs the call details for visibility
    async callTool(toolName, args) {
        // Try get the tool
        const entry = this.tools.get(toolName);

        // If tool not found, throw an error
        if (!entry) {
            throw new Error(`Unknown MCP tool: ${toolName}`);
        }

        // Log the tool call details for debugging and visibility
        const startTime = Date.now();
        core.info(`[MCP] Calling tool: ${toolName}`);
        core.info(`[MCP] Server: ${entry.serverName}`);
        core.info(`[MCP] Args: ${JSON.stringify(args)}`);

        // Call the tool via the MCP client and measure duration
        const { client } = this.connections.get(entry.serverName);
        const result = await client.callTool({ name: toolName, arguments: args });
        const durationMilliseconds = Date.now() - startTime;

        // Get output from tool result
        let output;

        // If it is an array, get text from each and join as a string
        if (result.content && Array.isArray(result.content)) {
            output = result.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join('\n');
        } else {
            // Otherwise, use single block of text if provided like that
            output = JSON.stringify(result);
        }

        // Log the result summary
        const outputPreview = output.length > 500 ? output.substring(0, 500) + '...' : output;

        // Log the tool call result for debugging and visibility
        core.info(`[MCP] Result (${output.length} chars, ${durationMilliseconds}ms): ${outputPreview}`);

        // Track the call for the summary at the end of the run
        this.toolCallLog.push({
            tool: toolName,
            server: entry.serverName,
            args,
            outputLength: output.length,
            durationMilliseconds,
        });

        // Finally return output from tool call
        return output;
    }

    // Check if any tools are available
    hasTools() {
        return this.tools.size > 0;
    }

    // Get a summary of all tool calls made during the session
    // Used for including in PR review comments for visibility
    getToolCallSummary() {
        if (this.toolCallLog.length === 0) {
            return '';
        }

        let summary = `**MCP Tool Usage** (${this.toolCallLog.length} call(s)):\n\n`;
        summary += '| # | Tool | Server | Duration | Output Size |\n';
        summary += '|---|------|--------|----------|-------------|\n';

        // Loop over tool calls that have been stored and output in a markdown table format
        for (let i = 0; i < this.toolCallLog.length; i++) {
            const call = this.toolCallLog[i];
            summary += `| ${i + 1} | \`${call.tool}\` | ${call.server} | ${call.durationMilliseconds}ms | ${call.outputLength} chars |\n`;
        }

        // Return the formatted summary
        return summary;
    }

    // Disconnect all MCP servers (to cleanup after the run)
    async disconnect() {
        // Loop over all connections and disconnect
        for (const [name, { client }] of this.connections) {
            try {
                // Try to close the client connection gracefully
                await client.close();

                // Log for debugging
                core.info(`Disconnected MCP server: ${name}`);
            } catch {
                // Silently handle disconnect errors as it doesn't impact the action
            }
        }
        // Clear connections and tools after disconnecting
        this.connections.clear();
        this.tools.clear();
    }
}
