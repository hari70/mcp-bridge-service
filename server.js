// MCP Bridge Service - Updated with proper MCP client implementation
// Connects VoiceAgent mobile app to local MCP servers
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class MCPClient {
    constructor(serverConfig) {
        this.config = serverConfig;
        this.process = null;
        this.connected = false;
        this.requestId = 1;
        this.pendingRequests = new Map();
        this.tools = [];
    }

    async connect() {
        return new Promise((resolve, reject) => {
            try {
                console.log(`Connecting to MCP server with command: ${this.config.command} ${this.config.args.join(' ')}`);
                
                // Spawn the MCP server process
                this.process = spawn(this.config.command, this.config.args, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...process.env, ...this.config.env }
                });

                let buffer = '';
                let connectionTimeout;
                
                // Set a connection timeout
                connectionTimeout = setTimeout(() => {
                    console.error(`Connection timeout for MCP server`);
                    this.cleanup();
                    reject(new Error('Connection timeout'));
                }, 60000); // 60 second timeout for initial connection
                
                this.process.stdout.on('data', (data) => {
                    buffer += data.toString();
                    
                    // Process complete JSON messages
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep incomplete line in buffer
                    
                    for (const line of lines) {
                        if (line.trim()) {
                            try {
                                const message = JSON.parse(line);
                                this.handleMessage(message);
                            } catch (error) {
                                console.error('Failed to parse MCP message:', error, line);
                            }
                        }
                    }
                });

                this.process.stderr.on('data', (data) => {
                    console.error(`MCP server stderr: ${data}`);
                });

                this.process.on('close', (code) => {
                    console.log(`MCP server exited with code ${code}`);
                    this.connected = false;
                    clearTimeout(connectionTimeout);
                });

                this.process.on('error', (error) => {
                    console.error('MCP server error:', error);
                    clearTimeout(connectionTimeout);
                    reject(error);
                });

                // Initialize the MCP connection
                this.sendRequest('initialize', {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: {}
                    },
                    clientInfo: {
                        name: 'voice-agent-bridge',
                        version: '1.0.0'
                    }
                }).then(async (result) => {
                    clearTimeout(connectionTimeout);
                    console.log('MCP server initialized:', result);
                    
                    // List available tools
                    try {
                        const toolsResult = await this.sendRequest('tools/list', {});
                        this.tools = toolsResult.tools || [];
                        console.log(`Found ${this.tools.length} tools:`, this.tools.map(t => t.name));
                    } catch (error) {
                        console.error('Failed to list tools:', error);
                    }
                    
                    this.connected = true;
                    resolve();
                }).catch((error) => {
                    clearTimeout(connectionTimeout);
                    reject(error);
                });

            } catch (error) {
                reject(error);
            }
        });
    }

    cleanup() {
        if (this.process) {
            this.process.kill('SIGTERM');
            setTimeout(() => {
                if (this.process && !this.process.killed) {
                    this.process.kill('SIGKILL');
                }
            }, 5000);
        }
    }

    handleMessage(message) {
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve, reject } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);
            
            if (message.error) {
                reject(new Error(message.error.message || 'MCP error'));
            } else {
                resolve(message.result);
            }
        }
    }

    sendRequest(method, params = {}) {
        return new Promise((resolve, reject) => {
            if (!this.process) {
                reject(new Error('MCP server not connected'));
                return;
            }

            const id = this.requestId++;
            const request = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            this.pendingRequests.set(id, { resolve, reject });
            
            // Set timeout for request (reduced from 30s to 15s)
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Request timeout'));
                }
            }, 15000);

            try {
                console.log(`Sending MCP request: ${method}`);
                this.process.stdin.write(JSON.stringify(request) + '\n');
            } catch (error) {
                this.pendingRequests.delete(id);
                reject(error);
            }
        });
    }

    async callTool(name, arguments_obj = {}) {
        if (!this.connected) {
            throw new Error('MCP server not connected');
        }

        return await this.sendRequest('tools/call', {
            name,
            arguments: arguments_obj
        });
    }

    getTools() {
        return this.tools;
    }

    disconnect() {
        if (this.process) {
            this.process.kill();
            this.process = null;
            this.connected = false;
        }
    }
}

class MCPBridgeService {
    constructor() {
        this.app = express();
        this.port = 3001;
        this.mcpClients = new Map();
        this.apiKeys = new Set();
        this.claudeApiKey = process.env.CLAUDE_API_KEY;
        this.lastQueryResult = null; // Store last query for follow-ups
        
        this.setupMiddleware();
        this.setupRoutes();
        this.loadConfiguration();
    }

    setupMiddleware() {
        // CORS for mobile app
        this.app.use(cors({
            origin: ['http://localhost:8080', 'http://127.0.0.1:8080', 'file://', '*'],
            credentials: true
        }));

        this.app.use(express.json());
        
        // API Key authentication (relaxed for development)
        this.app.use('/api', (req, res, next) => {
            const apiKey = req.headers['x-api-key'] || req.query.apiKey;
            
            // For development, allow requests without API key or generate one
            if (!apiKey) {
                const tempKey = 'temp_' + Math.random().toString(36).substring(7);
                req.apiKey = tempKey;
            } else if (!this.apiKeys.has(apiKey)) {
                // Auto-add new keys for development
                this.apiKeys.add(apiKey);
                req.apiKey = apiKey;
            } else {
                req.apiKey = apiKey;
            }
            
            next();
        });

        // Logging middleware
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
                    tools: client.getTools().map(t => t.name)
                };
            }
            
            res.json({ 
                status: 'healthy', 
                timestamp: new Date().toISOString(),
                mcpServers: serverStatus
            });
        });

        // Generate API key
        this.app.post('/generate-key', (req, res) => {
            const apiKey = 'va_' + crypto.randomBytes(16).toString('hex');
            this.apiKeys.add(apiKey);
            this.saveApiKeys();
            
            res.json({ apiKey });
        });

        // MCP Server discovery
        this.app.get('/api/servers', (req, res) => {
            const servers = [];
            for (const [name, client] of this.mcpClients) {
                servers.push({
                    name,
                    connected: client.connected,
                    tools: client.getTools()
                });
            }
            
            res.json({ servers });
        });

        // Direct MCP function calls
        this.app.post('/api/mcp/:serverName/:functionName', async (req, res) => {
            try {
                const { serverName, functionName } = req.params;
                const { parameters = {} } = req.body;
                
                const result = await this.callMCPFunction(serverName, functionName, parameters);
                res.json({ result });
            } catch (error) {
                console.error('MCP function call error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Strava endpoints
        this.app.get('/api/strava/activities', async (req, res) => {
            try {
                const { limit = 10 } = req.query;
                console.log(`Requesting ${limit} activities from Strava MCP...`);
                
                const result = await this.callMCPFunction('strava', 'get_athlete_activities', {
                    per_page: parseInt(limit)
                });
                
                console.log('Raw Strava MCP result:', JSON.stringify(result, null, 2));
                
                // Handle the response format from your custom MCP server
                let activities = result;
                if (result && result.content && Array.isArray(result.content)) {
                    // Your MCP server returns data in content array
                    const contentText = result.content.find(c => c.type === 'text')?.text;
                    if (contentText) {
                        try {
                            activities = JSON.parse(contentText);
                        } catch (parseError) {
                            console.error('Failed to parse MCP content:', parseError);
                            activities = result;
                        }
                    }
                }
                
                console.log('Processed activities:', JSON.stringify(activities?.slice?.(0, 2) || activities, null, 2));
                res.json(activities);
            } catch (error) {
                console.error('Strava activities error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/strava/profile', async (req, res) => {
            try {
                const result = await this.callMCPFunction('strava', 'get_athlete_profile', {});
                res.json(result);
            } catch (error) {
                console.error('Strava profile error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/strava/stats', async (req, res) => {
            try {
                const result = await this.callMCPFunction('strava', 'get_athlete_stats', {});
                res.json(result);
            } catch (error) {
                console.error('Strava stats error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Calendar endpoints
        this.app.get('/api/calendar/events', async (req, res) => {
            try {
                const { timeframe = 'week' } = req.query;
                console.log(`Fetching calendar events for timeframe: ${timeframe}`);
                console.log(`Time range: ${this.getTimeframeStart(timeframe)} to ${this.getTimeframeEnd(timeframe)}`);
                
                const result = await this.callMCPFunction('google-calendar', 'list-events', {
                    calendarId: 'primary',
                    timeMin: this.getTimeframeStart(timeframe),
                    timeMax: this.getTimeframeEnd(timeframe)
                });
                res.json(result);
            } catch (error) {
                console.error('Calendar events error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/calendar/calendars', async (req, res) => {
            try {
                console.log('Fetching calendar list...');
                const result = await this.callMCPFunction('google-calendar', 'list-calendars', {});
                res.json(result);
            } catch (error) {
                console.error('Calendar list error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Debug endpoint to test calendar connection
        this.app.get('/api/calendar/test', async (req, res) => {
            try {
                console.log('Testing calendar connection...');
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
                    error: error.message,
                    details: error.stack 
                });
            }
        });

        // Enhanced chat endpoint with actual MCP integration
        this.app.post('/api/chat', async (req, res) => {
            try {
                const { message, context = [] } = req.body;
                
                // Get structured data from MCP
                const mcpResponse = await this.processVoiceCommand(message);
                
                // Store the last query result for follow-up questions
                if (mcpResponse.summary) {
                    this.lastQueryResult = {
                        message: message,
                        response: mcpResponse,
                        timestamp: Date.now()
                    };
                }
                
                // Check if this is a follow-up question
                const isFollowUp = this.isFollowUpQuestion(message);
                let finalResponse = mcpResponse;
                
                if (isFollowUp && this.lastQueryResult) {
                    finalResponse = this.handleFollowUpQuestion(message, this.lastQueryResult);
                }
                
                // Use LLM to format the response nicely
                const formattedResponse = await this.formatResponseWithLLM(message, finalResponse);
                
                res.json({
                    response: formattedResponse,
                    data: finalResponse.data || null,
                    summary: finalResponse.summary || null,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error('Chat error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Weather endpoint
        this.app.get('/api/weather', async (req, res) => {
            try {
                const { location = 'current' } = req.query;
                const result = await this.callMCPFunction('Weather', 'get_weather', { location });
                res.json(result);
            } catch (error) {
                console.error('Weather error:', error);
                res.status(500).json({ error: error.message });
            }
        });
    }

    async formatResponseWithLLM(userMessage, mcpResponse) {
        // If no Claude API key, return enhanced response directly
        if (!this.claudeApiKey) {
            console.log('No Claude API key, returning basic response');
            return mcpResponse.text;
        }

        try {
            console.log('Formatting response with LLM...');
            console.log('User message:', userMessage);
            console.log('MCP response text:', mcpResponse.text);
            console.log('MCP summary:', JSON.stringify(mcpResponse.summary, null, 2));

            // If we have a proper structured response, use it directly
            if (mcpResponse.text && mcpResponse.summary) {
                console.log('Using structured response directly:', mcpResponse.text);
                return mcpResponse.text;
            }

            const systemPrompt = `You are a helpful AI assistant that formats data responses for a voice agent. 

User asked: "${userMessage}"

Raw data received: ${JSON.stringify(mcpResponse.data, null, 2)}

Please format this information in a natural, conversational way that would be good for a voice response. 
Keep it concise but informative. If it's fitness data, mention key metrics. If it's calendar data, mention important events and times.

Focus on the most relevant information and make it sound natural and friendly, as if you're talking to someone.

If there are events, mention the titles and times clearly. If there are workouts, mention the activity type and key stats.`;

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.claudeApiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: 'claude-3-haiku-20240307', // Using Haiku for speed
                    max_tokens: 300,
                    messages: [
                        { role: 'user', content: systemPrompt }
                    ]
                })
            });

            if (!response.ok) {
                console.error('Claude API error:', response.status, response.statusText);
                return mcpResponse.text || "I found some data but couldn't format it properly.";
            }

            const data = await response.json();
            const formattedText = data.content?.find(c => c.type === 'text')?.text;
            
            console.log('LLM formatted response:', formattedText);
            return formattedText || mcpResponse.text || "I couldn't process that request properly.";

        } catch (error) {
            console.error('LLM formatting error:', error);
            return mcpResponse.text || "I encountered an error processing your request.";
        }
    }

    async processVoiceCommand(message) {
        const lowerMessage = message.toLowerCase();
        
        try {
            // Strava-related commands
            if (lowerMessage.includes('workout') || lowerMessage.includes('exercise') || 
                lowerMessage.includes('activity') || lowerMessage.includes('run') || 
                lowerMessage.includes('bike') || lowerMessage.includes('cycle') || 
                lowerMessage.includes('strava') || lowerMessage.includes('miles') || 
                lowerMessage.includes('distance') || lowerMessage.includes('indoor')) {
                
                console.log('Processing Strava query:', message);
                
                // Determine what type of query this is
                let queryType = 'recent';
                let filterType = 'all';
                
                if (lowerMessage.includes('today')) {
                    queryType = 'today';
                } else if (lowerMessage.includes('week') || lowerMessage.includes('weekly')) {
                    queryType = 'week';
                } else if (lowerMessage.includes('month')) {
                    queryType = 'month';
                }
                
                if (lowerMessage.includes('indoor') || lowerMessage.includes('trainer') || lowerMessage.includes('virtual')) {
                    filterType = 'indoor';
                } else if (lowerMessage.includes('run') && !lowerMessage.includes('bike')) {
                    filterType = 'run';
                } else if (lowerMessage.includes('bike') || lowerMessage.includes('cycle') || lowerMessage.includes('ride')) {
                    filterType = 'bike';
                }
                
                // Get activities with appropriate timeframe
                let timeParams = { per_page: 30 };
                const now = new Date();
                
                if (queryType === 'today') {
                    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                    timeParams.after = Math.floor(startOfDay.getTime() / 1000);
                } else if (queryType === 'week') {
                    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    timeParams.after = Math.floor(weekAgo.getTime() / 1000);
                } else if (queryType === 'month') {
                    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    timeParams.after = Math.floor(monthAgo.getTime() / 1000);
                } else {
                    timeParams.per_page = 10; // Recent activities
                }
                
                const result = await this.callMCPFunction('strava', 'get_athlete_activities', timeParams);
                console.log('Strava activities result:', JSON.stringify(result, null, 2));
                
                // Parse the response properly
                let activities = [];
                if (result && result.content && Array.isArray(result.content)) {
                    const contentText = result.content.find(c => c.type === 'text')?.text;
                    if (contentText) {
                        try {
                            activities = JSON.parse(contentText);
                        } catch (parseError) {
                            console.error('Failed to parse activities JSON:', parseError);
                            return {
                                text: "I got your Strava data but couldn't parse it properly. Please try again.",
                                data: result
                            };
                        }
                    }
                } else if (Array.isArray(result)) {
                    activities = result;
                }
                
                console.log('Parsed activities count:', activities.length);
                
                if (!Array.isArray(activities) || activities.length === 0) {
                    return {
                        text: `I didn't find any activities for ${queryType === 'today' ? 'today' : queryType === 'week' ? 'this week' : 'recently'}. Make sure your Strava account is synced.`,
                        data: result
                    };
                }
                
                // Filter activities based on type
                let filteredActivities = activities;
                if (filterType === 'indoor') {
                    filteredActivities = activities.filter(a => 
                        a.type === 'VirtualRide' || 
                        (a.trainer === true) ||
                        (a.name && a.name.toLowerCase().includes('indoor'))
                    );
                } else if (filterType === 'bike') {
                    filteredActivities = activities.filter(a => 
                        a.type === 'Ride' || a.type === 'VirtualRide' || a.sport_type === 'Ride'
                    );
                } else if (filterType === 'run') {
                    filteredActivities = activities.filter(a => 
                        a.type === 'Run' || a.sport_type === 'Run'
                    );
                }
                
                console.log('Filtered activities count:', filteredActivities.length);
                
                if (filteredActivities.length === 0) {
                    const typeText = filterType === 'indoor' ? 'indoor cycling' : 
                                   filterType === 'bike' ? 'cycling' : 
                                   filterType === 'run' ? 'running' : 'workout';
                    const timeText = queryType === 'today' ? 'today' : 
                                   queryType === 'week' ? 'this week' : 
                                   queryType === 'month' ? 'this month' : 'recently';
                    
                    return {
                        text: `I didn't find any ${typeText} activities ${timeText}.`,
                        data: activities
                    };
                }
                
                // Calculate summary stats
                const totalDistance = filteredActivities.reduce((sum, a) => sum + (a.distance || 0), 0);
                const totalTime = filteredActivities.reduce((sum, a) => sum + (a.moving_time || 0), 0);
                const totalCalories = filteredActivities.reduce((sum, a) => sum + (a.calories || 0), 0);
                const avgWatts = filteredActivities.filter(a => a.average_watts).reduce((sum, a, i, arr) => sum + a.average_watts / arr.length, 0);
                
                // Convert units
                const distanceMiles = (totalDistance * 0.000621371).toFixed(1);
                const distanceKm = (totalDistance / 1000).toFixed(1);
                const timeHours = Math.floor(totalTime / 3600);
                const timeMinutes = Math.floor((totalTime % 3600) / 60);
                
                // Create response based on query
                let responseText = '';
                const timeText = queryType === 'today' ? 'today' : 
                               queryType === 'week' ? 'this week' : 
                               queryType === 'month' ? 'this month' : 'recently';
                const typeText = filterType === 'indoor' ? 'indoor cycling' : 
                               filterType === 'bike' ? 'cycling' : 
                               filterType === 'run' ? 'running' : 'workout';
                
                if (lowerMessage.includes('miles') || lowerMessage.includes('distance')) {
                    responseText = `You did ${distanceMiles} miles of ${typeText} ${timeText} across ${filteredActivities.length} activities.`;
                } else if (lowerMessage.includes('time') || lowerMessage.includes('duration')) {
                    responseText = `You spent ${timeHours}h ${timeMinutes}m on ${typeText} ${timeText} across ${filteredActivities.length} activities.`;
                } else {
                    // General summary
                    responseText = `${timeText.charAt(0).toUpperCase() + timeText.slice(1)} you did ${filteredActivities.length} ${typeText} activities: ${distanceMiles} miles, ${timeHours}h ${timeMinutes}m total`;
                    
                    if (avgWatts > 0) {
                        responseText += `, averaging ${Math.round(avgWatts)} watts`;
                    }
                    
                    if (totalCalories > 0) {
                        responseText += `, burning ${totalCalories} calories`;
                    }
                    
                    responseText += '.';
                }
                
                return {
                    text: responseText,
                    data: filteredActivities,
                    summary: {
                        count: filteredActivities.length,
                        distanceMiles: parseFloat(distanceMiles),
                        distanceKm: parseFloat(distanceKm),
                        timeMinutes: Math.floor(totalTime / 60),
                        avgWatts: Math.round(avgWatts),
                        calories: totalCalories,
                        queryType,
                        filterType
                    }
                };
            }
            
            // Calendar-related commands
            if (lowerMessage.includes('calendar') || lowerMessage.includes('meeting') || 
                lowerMessage.includes('appointment') || lowerMessage.includes('schedule')) {
                
                let timeframe = 'today';
                if (lowerMessage.includes('tomorrow')) {
                    timeframe = 'tomorrow';
                } else if (lowerMessage.includes('today')) {
                    timeframe = 'today';
                } else if (lowerMessage.includes('week')) {
                    timeframe = 'week';
                } else if (lowerMessage.includes('month')) {
                    timeframe = 'month';
                }
                
                const result = await this.callMCPFunction('google-calendar', 'list-events', {
                    calendarId: 'primary',
                    timeMin: this.getTimeframeStart(timeframe),
                    timeMax: this.getTimeframeEnd(timeframe)
                });
                
                console.log('Calendar events result:', JSON.stringify(result, null, 2));
                
                // Handle calendar response structure
                let events = [];
                if (Array.isArray(result)) {
                    events = result;
                } else if (result && Array.isArray(result.items)) {
                    events = result.items;
                } else if (result && Array.isArray(result.events)) {
                    events = result.events;
                } else if (result && result.content && Array.isArray(result.content)) {
                    events = result.content;
                }
                
                console.log('Parsed events array:', JSON.stringify(events.slice(0, 2), null, 2)); // Log first 2 events
                
                if (events.length > 0) {
                    const eventList = events.slice(0, 5).map(e => {
                        console.log('Processing event:', JSON.stringify(e, null, 2)); // Debug each event
                        const summary = e.summary || e.title || e.subject || e.name || 'Untitled event';
                        let startTime = '';
                        
                        // Handle different start time formats
                        if (e.start) {
                            const startDateTime = e.start.dateTime || e.start.date || e.start;
                            if (startDateTime) {
                                try {
                                    const timeStr = new Date(startDateTime).toLocaleTimeString('en-US', { 
                                        hour: 'numeric', 
                                        minute: '2-digit',
                                        hour12: true 
                                    });
                                    startTime = ` at ${timeStr}`;
                                } catch (error) {
                                    // If time parsing fails, leave startTime empty
                                }
                            }
                        }
                        
                        return `${summary}${startTime}`;
                    }).join(', ');
                    
                    const timeframeText = timeframe === 'tomorrow' ? 'tomorrow' : 
                                        timeframe === 'today' ? 'today' : 
                                        timeframe === 'week' ? 'this week' : 
                                        timeframe === 'month' ? 'this month' : timeframe;
                    
                    return {
                        text: `You have ${events.length} events ${timeframeText}: ${eventList}`,
                        data: events
                    };
                } else {
                    const timeframeText = timeframe === 'tomorrow' ? 'tomorrow' : 
                                        timeframe === 'today' ? 'today' : 
                                        timeframe === 'week' ? 'this week' : 
                                        timeframe === 'month' ? 'this month' : timeframe;
                    
                    return {
                        text: `You have no events scheduled ${timeframeText}.`,
                        data: result
                    };
                }
            }
            
            // Weather-related commands
            if (lowerMessage.includes('weather') || lowerMessage.includes('temperature')) {
                try {
                    const result = await this.callMCPFunction('Weather', 'get_weather', { location: 'current' });
                    console.log('Weather result:', JSON.stringify(result, null, 2));
                    
                    // Handle weather response structure
                    let weather = result;
                    if (result && result.data) {
                        weather = result.data;
                    }
                    
                    const description = weather.description || weather.weather || weather.current || 'Unable to get weather data';
                    return {
                        text: `Current weather: ${description}`,
                        data: weather
                    };
                } catch (error) {
                    console.error('Weather error:', error);
                    return {
                        text: "Sorry, I couldn't get weather information right now.",
                        data: null
                    };
                }
            }
            
            // Default response
            return {
                text: "I can help you with your calendar, Strava activities, weather, and more. Try asking about your recent workouts or today's schedule!",
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

    async loadConfiguration() {
        try {
            // Load MCP server configurations and connect to them
            await this.discoverAndConnectMCPServers();
            
            // Load saved API keys
            await this.loadApiKeys();
            
            console.log('Bridge service configuration loaded');
        } catch (error) {
            console.error('Configuration load error:', error);
        }
    }

    async discoverAndConnectMCPServers() {
        // Read your Claude Desktop MCP configuration
        const configPaths = [
            path.join(process.env.HOME, '.config', 'claude', 'claude_desktop_config.json'),
            path.join(process.env.HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        ];

        for (const configPath of configPaths) {
            try {
                const configData = await fs.readFile(configPath, 'utf8');
                const config = JSON.parse(configData);
                
                if (config.mcpServers) {
                    console.log(`Found ${Object.keys(config.mcpServers).length} MCP servers in config`);
                    
                    // Connect to each MCP server with retry logic
                    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
                        await this.connectWithRetry(name, serverConfig);
                    }
                    break;
                }
            } catch (error) {
                // Config file doesn't exist or is invalid, continue
                console.log(`Config file not found at ${configPath}`);
            }
        }

        console.log(`Successfully connected to ${this.mcpClients.size} MCP servers`);
    }

    async connectWithRetry(name, serverConfig, maxRetries = 2) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`Connecting to MCP server: ${name} (attempt ${attempt}/${maxRetries})`);
                const client = new MCPClient(serverConfig);
                
                // Add timeout for the entire connection process
                const connectPromise = client.connect();
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Connection timeout')), 60000)
                );
                
                await Promise.race([connectPromise, timeoutPromise]);
                
                this.mcpClients.set(name, client);
                console.log(`✅ Connected to ${name}`);
                return; // Success, exit retry loop
                
            } catch (error) {
                console.error(`❌ Failed to connect to ${name} (attempt ${attempt}): ${error.message}`);
                
                if (attempt === maxRetries) {
                    console.error(`🚫 Giving up on ${name} after ${maxRetries} attempts`);
                    
                    // For calendar server, provide specific troubleshooting
                    if (name === 'google-calendar') {
                        console.error(`
📋 Google Calendar troubleshooting:
1. Check if OAuth tokens are valid: cd /Users/harit/AI\\ Projects/google-calendar-mcp && cat .gcp-saved-tokens.json
2. Re-authenticate: cd /Users/harit/AI\\ Projects/google-calendar-mcp && npm run auth  
3. Restart manually: cd /Users/harit/AI\\ Projects/google-calendar-mcp && node build/index.js
                        `);
                    }
                } else {
                    // Wait before retry
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        }
    }

    isFollowUpQuestion(message) {
        const followUpPhrases = [
            'what about', 'how about', 'what was', 'how much', 'how many',
            'tell me more', 'details', 'breakdown', 'also', 'and',
            'yesterday', 'last week', 'last month', 'compared to',
            'average', 'total', 'best', 'worst', 'longest', 'shortest'
        ];
        
        const lowerMessage = message.toLowerCase();
        const hasFollowUpPhrase = followUpPhrases.some(phrase => lowerMessage.includes(phrase));
        const hasLastResult = !!this.lastQueryResult;
        const isRecent = this.lastQueryResult && (Date.now() - this.lastQueryResult.timestamp) < 300000;
        
        console.log('Follow-up check:', {
            message: lowerMessage,
            hasFollowUpPhrase,
            hasLastResult,
            isRecent,
            lastResultAge: this.lastQueryResult ? Date.now() - this.lastQueryResult.timestamp : 'none'
        });
        
        return hasFollowUpPhrase && hasLastResult && isRecent;
    }

    handleFollowUpQuestion(message, lastResult) {
        const lowerMessage = message.toLowerCase();
        const summary = lastResult.response.summary;
        const activities = lastResult.response.data;
        
        if (!summary || !activities) {
            return {
                text: "I don't have enough data from the previous query to answer that. Please ask a new question.",
                data: null
            };
        }
        
        // Handle different types of follow-up questions
        if (lowerMessage.includes('yesterday')) {
            return this.getYesterdayStats(activities);
        } else if (lowerMessage.includes('last week') || lowerMessage.includes('week')) {
            return this.getWeekStats(activities, summary);
        } else if (lowerMessage.includes('average')) {
            return this.getAverageStats(summary, activities);
        } else if (lowerMessage.includes('best') || lowerMessage.includes('longest')) {
            return this.getBestStats(activities);
        } else if (lowerMessage.includes('total') || lowerMessage.includes('how much') || lowerMessage.includes('how many')) {
            return this.getTotalStats(summary);
        } else {
            // Default: provide more details
            return this.getDetailedStats(summary, activities);
        }
    }

    getYesterdayStats(activities) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStart = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
        const yesterdayEnd = new Date(yesterdayStart.getTime() + 24 * 60 * 60 * 1000);
        
        const yesterdayActivities = activities.filter(a => {
            const activityDate = new Date(a.start_date);
            return activityDate >= yesterdayStart && activityDate < yesterdayEnd;
        });
        
        if (yesterdayActivities.length === 0) {
            return {
                text: "You didn't have any activities yesterday.",
                data: yesterdayActivities
            };
        }
        
        const totalDistance = yesterdayActivities.reduce((sum, a) => sum + (a.distance || 0), 0);
        const distanceMiles = (totalDistance * 0.000621371).toFixed(1);
        
        return {
            text: `Yesterday you did ${yesterdayActivities.length} activities covering ${distanceMiles} miles.`,
            data: yesterdayActivities
        };
    }

    getWeekStats(activities, summary) {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        
        const weekActivities = activities.filter(a => {
            const activityDate = new Date(a.start_date);
            return activityDate >= weekAgo;
        });
        
        if (weekActivities.length === 0) {
            return {
                text: "You didn't have any activities this week.",
                data: weekActivities
            };
        }
        
        const totalDistance = weekActivities.reduce((sum, a) => sum + (a.distance || 0), 0);
        const totalTime = weekActivities.reduce((sum, a) => sum + (a.moving_time || 0), 0);
        const distanceMiles = (totalDistance * 0.000621371).toFixed(1);
        const timeHours = Math.floor(totalTime / 3600);
        const timeMinutes = Math.floor((totalTime % 3600) / 60);
        
        return {
            text: `This week you did ${weekActivities.length} activities: ${distanceMiles} miles in ${timeHours}h ${timeMinutes}m total.`,
            data: weekActivities,
            summary: {
                count: weekActivities.length,
                distanceMiles: parseFloat(distanceMiles),
                timeMinutes: Math.floor(totalTime / 60)
            }
        };
    }

    getAverageStats(summary, activities) {
        const avgDistance = summary.distanceMiles / summary.count;
        const avgTime = summary.timeMinutes / summary.count;
        
        return {
            text: `On average, each activity was ${avgDistance.toFixed(1)} miles and ${Math.round(avgTime)} minutes long${summary.avgWatts > 0 ? ` at ${summary.avgWatts} watts` : ''}.`,
            data: { avgDistance, avgTime, avgWatts: summary.avgWatts }
        };
    }

    getBestStats(activities) {
        if (!activities.length) {
            return { text: "No activities to analyze.", data: null };
        }
        
        const longest = activities.reduce((max, a) => a.distance > max.distance ? a : max);
        const fastest = activities.reduce((max, a) => (a.average_speed || 0) > (max.average_speed || 0) ? a : max);
        
        const longestMiles = (longest.distance * 0.000621371).toFixed(1);
        const fastestSpeed = fastest.average_speed ? (fastest.average_speed * 2.237).toFixed(1) : 'N/A';
        
        return {
            text: `Your longest activity was ${longestMiles} miles. Your fastest average speed was ${fastestSpeed} mph.`,
            data: { longest, fastest }
        };
    }

    getTotalStats(summary) {
        return {
            text: `In total: ${summary.count} activities, ${summary.distanceMiles} miles, ${Math.floor(summary.timeMinutes/60)}h ${summary.timeMinutes%60}m${summary.calories > 0 ? `, ${summary.calories} calories` : ''}.`,
            data: summary
        };
    }

    getDetailedStats(summary, activities) {
        const recentActivity = activities[0];
        const date = new Date(recentActivity.start_date).toLocaleDateString();
        const miles = (recentActivity.distance * 0.000621371).toFixed(1);
        const minutes = Math.floor(recentActivity.moving_time / 60);
        
        return {
            text: `Your most recent activity was on ${date}: ${miles} miles in ${minutes} minutes${recentActivity.average_watts ? ` at ${recentActivity.average_watts} watts` : ''}.`,
            data: recentActivity
        };
    }

    async callMCPFunction(serverName, functionName, parameters) {
        console.log(`Calling MCP function: ${serverName}.${functionName} with params:`, JSON.stringify(parameters, null, 2));
        
        const client = this.mcpClients.get(serverName);
        if (!client) {
            console.error(`Available MCP servers: ${Array.from(this.mcpClients.keys()).join(', ')}`);
            throw new Error(`MCP server '${serverName}' not found`);
        }

        if (!client.connected) {
            console.error(`MCP server '${serverName}' is not connected`);
            throw new Error(`MCP server '${serverName}' not connected`);
        }

        const result = await client.callTool(functionName, parameters);
        console.log(`MCP function ${serverName}.${functionName} returned:`, JSON.stringify(result, null, 2));
        return result;
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
            case 'month':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
                break;
            default:
                startDate = new Date(now);
                startDate.setHours(0, 0, 0, 0);
        }
        
        // Format without milliseconds to match Google Calendar MCP regex
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
                endDate.setHours(23, 59, 59, 0); // Remove milliseconds
                break;
            case 'month':
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
                break;
            default:
                endDate = new Date(now);
                endDate.setDate(now.getDate() + 1);
                endDate.setHours(23, 59, 59, 0); // Remove milliseconds
        }
        
        // Format without milliseconds to match Google Calendar MCP regex
        return endDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    async saveApiKeys() {
        try {
            await fs.writeFile(
                path.join(__dirname, 'api-keys.json'),
                JSON.stringify(Array.from(this.apiKeys), null, 2)
            );
        } catch (error) {
            console.error('Failed to save API keys:', error);
        }
    }

    async loadApiKeys() {
        try {
            const data = await fs.readFile(path.join(__dirname, 'api-keys.json'), 'utf8');
            const keys = JSON.parse(data);
            this.apiKeys = new Set(keys);
            
            // Add a default key if none exist
            if (this.apiKeys.size === 0) {
                const defaultKey = 'va_' + crypto.randomBytes(16).toString('hex');
                this.apiKeys.add(defaultKey);
                console.log(`Created default API key: ${defaultKey}`);
                await this.saveApiKeys();
            }
        } catch (error) {
            // File doesn't exist, create default key
            const defaultKey = 'va_' + crypto.randomBytes(16).toString('hex');
            this.apiKeys.add(defaultKey);
            console.log(`Created default API key: ${defaultKey}`);
            await this.saveApiKeys();
        }
    }

    start() {
        this.app.listen(this.port, () => {
            console.log(`🚀 MCP Bridge Service running on http://localhost:${this.port}`);
            console.log(`📊 Health check: http://localhost:${this.port}/health`);
            console.log(`🔑 API Keys: ${Array.from(this.apiKeys).join(', ')}`);
            console.log(`🔧 Connected MCP Servers: ${Array.from(this.mcpClients.keys()).join(', ')}`);
        });
    }

    // Cleanup on exit
    cleanup() {
        console.log('Cleaning up MCP connections...');
        for (const [name, client] of this.mcpClients) {
            client.disconnect();
        }
    }
}

// Start the service
if (require.main === module) {
    const service = new MCPBridgeService();
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('Received SIGINT, shutting down gracefully...');
        service.cleanup();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, shutting down gracefully...');
        service.cleanup();
        process.exit(0);
    });
    
    service.start();
}

module.exports = MCPBridgeService;
