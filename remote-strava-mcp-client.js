#!/usr/bin/env node

/**
 * Remote MCP Client for Strava
 * 
 * This script connects your Claude Desktop to a remote Strava MCP server.
 * Place this file anywhere on your computer and reference it in your Claude Desktop config.
 * 
 * Usage in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "strava": {
 *       "command": "node",
 *       "args": ["/path/to/remote-strava-mcp-client.js"],
 *       "env": {
 *         "STRAVA_ACCESS_TOKEN": "your_strava_access_token_here",
 *         "MCP_SERVER_URL": "https://mcp-bridge-service-production.up.railway.app"
 *       }
 *     }
 *   }
 * }
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { 
    CallToolRequestSchema, 
    ListToolsRequestSchema 
} = require('@modelcontextprotocol/sdk/types.js');
const https = require('https');

class RemoteStravaMCPClient {
    constructor() {
        this.serverUrl = process.env.MCP_SERVER_URL || 'https://mcp-bridge-service-production.up.railway.app';
        this.stravaToken = process.env.STRAVA_ACCESS_TOKEN;
        
        if (!this.stravaToken) {
            console.error('❌ STRAVA_ACCESS_TOKEN environment variable is required');
            console.error('Add it to your Claude Desktop config:');
            console.error('\"STRAVA_ACCESS_TOKEN\": \"your_token_here\"');
            process.exit(1);
        }
        
        this.server = new Server({
            name: 'remote-strava-mcp-client',
            version: '1.0.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        
        this.setupHandlers();
    }
    
    setupHandlers() {
        // Forward tools/list requests to remote server
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            try {
                const response = await this.makeRemoteRequest('tools/list', {});
                return response.result;
            } catch (error) {
                console.error('Failed to list tools:', error);
                return { tools: [] };
            }
        });
        
        // Forward tools/call requests to remote server
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                const response = await this.makeRemoteRequest('tools/call', request.params);
                return response.result;
            } catch (error) {
                console.error('Failed to call tool:', error);
                return {
                    content: [{
                        type: 'text',
                        text: `Error: ${error.message}`
                    }]
                };
            }
        });
    }
    
    makeRemoteRequest(method, params) {
        return new Promise((resolve, reject) => {
            const requestBody = JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method,
                params
            });
            
            const url = new URL('/mcp/strava', this.serverUrl);
            
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                    'X-Strava-Token': this.stravaToken
                }
            };
            
            const req = https.request(url, options, (res) => {
                let data = '';\n                res.on('data', chunk => data += chunk);\n                res.on('end', () => {\n                    try {\n                        const response = JSON.parse(data);\n                        if (response.error) {\n                            reject(new Error(response.error.message || 'Remote server error'));\n                        } else {\n                            resolve(response);\n                        }\n                    } catch (error) {\n                        reject(new Error(`Failed to parse response: ${error.message}`));\n                    }\n                });\n            });\n            \n            req.on('error', reject);\n            req.write(requestBody);\n            req.end();\n        });\n    }\n    \n    async run() {\n        console.error('🚴 Remote Strava MCP Client starting...');\n        console.error(`📡 Connecting to: ${this.serverUrl}`);\n        console.error(`🔑 Using Strava token: ${this.stravaToken.substring(0, 8)}...`);\n        \n        const transport = new StdioServerTransport();\n        await this.server.connect(transport);\n        \n        console.error('✅ Remote Strava MCP Client connected and ready!');\n    }\n}\n\n// Handle process errors\nprocess.on('uncaughtException', (error) => {\n    console.error('Uncaught exception:', error);\n    process.exit(1);\n});\n\nprocess.on('unhandledRejection', (reason, promise) => {\n    console.error('Unhandled rejection at:', promise, 'reason:', reason);\n    process.exit(1);\n});\n\n// Start the client\nconst client = new RemoteStravaMCPClient();\nclient.run().catch(console.error);\n\nmodule.exports = RemoteStravaMCPClient;", "oldText": ""}]