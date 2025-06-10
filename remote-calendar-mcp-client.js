#!/usr/bin/env node

/**
 * Remote MCP Client for Google Calendar
 * 
 * This script connects your Claude Desktop to a remote Google Calendar MCP server.
 * Place this file anywhere on your computer and reference it in your Claude Desktop config.
 * 
 * Usage in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "google-calendar": {
 *       "command": "node",
 *       "args": ["/path/to/remote-calendar-mcp-client.js"],
 *       "env": {
 *         "GOOGLE_CLIENT_ID": "your_google_client_id",
 *         "GOOGLE_CLIENT_SECRET": "your_google_client_secret", 
 *         "GOOGLE_REFRESH_TOKEN": "your_google_refresh_token",
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

class RemoteCalendarMCPClient {
    constructor() {
        this.serverUrl = process.env.MCP_SERVER_URL || 'https://mcp-bridge-service-production.up.railway.app';
        this.googleClientId = process.env.GOOGLE_CLIENT_ID;
        this.googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
        this.googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
        
        // Validate required credentials
        const missing = [];
        if (!this.googleClientId) missing.push('GOOGLE_CLIENT_ID');
        if (!this.googleClientSecret) missing.push('GOOGLE_CLIENT_SECRET');
        if (!this.googleRefreshToken) missing.push('GOOGLE_REFRESH_TOKEN');
        
        if (missing.length > 0) {
            console.error('❌ Missing required environment variables:');
            missing.forEach(var_ => console.error(`   - ${var_}`));
            console.error('\\nAdd them to your Claude Desktop config:');
            console.error('\"GOOGLE_CLIENT_ID\": \"your_client_id\"');
            console.error('\"GOOGLE_CLIENT_SECRET\": \"your_client_secret\"');
            console.error('\"GOOGLE_REFRESH_TOKEN\": \"your_refresh_token\"');
            process.exit(1);
        }
        
        this.server = new Server({
            name: 'remote-calendar-mcp-client',
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
            
            const url = new URL('/mcp/calendar', this.serverUrl);
            
            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody),
                    'X-Google-Client-Id': this.googleClientId,
                    'X-Google-Client-Secret': this.googleClientSecret,
                    'X-Google-Refresh-Token': this.googleRefreshToken
                }
            };
            
            const req = https.request(url, options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        if (response.error) {
                            reject(new Error(response.error.message || 'Remote server error'));
                        } else {
                            resolve(response);
                        }
                    } catch (error) {
                        reject(new Error(`Failed to parse response: ${error.message}`));
                    }
                });
            });
            
            req.on('error', reject);
            req.write(requestBody);
            req.end();
        });
    }
    
    async run() {
        console.error('📅 Remote Google Calendar MCP Client starting...');
        console.error(`📡 Connecting to: ${this.serverUrl}`);
        console.error(`🔑 Using Google Client ID: ${this.googleClientId.substring(0, 12)}...`);
        
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        
        console.error('✅ Remote Google Calendar MCP Client connected and ready!');
    }
}

// Handle process errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Start the client
const client = new RemoteCalendarMCPClient();
client.run().catch(console.error);

module.exports = RemoteCalendarMCPClient;
