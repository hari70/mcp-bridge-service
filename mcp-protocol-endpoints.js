// Multi-tenant MCP Server - Railway endpoints that accept user credentials
// Extends the existing server with proper MCP protocol endpoints

// Add MCP protocol endpoints to existing server
function addMCPProtocolEndpoints(app) {
    
    // Strava MCP Server Endpoint
    app.post('/mcp/strava', async (req, res) => {
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
                        capabilities: {
                            tools: {}
                        },
                        serverInfo: {
                            name: 'remote-strava-mcp-server',
                            version: '1.0.0'
                        }
                    };
                    break;
                    
                case 'tools/list':
                    result = {
                        tools: [
                            {
                                name: 'get_athlete_profile',
                                description: 'Get the authenticated athlete\'s profile information',
                                inputSchema: {
                                    type: 'object',
                                    properties: {}
                                }
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
                                    properties: {
                                        activity_id: { type: 'string', description: 'The ID of the activity' }
                                    },
                                    required: ['activity_id']
                                }
                            },
                            {
                                name: 'get_athlete_stats',
                                description: 'Get the authenticated athlete\'s statistics',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        athlete_id: { type: 'string', description: 'The ID of the athlete (use current athlete if not provided)' }
                                    }
                                }
                            }
                        ]
                    };
                    break;
                    
                case 'tools/call':
                    const { name, arguments: args } = params;
                    result = await callStravaToolWithUserToken(name, args || {}, stravaToken);
                    break;
                    
                default:
                    return res.status(400).json({
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32601, message: `Method not found: ${method}` }
                    });
            }
            
            res.json({
                jsonrpc: '2.0',
                id,
                result
            });
            
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
    app.post('/mcp/calendar', async (req, res) => {
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
            
            // Get user's Google credentials from headers
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
                        capabilities: {
                            tools: {}
                        },
                        serverInfo: {
                            name: 'remote-google-calendar-mcp-server',
                            version: '1.0.0'
                        }
                    };
                    break;
                    
                case 'tools/list':
                    result = {
                        tools: [
                            {
                                name: 'list-calendars',
                                description: 'List all calendars for the authenticated user',
                                inputSchema: {
                                    type: 'object',
                                    properties: {}
                                }
                            },
                            {
                                name: 'list-events',
                                description: 'List events from a specific calendar',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        calendarId: { type: 'string', description: 'Calendar ID (default: primary)' },
                                        timeMin: { type: 'string', description: 'Lower bound (exclusive) for an event\'s end time' },
                                        timeMax: { type: 'string', description: 'Upper bound (exclusive) for an event\'s start time' },
                                        maxResults: { type: 'integer', description: 'Maximum number of events returned (default: 10)' }
                                    }
                                }
                            },
                            {
                                name: 'create-event',
                                description: 'Create a new event',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        calendarId: { type: 'string', description: 'Calendar ID (default: primary)' },
                                        summary: { type: 'string', description: 'Event title' },
                                        description: { type: 'string', description: 'Event description' },
                                        start: { type: 'string', description: 'Start time (ISO 8601)' },
                                        end: { type: 'string', description: 'End time (ISO 8601)' },
                                        timeZone: { type: 'string', description: 'Time zone' },
                                        location: { type: 'string', description: 'Event location' }
                                    },
                                    required: ['summary', 'start', 'end', 'timeZone']
                                }
                            }
                        ]
                    };
                    break;
                    
                case 'tools/call':
                    const { name, arguments: args } = params;
                    result = await callCalendarToolWithUserCredentials(
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
            
            res.json({
                jsonrpc: '2.0',
                id,
                result
            });
            
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
async function callStravaToolWithUserToken(toolName, parameters, userToken) {
    const https = require('https');
    
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
                // Get athlete ID first
                const athlete = await callStravaToolWithUserToken('get_athlete_profile', {}, userToken);
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
async function callCalendarToolWithUserCredentials(toolName, parameters, clientId, clientSecret, refreshToken) {
    const { OAuth2Client } = require('google-auth-library');
    const { google } = require('googleapis');
    
    const oauth2Client = new OAuth2Client(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    
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

module.exports = { addMCPProtocolEndpoints };
