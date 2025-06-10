#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

// ---- ENV CHECKS ----
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN ?? '';

if (!MCP_AUTH_TOKEN) throw new Error('Missing MCP_AUTH_TOKEN');
if (!GOOGLE_CLIENT_ID) throw new Error('Missing GOOGLE_CLIENT_ID');
if (!GOOGLE_CLIENT_SECRET) throw new Error('Missing GOOGLE_CLIENT_SECRET');
if (!GOOGLE_REFRESH_TOKEN) throw new Error('Missing GOOGLE_REFRESH_TOKEN');

// ---- GOOGLE AUTH SETUP ----
const oauth2Client = new OAuth2Client(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);

oauth2Client.setCredentials({
  refresh_token: GOOGLE_REFRESH_TOKEN,
});

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ---- EXPRESS SERVER ----
const app = express();
app.use(cors());
app.use(express.json());

// ---- BEARER TOKEN AUTH MIDDLEWARE ----
const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${MCP_AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ---- HEALTH CHECK ----
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'google-calendar-mcp' });
});

// ---- CALENDAR ENDPOINTS ----

// List all calendars
app.get('/mcp/tools/list-calendars', authMiddleware, async (req, res) => {
  try {
    const response = await calendar.calendarList.list();
    res.json({
      calendars: response.data.items?.map(cal => ({
        id: cal.id,
        summary: cal.summary,
        description: cal.description,
        timeZone: cal.timeZone,
        primary: cal.primary,
        accessRole: cal.accessRole,
        backgroundColor: cal.backgroundColor,
        foregroundColor: cal.foregroundColor,
      })) || []
    });
  } catch (error: any) {
    res.status(500).json({ error: `Failed to list calendars: ${error.message}` });
  }
});

// List events
app.post('/mcp/tools/list-events', authMiddleware, async (req, res) => {
  try {
    const { calendarId = 'primary', timeMin, timeMax, maxResults = 10 } = req.body;
    
    const response = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    res.json({
      events: response.data.items?.map(event => ({
        id: event.id,
        summary: event.summary,
        description: event.description,
        start: event.start,
        end: event.end,
        location: event.location,
        attendees: event.attendees?.map(att => ({
          email: att.email,
          displayName: att.displayName,
          responseStatus: att.responseStatus,
        })),
        status: event.status,
        htmlLink: event.htmlLink,
        created: event.created,
        updated: event.updated,
        colorId: event.colorId,
      })) || []
    });
  } catch (error: any) {
    res.status(500).json({ error: `Failed to list events: ${error.message}` });
  }
});

// Create event
app.post('/mcp/tools/create-event', authMiddleware, async (req, res) => {
  try {
    const { calendarId = 'primary', summary, description, start, end, timeZone, location, attendees, colorId } = req.body;
    
    if (!summary || !start || !end || !timeZone) {
      return res.status(400).json({ error: 'Missing required fields: summary, start, end, timeZone' });
    }

    const event = {
      summary,
      description,
      location,
      start: {
        dateTime: start,
        timeZone,
      },
      end: {
        dateTime: end,
        timeZone,
      },
      attendees: attendees?.map((att: any) => ({ email: att.email })),
      colorId,
    };

    const response = await calendar.events.insert({
      calendarId,
      requestBody: event,
    });

    res.json({
      success: true,
      event: {
        id: response.data.id,
        summary: response.data.summary,
        start: response.data.start,
        end: response.data.end,
        htmlLink: response.data.htmlLink,
        location: response.data.location,
        attendees: response.data.attendees,
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: `Failed to create event: ${error.message}` });
  }
});

// Search events
app.post('/mcp/tools/search-events', authMiddleware, async (req, res) => {
  try {
    const { calendarId = 'primary', query, timeMin, timeMax, maxResults = 25 } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Missing required field: query' });
    }

    const response = await calendar.events.list({
      calendarId,
      q: query,
      timeMin,
      timeMax,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    res.json({
      query,
      events: response.data.items?.map(event => ({
        id: event.id,
        summary: event.summary,
        description: event.description,
        start: event.start,
        end: event.end,
        location: event.location,
        attendees: event.attendees?.map(att => ({
          email: att.email,
          displayName: att.displayName,
        })),
        htmlLink: event.htmlLink,
      })) || []
    });
  } catch (error: any) {
    res.status(500).json({ error: `Failed to search events: ${error.message}` });
  }
});

// Delete event
app.delete('/mcp/tools/delete-event', authMiddleware, async (req, res) => {
  try {
    const { calendarId, eventId } = req.body;
    
    if (!calendarId || !eventId) {
      return res.status(400).json({ error: 'Missing required fields: calendarId, eventId' });
    }

    await calendar.events.delete({
      calendarId,
      eventId,
    });
    
    res.json({ 
      success: true, 
      message: `Event ${eventId} deleted successfully from calendar ${calendarId}` 
    });
  } catch (error: any) {
    res.status(500).json({ error: `Failed to delete event: ${error.message}` });
  }
});

// List colors
app.get('/mcp/tools/list-colors', authMiddleware, async (req, res) => {
  try {
    const response = await calendar.colors.get();
    res.json({
      event: response.data.event || {},
      calendar: response.data.calendar || {},
    });
  } catch (error: any) {
    res.status(500).json({ error: `Failed to get colors: ${error.message}` });
  }
});

// ---- START SERVER ----
const port = Number(process.env.PORT) || 8080;

app.listen(port, () => {
  console.log(`🗓️  Google Calendar MCP server running on port ${port}`);
  console.log(`✅ Health check: http://localhost:${port}/health`);
  console.log(`📋 Available endpoints:`);
  console.log(`   GET  /mcp/tools/list-calendars`);
  console.log(`   POST /mcp/tools/list-events`);
  console.log(`   POST /mcp/tools/create-event`);
  console.log(`   POST /mcp/tools/search-events`);
  console.log(`   DELETE /mcp/tools/delete-event`);
  console.log(`   GET  /mcp/tools/list-colors`);
});