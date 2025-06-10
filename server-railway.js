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
                { name: 'list-calendars' },
                { name: 'list-events' },
                { name: 'create-event' },
                { name: 'search-events' },
                { name: 'delete-event' }
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
        
        this.setupMiddleware();
        this.setupRoutes();
        this.initializeMCPClients();
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

    start() {
        this.app.listen(this.port, () => {
            console.log(`🚀 Railway MCP Bridge Service running on port ${this.port}`);
            console.log(`📊 Health check: /health`);
            console.log(`🔧 Connected MCP Servers: ${Array.from(this.mcpClients.keys()).join(', ')}`);
        });
    }
}

// Start the service
const service = new MCPBridgeService();
service.start();

module.exports = MCPBridgeService;
