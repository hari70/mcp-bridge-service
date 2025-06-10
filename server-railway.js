// Railway-optimized MCP Bridge Service
// Connects to HTTP-based MCP servers instead of spawning local processes
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

class HTTPMCPClient {
    constructor(name, baseUrl, authToken = null) {
        this.name = name;
        this.baseUrl = baseUrl;
        this.authToken = authToken;
        this.connected = false;
        this.tools = [];
    }

    async connect() {
        try {
            console.log(`Testing connection to ${this.name}...`);
            
            // Test with actual API endpoints instead of health checks
            if (this.name === 'strava') {
                // Test Strava connection by checking if we can make an API call
                this.connected = !!process.env.STRAVA_ACCESS_TOKEN;
                if (this.connected) {
                    console.log(`✅ Connected to ${this.name} (token configured)`);
                } else {
                    console.log(`❌ ${this.name}: STRAVA_ACCESS_TOKEN not configured`);
                }
            } else if (this.name === 'google-calendar') {
                // Test Google Calendar connection by checking credentials
                const hasCredentials = !!(process.env.GOOGLE_CLIENT_ID && 
                                         process.env.GOOGLE_CLIENT_SECRET && 
                                         process.env.GOOGLE_REFRESH_TOKEN);
                this.connected = hasCredentials;
                if (this.connected) {
                    console.log(`✅ Connected to ${this.name} (credentials configured)`);
                } else {
                    console.log(`❌ ${this.name}: Google credentials not configured`);
                }
            } else {
                this.connected = false;
            }
            
            if (this.connected) {
                this.tools = this.getAvailableTools();
            }
            
            return this.connected;
        } catch (error) {
            console.error(`❌ Failed to connect to ${this.name}:`, error.message);
            this.connected = false;
            return false;
        }
    }

    getAvailableTools() {
        if (this.name === 'strava') {
            return [
                { name: 'get_athlete_profile' },
                { name: 'get_athlete_activities' },
                { name: 'get_activity_details' },
                { name: 'get_athlete_stats' }
            ];
        } else if (this.name === 'google-calendar') {
            return [
                { name: 'list_gcal_calendars' },
                { name: 'list_gcal_events' },
                { name: 'fetch_gcal_event' },
                { name: 'search_gcal_events' },
                { name: 'create_gcal_event' },
                { name: 'update_gcal_event' },
                { name: 'delete_gcal_event' },
                { name: 'find_free_time' }
            ];
        }
        return [];
    }

    async makeRequest(endpoint, options = {}) {
        return new Promise((resolve, reject) => {
            const url = `${this.baseUrl}${endpoint}`;
            const protocol = url.startsWith('https:') ? https : http;
            
            const reqOptions = {
                method: options.method || 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            };

            // Add auth token for calendar
            if (this.authToken) {
                reqOptions.headers['Authorization'] = `Bearer ${this.authToken}`;
            }

            const req = protocol.request(url, reqOptions, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);
                        resolve(jsonData);
                    } catch (error) {
                        resolve({ error: 'Invalid JSON response', data });
                    }
                });
            });

            req.on('error', reject);

            if (options.body) {
                req.write(JSON.stringify(options.body));
            }

            req.end();
        });
    }

    async callTool(toolName, parameters = {}) {
        if (!this.connected) {
            throw new Error(`${this.name} MCP server not connected`);
        }

        if (this.name === 'strava') {
            return await this.callStravaAPI(toolName, parameters);
        } else if (this.name === 'google-calendar') {
            return await this.callCalendarAPI(toolName, parameters);
        }

        throw new Error(`Unknown MCP server: ${this.name}`);
    }

    async callStravaAPI(toolName, parameters) {
        // Direct Strava API calls using environment variables
        const accessToken = process.env.STRAVA_ACCESS_TOKEN;
        if (!accessToken) {
            throw new Error('STRAVA_ACCESS_TOKEN not configured');
        }

        const baseUrl = 'https://www.strava.com/api/v3';
        let endpoint = '';
        let queryParams = '';

        switch (toolName) {
            case 'get_athlete_profile':
                endpoint = '/athlete';
                break;
            case 'get_athlete_activities':
                endpoint = '/athlete/activities';
                const params = new URLSearchParams();
                if (parameters.before) params.append('before', parameters.before);
                if (parameters.after) params.append('after', parameters.after);
                if (parameters.page) params.append('page', parameters.page);
                if (parameters.per_page) params.append('per_page', parameters.per_page);
                queryParams = params.toString() ? '?' + params.toString() : '';
                break;
            case 'get_activity_details':
                endpoint = `/activities/${parameters.activity_id}`;
                break;
            case 'get_athlete_stats':
                // Get athlete ID first if not provided
                if (!parameters.athlete_id) {
                    const athlete = await this.callStravaAPI('get_athlete_profile', {});
                    parameters.athlete_id = athlete.id;
                }
                endpoint = `/athletes/${parameters.athlete_id}/stats`;
                break;
            default:
                throw new Error(`Unknown Strava tool: ${toolName}`);
        }

        return new Promise((resolve, reject) => {
            const url = `${baseUrl}${endpoint}${queryParams}`;
            
            https.request(url, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);
                        
                        if (res.statusCode >= 400) {
                            reject(new Error(`Strava API error: ${res.statusCode} ${jsonData.message || 'Unknown error'}`));
                        } else {
                            // Format response to match MCP format
                            resolve({
                                content: [{
                                    type: 'text',
                                    text: JSON.stringify(jsonData, null, 2)
                                }]
                            });
                        }
                    } catch (error) {
                        reject(new Error(`Failed to parse Strava response: ${error.message}`));
                    }
                });
            }).on('error', reject).end();
        });
    }

    async callCalendarAPI(toolName, parameters) {
        // Use Google Calendar API directly with OAuth
        const { OAuth2Client } = require('google-auth-library');
        const { google } = require('googleapis');

        const oauth2Client = new OAuth2Client(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET
        );

        oauth2Client.setCredentials({
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN
        });

        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

        try {
            switch (toolName) {
                case 'list-calendars':
                    const calendars = await calendar.calendarList.list();
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(calendars.data.items || [], null, 2)
                        }]
                    };

                case 'list-events':
                    const events = await calendar.events.list({
                        calendarId: parameters.calendarId || 'primary',
                        timeMin: parameters.timeMin,
                        timeMax: parameters.timeMax,
                        maxResults: parameters.maxResults || 10,
                        singleEvents: true,
                        orderBy: 'startTime'
                    });
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(events.data.items || [], null, 2)
                        }]
                    };

                case 'create-event':
                    const event = {
                        summary: parameters.summary,
                        description: parameters.description,
                        location: parameters.location,
                        start: {
                            dateTime: parameters.start,
                            timeZone: parameters.timeZone
                        },
                        end: {
                            dateTime: parameters.end,
                            timeZone: parameters.timeZone
                        }
                    };
                    
                    const createdEvent = await calendar.events.insert({
                        calendarId: parameters.calendarId || 'primary',
                        requestBody: event
                    });
                    
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(createdEvent.data, null, 2)
                        }]
                    };

                default:
                    throw new Error(`Unknown Calendar tool: ${toolName}`);
            }
        } catch (error) {
            throw new Error(`Google Calendar API error: ${error.message}`);
        }
    }
}

class MCPBridgeService {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 3001;
        this.mcpClients = new Map();
        this.apiKeys = new Set();
        this.claudeApiKey = process.env.CLAUDE_API_KEY;
        this.lastQueryResult = null;
        this.initialized = false;
        
        this.setupMiddleware();
        this.setupRoutes();
    }

    async initialize() {
        if (this.initialized) return;
        
        try {
            await this.initializeMCPClients();
            this.initialized = true;
            console.log('✅ MCP Bridge Service initialization complete');
        } catch (error) {
            console.error('❌ MCP Bridge Service initialization failed:', error);
            this.initialized = false;
        }
    }

    setupMiddleware() {
        this.app.use(cors({
            origin: '*',
            credentials: true
        }));

        this.app.use(express.json());
        
        this.app.use('/api', (req, res, next) => {
            const apiKey = req.headers['x-api-key'] || req.query.apiKey;
            
            if (!apiKey) {
                const tempKey = 'temp_' + Math.random().toString(36).substring(7);
                req.apiKey = tempKey;
            } else {
                this.apiKeys.add(apiKey);
                req.apiKey = apiKey;
            }
            
            next();
        });

        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
            next();
        });
    }

    setupRoutes() {
        // Root endpoint for Railway health check
        this.app.get('/', (req, res) => {
            res.json({ 
                service: 'MCP Bridge Service',
                status: 'healthy', 
                timestamp: new Date().toISOString(),
                version: '1.0.0',
                mcpServers: Array.from(this.mcpClients.keys())
            });
        });

        // Health check
        this.app.get('/health', (req, res) => {
            const serverStatus = {};
            for (const [name, client] of this.mcpClients) {
                serverStatus[name] = {
                    connected: client.connected,
                    tools: client.tools.map(t => t.name)
                };
            }
            
            res.json({ 
                status: 'healthy', 
                timestamp: new Date().toISOString(),
                mcpServers: serverStatus,
                environment: 'railway'
            });
        });

        // Strava endpoints
        this.app.get('/api/strava/activities', async (req, res) => {
            try {
                const { limit = 10 } = req.query;
                const result = await this.callMCPFunction('strava', 'get_athlete_activities', {
                    per_page: parseInt(limit)
                });
                
                let activities = this.parseStravaResponse(result);
                res.json(activities);
            } catch (error) {
                console.error('Strava activities error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/strava/profile', async (req, res) => {
            try {
                const result = await this.callMCPFunction('strava', 'get_athlete_profile', {});
                const profile = this.parseStravaResponse(result);
                res.json(profile);
            } catch (error) {
                console.error('Strava profile error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/strava/stats', async (req, res) => {
            try {
                const result = await this.callMCPFunction('strava', 'get_athlete_stats', {});
                const stats = this.parseStravaResponse(result);
                res.json(stats);
            } catch (error) {
                console.error('Strava stats error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Calendar endpoints
        this.app.get('/api/calendar/events', async (req, res) => {
            try {
                const { timeframe = 'week' } = req.query;
                const result = await this.callMCPFunction('google-calendar', 'list-events', {
                    calendarId: 'primary',
                    timeMin: this.getTimeframeStart(timeframe),
                    timeMax: this.getTimeframeEnd(timeframe)
                });
                
                const events = this.parseCalendarResponse(result);
                res.json(events);
            } catch (error) {
                console.error('Calendar events error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/calendar/calendars', async (req, res) => {
            try {
                const result = await this.callMCPFunction('google-calendar', 'list-calendars', {});
                const calendars = this.parseCalendarResponse(result);
                res.json(calendars);
            } catch (error) {
                console.error('Calendar list error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/calendar/test', async (req, res) => {
            try {
                const result = await this.callMCPFunction('google-calendar', 'list-calendars', {});
                res.json({ 
                    success: true, 
                    message: 'Calendar connection working!',
                    data: result 
                });
            } catch (error) {
                console.error('Calendar test failed:', error);
                res.status(500).json({ 
                    success: false, 
                    error: error.message
                });
            }
        });

        // Chat endpoint
        this.app.post('/api/chat', async (req, res) => {
            try {
                const { message } = req.body;
                const response = await this.processVoiceCommand(message);
                
                res.json({
                    response: response.text,
                    data: response.data || null,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error('Chat error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Add MCP Protocol endpoints for multi-tenant access
        this.addMCPProtocolEndpoints();
    }

    addMCPProtocolEndpoints() {
        // Strava MCP Server Endpoint
        this.app.post('/mcp/strava', async (req, res) => {
            try {
                const { jsonrpc, id, method, params } = req.body;
                
                // Validate MCP request format
                if (jsonrpc !== '2.0') {
                    return res.status(400).json({
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32602, message: 'Invalid JSON-RPC version' }
                    });
                }
                
                // Get user's Strava token from headers
                const stravaToken = req.headers['x-strava-token'];
                if (!stravaToken && method !== 'initialize' && method !== 'tools/list') {
                    return res.status(401).json({
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32001, message: 'Missing Strava access token in X-Strava-Token header' }
                    });
                }
                
                let result;
                
                switch (method) {
                    case 'initialize':
                        result = {
                            protocolVersion: '2024-11-05',
                            capabilities: { tools: {} },
                            serverInfo: { name: 'remote-strava-mcp-server', version: '1.0.0' }
                        };
                        break;
                        
                    case 'tools/list':
                        result = {
                            tools: [
                                {
                                    name: 'get_athlete_profile',
                                    description: 'Get the authenticated athlete\'s profile information',
                                    inputSchema: { type: 'object', properties: {} }
                                },
                                {
                                    name: 'get_athlete_activities',
                                    description: 'Get the authenticated athlete\'s activities',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            before: { type: 'integer', description: 'Unix timestamp to get activities before' },
                                            after: { type: 'integer', description: 'Unix timestamp to get activities after' },
                                            page: { type: 'integer', description: 'Page number (default: 1)' },
                                            per_page: { type: 'integer', description: 'Number of activities per page (default: 30, max: 200)' }
                                        }
                                    }
                                },
                                {
                                    name: 'get_activity_details',
                                    description: 'Get detailed information about a specific activity',
                                    inputSchema: {
                                        type: 'object',
                                        properties: { activity_id: { type: 'string', description: 'The ID of the activity' } },
                                        required: ['activity_id']
                                    }
                                },
                                {
                                    name: 'get_athlete_stats',
                                    description: 'Get the authenticated athlete\'s statistics',
                                    inputSchema: {
                                        type: 'object',
                                        properties: { athlete_id: { type: 'string', description: 'The ID of the athlete (use current athlete if not provided)' } }
                                    }
                                }
                            ]
                        };
                        break;
                        
                    case 'tools/call':
                        const { name, arguments: args } = params;
                        result = await this.callStravaToolWithUserToken(name, args || {}, stravaToken);
                        break;
                        
                    default:
                        return res.status(400).json({
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32601, message: `Method not found: ${method}` }
                        });
                }
                
                res.json({ jsonrpc: '2.0', id, result });
                
            } catch (error) {
                console.error('Strava MCP error:', error);
                res.status(500).json({
                    jsonrpc: '2.0',
                    id: req.body?.id,
                    error: { code: -32603, message: error.message }
                });
            }
        });
        
        // Google Calendar MCP Server Endpoint
        this.app.post('/mcp/calendar', async (req, res) => {
            try {
                const { jsonrpc, id, method, params } = req.body;
                
                if (jsonrpc !== '2.0') {
                    return res.status(400).json({
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32602, message: 'Invalid JSON-RPC version' }
                    });
                }
                
                const googleClientId = req.headers['x-google-client-id'];
                const googleClientSecret = req.headers['x-google-client-secret'];
                const googleRefreshToken = req.headers['x-google-refresh-token'];
                
                if (!googleClientId || !googleClientSecret || !googleRefreshToken) {
                    if (method !== 'initialize' && method !== 'tools/list') {
                        return res.status(401).json({
                            jsonrpc: '2.0',
                            id,
                            error: { 
                                code: -32001, 
                                message: 'Missing Google credentials in headers: X-Google-Client-Id, X-Google-Client-Secret, X-Google-Refresh-Token' 
                            }
                        });
                    }
                }
                
                let result;
                
                switch (method) {
                    case 'initialize':
                        result = {
                            protocolVersion: '2024-11-05',
                            capabilities: { tools: {} },
                            serverInfo: { name: 'remote-google-calendar-mcp-server', version: '1.0.0' }
                        };
                        break;
                        
                    case 'tools/list':
                        result = {
                            tools: [
                                {
                                    name: 'list_gcal_calendars',
                                    description: 'List all available calendars in Google Calendar',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            page_token: { type: 'string', description: 'Token for pagination' }
                                        }
                                    }
                                },
                                {
                                    name: 'list_gcal_events',
                                    description: 'This tool lists or searches events from a specific Google Calendar',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            calendar_id: { type: 'string', description: 'Always supply this field explicitly. Use the default of \'primary\' unless the user tells you have a good reason to use a specific calendar', default: 'primary' },
                                            max_results: { type: 'integer', description: 'Maximum number of events returned per calendar', default: 25 },
                                            page_token: { type: 'string', description: 'Token specifying which result page to return' },
                                            query: { type: 'string', description: 'Free text search terms to find events' },
                                            time_max: { type: 'string', description: 'Upper bound (exclusive) for an event\'s start time to filter by', format: 'date-time' },
                                            time_min: { type: 'string', description: 'Lower bound (exclusive) for an event\'s end time to filter by', format: 'date-time' },
                                            time_zone: { type: 'string', description: 'Time zone used in the response, formatted as an IANA Time Zone Database name' }
                                        },
                                        required: ['calendar_id']
                                    }
                                },
                                {
                                    name: 'fetch_gcal_event',
                                    description: 'Retrieve a specific event from a Google calendar',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            calendar_id: { type: 'string', description: 'The ID of the calendar containing the event' },
                                            event_id: { type: 'string', description: 'The ID of the event to retrieve' }
                                        },
                                        required: ['calendar_id', 'event_id']
                                    }
                                },
                                {
                                    name: 'search_gcal_events',
                                    description: 'Search for events in a calendar by text query',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            calendar_id: { type: 'string', description: 'ID of the calendar to search events in (use \'primary\' for the main calendar)' },
                                            query: { type: 'string', description: 'Free text search query' },
                                            time_max: { type: 'string', description: 'End time boundary in ISO format with timezone required', format: 'date-time' },
                                            time_min: { type: 'string', description: 'Start time boundary in ISO format with timezone required', format: 'date-time' }
                                        },
                                        required: ['calendar_id', 'query']
                                    }
                                },
                                {
                                    name: 'create_gcal_event',
                                    description: 'Create a new calendar event',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            calendar_id: { type: 'string', description: 'ID of the calendar to create the event in (use \'primary\' for the main calendar)' },
                                            summary: { type: 'string', description: 'Title of the event' },
                                            description: { type: 'string', description: 'Description/notes for the event (optional)' },
                                            start: { type: 'string', description: 'Start time in ISO format with timezone required', format: 'date-time' },
                                            end: { type: 'string', description: 'End time in ISO format with timezone required', format: 'date-time' },
                                            time_zone: { type: 'string', description: 'Timezone of the event start/end times' },
                                            location: { type: 'string', description: 'Location of the event (optional)' },
                                            attendees: { type: 'array', description: 'List of attendee email addresses (optional)', items: { type: 'object', properties: { email: { type: 'string', format: 'email' } } } }
                                        },
                                        required: ['calendar_id', 'summary', 'start', 'end', 'time_zone']
                                    }
                                },
                                {
                                    name: 'update_gcal_event',
                                    description: 'Update an existing calendar event',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            calendar_id: { type: 'string', description: 'ID of the calendar containing the event' },
                                            event_id: { type: 'string', description: 'ID of the event to update' },
                                            summary: { type: 'string', description: 'New title for the event (optional)' },
                                            description: { type: 'string', description: 'New description for the event (optional)' },
                                            start: { type: 'string', description: 'New start time in ISO format with timezone required', format: 'date-time' },
                                            end: { type: 'string', description: 'New end time in ISO format with timezone required', format: 'date-time' },
                                            time_zone: { type: 'string', description: 'Timezone for the start/end times' },
                                            location: { type: 'string', description: 'New location for the event (optional)' },
                                            attendees: { type: 'array', description: 'New list of attendee email addresses (optional)', items: { type: 'object', properties: { email: { type: 'string', format: 'email' } } } }
                                        },
                                        required: ['calendar_id', 'event_id', 'time_zone']
                                    }
                                },
                                {
                                    name: 'delete_gcal_event',
                                    description: 'Delete a calendar event',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            calendar_id: { type: 'string', description: 'ID of the calendar containing the event' },
                                            event_id: { type: 'string', description: 'ID of the event to delete' }
                                        },
                                        required: ['calendar_id', 'event_id']
                                    }
                                },
                                {
                                    name: 'find_free_time',
                                    description: 'Use this tool to find free time periods across a list of calendars',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            calendar_ids: { type: 'array', description: 'List of calendar IDs to analyze for free time intervals', items: { type: 'string' } },
                                            time_min: { type: 'string', description: 'Lower bound (exclusive) for an event\'s end time to filter by' },
                                            time_max: { type: 'string', description: 'Upper bound (exclusive) for an event\'s start time to filter by' },
                                            time_zone: { type: 'string', description: 'Time zone used in the response, formatted as an IANA Time Zone Database name' }
                                        },
                                        required: ['calendar_ids', 'time_max', 'time_min']
                                    }
                                }
                            ]
                        };
                        break;
                        
                    case 'tools/call':
                        const { name, arguments: args } = params;
                        result = await this.callCalendarToolWithUserCredentials(
                            name, 
                            args || {}, 
                            googleClientId, 
                            googleClientSecret, 
                            googleRefreshToken
                        );
                        break;
                        
                    default:
                        return res.status(400).json({
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32601, message: `Method not found: ${method}` }
                        });
                }
                
                res.json({ jsonrpc: '2.0', id, result });
                
            } catch (error) {
                console.error('Calendar MCP error:', error);
                res.status(500).json({
                    jsonrpc: '2.0',
                    id: req.body?.id,
                    error: { code: -32603, message: error.message }
                });
            }
        });
    }

    // Strava API calls with user's token
    async callStravaToolWithUserToken(toolName, parameters, userToken) {
        const baseUrl = 'https://www.strava.com/api/v3';
        let endpoint = '';
        let queryParams = '';
        
        switch (toolName) {
            case 'get_athlete_profile':
                endpoint = '/athlete';
                break;
            case 'get_athlete_activities':
                endpoint = '/athlete/activities';
                const params = new URLSearchParams();
                if (parameters.before) params.append('before', parameters.before);
                if (parameters.after) params.append('after', parameters.after);
                if (parameters.page) params.append('page', parameters.page);
                if (parameters.per_page) params.append('per_page', parameters.per_page);
                queryParams = params.toString() ? '?' + params.toString() : '';
                break;
            case 'get_activity_details':
                endpoint = `/activities/${parameters.activity_id}`;
                break;
            case 'get_athlete_stats':
                if (!parameters.athlete_id) {
                    const athlete = await this.callStravaToolWithUserToken('get_athlete_profile', {}, userToken);
                    const athleteData = JSON.parse(athlete.content[0].text);
                    parameters.athlete_id = athleteData.id;
                }
                endpoint = `/athletes/${parameters.athlete_id}/stats`;
                break;
            default:
                throw new Error(`Unknown Strava tool: ${toolName}`);
        }
        
        return new Promise((resolve, reject) => {
            const url = `${baseUrl}${endpoint}${queryParams}`;
            
            https.request(url, {
                headers: {
                    'Authorization': `Bearer ${userToken}`,
                    'Accept': 'application/json'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const jsonData = JSON.parse(data);
                        
                        if (res.statusCode >= 400) {
                            reject(new Error(`Strava API error: ${res.statusCode} ${jsonData.message || 'Unknown error'}`));
                        } else {
                            resolve({
                                content: [{
                                    type: 'text',
                                    text: JSON.stringify(jsonData, null, 2)
                                }]
                            });
                        }
                    } catch (error) {
                        reject(new Error(`Failed to parse Strava response: ${error.message}`));
                    }
                });
            }).on('error', reject).end();
        });
    }

    // Google Calendar API calls with user's credentials
    async callCalendarToolWithUserCredentials(toolName, parameters, clientId, clientSecret, refreshToken) {
        const { OAuth2Client } = require('google-auth-library');
        const { google } = require('googleapis');
        
        const oauth2Client = new OAuth2Client(clientId, clientSecret);
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        
        try {
            switch (toolName) {
                case 'list_gcal_calendars':
                    const calendars = await calendar.calendarList.list({
                        pageToken: parameters.page_token
                    });
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(calendars.data.items || [], null, 2)
                        }]
                    };
                    
                case 'list_gcal_events':
                    const events = await calendar.events.list({
                        calendarId: parameters.calendar_id || 'primary',
                        timeMin: parameters.time_min,
                        timeMax: parameters.time_max,
                        maxResults: parameters.max_results || 25,
                        pageToken: parameters.page_token,
                        q: parameters.query,
                        timeZone: parameters.time_zone,
                        singleEvents: true,
                        orderBy: 'startTime'
                    });
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(events.data.items || [], null, 2)
                        }]
                    };
                    
                case 'fetch_gcal_event':
                    const event = await calendar.events.get({
                        calendarId: parameters.calendar_id,
                        eventId: parameters.event_id
                    });
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(event.data, null, 2)
                        }]
                    };
                    
                case 'search_gcal_events':
                    const searchEvents = await calendar.events.list({
                        calendarId: parameters.calendar_id,
                        q: parameters.query,
                        timeMin: parameters.time_min,
                        timeMax: parameters.time_max,
                        singleEvents: true,
                        orderBy: 'startTime'
                    });
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(searchEvents.data.items || [], null, 2)
                        }]
                    };
                    
                case 'create_gcal_event':
                    const newEvent = {
                        summary: parameters.summary,
                        description: parameters.description,
                        location: parameters.location,
                        start: {
                            dateTime: parameters.start,
                            timeZone: parameters.time_zone
                        },
                        end: {
                            dateTime: parameters.end,
                            timeZone: parameters.time_zone
                        }
                    };
                    
                    if (parameters.attendees) {
                        newEvent.attendees = parameters.attendees;
                    }
                    
                    const createdEvent = await calendar.events.insert({
                        calendarId: parameters.calendar_id || 'primary',
                        requestBody: newEvent
                    });
                    
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(createdEvent.data, null, 2)
                        }]
                    };
                    
                case 'update_gcal_event':
                    const updateEvent = {};
                    
                    if (parameters.summary) updateEvent.summary = parameters.summary;
                    if (parameters.description) updateEvent.description = parameters.description;
                    if (parameters.location) updateEvent.location = parameters.location;
                    if (parameters.attendees) updateEvent.attendees = parameters.attendees;
                    
                    if (parameters.start) {
                        updateEvent.start = {
                            dateTime: parameters.start,
                            timeZone: parameters.time_zone
                        };
                    }
                    
                    if (parameters.end) {
                        updateEvent.end = {
                            dateTime: parameters.end,
                            timeZone: parameters.time_zone
                        };
                    }
                    
                    const updatedEvent = await calendar.events.update({
                        calendarId: parameters.calendar_id,
                        eventId: parameters.event_id,
                        requestBody: updateEvent
                    });
                    
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(updatedEvent.data, null, 2)
                        }]
                    };
                    
                case 'delete_gcal_event':
                    await calendar.events.delete({
                        calendarId: parameters.calendar_id,
                        eventId: parameters.event_id
                    });
                    
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({ success: true, message: 'Event deleted successfully' }, null, 2)
                        }]
                    };
                    
                case 'find_free_time':
                    const freeBusyQuery = {
                        timeMin: parameters.time_min,
                        timeMax: parameters.time_max,
                        timeZone: parameters.time_zone,
                        items: parameters.calendar_ids.map(id => ({ id }))
                    };
                    
                    const freeBusy = await calendar.freebusy.query({
                        requestBody: freeBusyQuery
                    });
                    
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(freeBusy.data, null, 2)
                        }]
                    };
                    
                default:
                    throw new Error(`Unknown Calendar tool: ${toolName}`);
            }
        } catch (error) {
            throw new Error(`Google Calendar API error: ${error.message}`);
        }
    }

    async initializeMCPClients() {
        console.log('🔧 Initializing Railway MCP clients...');
        
        // Initialize Strava client
        const stravaClient = new HTTPMCPClient('strava', 'https://www.strava.com/api/v3');
        await stravaClient.connect();
        this.mcpClients.set('strava', stravaClient);

        // Initialize Google Calendar client  
        const calendarClient = new HTTPMCPClient('google-calendar', 'https://www.googleapis.com/calendar/v3');
        await calendarClient.connect();
        this.mcpClients.set('google-calendar', calendarClient);

        const connectedCount = Array.from(this.mcpClients.values()).filter(c => c.connected).length;
        console.log(`✅ Successfully initialized ${connectedCount}/${this.mcpClients.size} MCP clients`);
    }

    parseStravaResponse(result) {
        if (result && result.content && Array.isArray(result.content)) {
            const contentText = result.content.find(c => c.type === 'text')?.text;
            if (contentText) {
                try {
                    return JSON.parse(contentText);
                } catch (error) {
                    console.error('Failed to parse Strava response:', error);
                    return result;
                }
            }
        }
        return result;
    }

    parseCalendarResponse(result) {
        if (result && result.content && Array.isArray(result.content)) {
            const contentText = result.content.find(c => c.type === 'text')?.text;
            if (contentText) {
                try {
                    return JSON.parse(contentText);
                } catch (error) {
                    console.error('Failed to parse Calendar response:', error);
                    return result;
                }
            }
        }
        return result;
    }

    async processVoiceCommand(message) {
        const lowerMessage = message.toLowerCase();
        
        try {
            if (lowerMessage.includes('workout') || lowerMessage.includes('activity') || 
                lowerMessage.includes('strava') || lowerMessage.includes('bike') || 
                lowerMessage.includes('run') || lowerMessage.includes('miles')) {
                
                const result = await this.callMCPFunction('strava', 'get_athlete_activities', { per_page: 10 });
                const activities = this.parseStravaResponse(result);
                
                if (Array.isArray(activities) && activities.length > 0) {
                    const totalDistance = activities.reduce((sum, a) => sum + (a.distance || 0), 0);
                    const distanceMiles = (totalDistance * 0.000621371).toFixed(1);
                    
                    return {
                        text: `You did ${activities.length} recent activities covering ${distanceMiles} miles total.`,
                        data: activities
                    };
                } else {
                    return {
                        text: "I didn't find any recent activities. Make sure your Strava account is connected.",
                        data: null
                    };
                }
            }
            
            if (lowerMessage.includes('calendar') || lowerMessage.includes('meeting') || 
                lowerMessage.includes('schedule')) {
                
                const result = await this.callMCPFunction('google-calendar', 'list-events', {
                    calendarId: 'primary',
                    timeMin: this.getTimeframeStart('today'),
                    timeMax: this.getTimeframeEnd('today')
                });
                
                const events = this.parseCalendarResponse(result);
                
                if (Array.isArray(events) && events.length > 0) {
                    const eventList = events.slice(0, 3).map(e => e.summary || 'Untitled').join(', ');
                    return {
                        text: `You have ${events.length} events today: ${eventList}`,
                        data: events
                    };
                } else {
                    return {
                        text: "You have no events scheduled for today.",
                        data: []
                    };
                }
            }
            
            return {
                text: "I can help you with your Strava activities and Google Calendar events. Try asking about your recent workouts or today's schedule!",
                data: null
            };
            
        } catch (error) {
            console.error('Command processing error:', error);
            return {
                text: `Sorry, I encountered an error: ${error.message}`,
                data: null
            };
        }
    }

    async callMCPFunction(serverName, functionName, parameters) {
        const client = this.mcpClients.get(serverName);
        if (!client) {
            throw new Error(`MCP server '${serverName}' not found`);
        }

        if (!client.connected) {
            throw new Error(`MCP server '${serverName}' not connected`);
        }

        return await client.callTool(functionName, parameters);
    }

    getTimeframeStart(timeframe) {
        const now = new Date();
        let startDate;
        
        switch (timeframe) {
            case 'today':
                startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
                break;
            case 'tomorrow':
                startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
                break;
            case 'week':
                startDate = new Date(now);
                startDate.setDate(now.getDate() - now.getDay());
                startDate.setHours(0, 0, 0, 0);
                break;
            default:
                startDate = new Date(now);
                startDate.setHours(0, 0, 0, 0);
        }
        
        return startDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    getTimeframeEnd(timeframe) {
        const now = new Date();
        let endDate;
        
        switch (timeframe) {
            case 'today':
                endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
                break;
            case 'tomorrow':
                endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 59, 59);
                break;
            case 'week':
                endDate = new Date(now);
                endDate.setDate(now.getDate() + (6 - now.getDay()));
                endDate.setHours(23, 59, 59, 0);
                break;
            default:
                endDate = new Date(now);
                endDate.setDate(now.getDate() + 1);
                endDate.setHours(23, 59, 59, 0);
        }
        
        return endDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    async start() {
        // Initialize MCP clients first
        await this.initialize();
        
        const server = this.app.listen(this.port, '0.0.0.0', () => {
            console.log(`🚀 Railway MCP Bridge Service running on port ${this.port}`);
            console.log(`📊 Health check: /health`);
            console.log(`🔧 Connected MCP Servers: ${Array.from(this.mcpClients.keys()).join(', ')}`);
            
            // Log connection status for each server
            for (const [name, client] of this.mcpClients) {
                const status = client.connected ? '✅ Connected' : '❌ Disconnected';
                const toolCount = client.tools ? client.tools.length : 0;
                console.log(`   - ${name}: ${status} (${toolCount} tools)`);
            }
        });

        // Handle server errors
        server.on('error', (error) => {
            console.error('❌ Server error:', error);
            if (error.code === 'EADDRINUSE') {
                console.error(`Port ${this.port} is already in use`);
                process.exit(1);
            }
        });

        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            console.error('❌ Uncaught Exception:', error);
            // Don't exit immediately - let Railway handle it
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
            // Don't exit immediately - let Railway handle it
        });

        // Graceful shutdown
        process.on('SIGTERM', () => {
            console.log('📦 Received SIGTERM, shutting down gracefully...');
            server.close(() => {
                console.log('👋 Server closed');
                process.exit(0);
            });
        });

        process.on('SIGINT', () => {
            console.log('📦 Received SIGINT, shutting down gracefully...');
            server.close(() => {
                console.log('👋 Server closed');
                process.exit(0);
            });
        });

        return server;
    }
}

// Start the service
async function main() {
    try {
        const service = new MCPBridgeService();
        await service.start();
    } catch (error) {
        console.error('❌ Failed to start MCP Bridge Service:', error);
        process.exit(1);
    }
}

// Run the service
main();

module.exports = MCPBridgeService;
