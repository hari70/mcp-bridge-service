#!/usr/bin/env node
import { OAuth2Client } from 'google-auth-library';
import { createServer } from 'http';
import { parse } from 'url';
import open from 'open';

// Get from environment or prompt user to set them
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

async function setupGoogleAuth() {
  console.log('🗓️  Google Calendar MCP Authentication Setup\n');

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log('❌ Missing Google OAuth credentials!\n');
    console.log('📋 Setup Instructions:');
    console.log('1. Go to: https://console.cloud.google.com/');
    console.log('2. Create/select your project');
    console.log('3. Enable Google Calendar API');
    console.log('4. Create OAuth 2.0 Client ID credentials');
    console.log('5. Application type: "Desktop application"');
    console.log('6. Add authorized redirect URI: http://localhost:3000/oauth2callback');
    console.log('7. Download credentials and set environment variables:\n');
    console.log('   export GOOGLE_CLIENT_ID="your_client_id"');
    console.log('   export GOOGLE_CLIENT_SECRET="your_client_secret"\n');
    console.log('8. Then run: npm run auth\n');
    process.exit(1);
  }

  const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Forces refresh token
  });

  console.log('🚀 Starting authentication process...');
  console.log('📱 Opening browser for Google OAuth...\n');

  // Create local server to catch the callback
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/oauth2callback')) {
      const urlParts = parse(req.url, true);
      const code = urlParts.query.code as string;

      if (code) {
        try {
          // Use callback style API
          oauth2Client.getAccessToken(code, (err, tokens) => {
            if (err) {
              console.error('❌ Error getting tokens:', err);
              res.writeHead(500);
              res.end('Authentication failed');
              server.close();
              process.exit(1);
              return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; text-align: center; padding: 50px; background: #f5f5f5;">
                  <div style="background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto;">
                    <h1 style="color: #28a745; margin-bottom: 20px;">✅ Authentication Successful!</h1>
                    <p style="color: #666; margin-bottom: 30px;">Your Google Calendar is now connected to the MCP server.</p>
                    <p style="color: #999; font-size: 14px;">You can close this window and return to your terminal.</p>
                  </div>
                </body>
              </html>
            `);

            console.log('\n🎉 Authentication successful!');
            console.log('\n📝 Add these environment variables to Railway:');
            console.log('=' .repeat(60));
            console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`);
            console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`);
            console.log(`GOOGLE_REFRESH_TOKEN=${tokens?.refresh_token}`);
            console.log(`MCP_AUTH_TOKEN=your_chosen_mcp_token_here`);
            console.log('=' .repeat(60));
            
            if (tokens?.refresh_token) {
              console.log('\n💾 IMPORTANT: Save the refresh token - it won\'t be shown again!');
            } else {
              console.log('\n⚠️  No refresh token received. Try revoking access and running auth again.');
              console.log('   Revoke at: https://myaccount.google.com/permissions');
            }

            console.log('\n🚀 Next steps:');
            console.log('1. Copy the environment variables to Railway');
            console.log('2. Deploy your calendar MCP server');
            console.log('3. Test with: curl -H "Authorization: Bearer YOUR_MCP_TOKEN" YOUR_RAILWAY_URL/mcp/tools/list-calendars');

            server.close();
            process.exit(0);
          });
        } catch (error) {
          console.error('❌ Error during authentication:', error);
          res.writeHead(500);
          res.end('Authentication failed');
          server.close();
          process.exit(1);
        }
      } else {
        res.writeHead(400);
        res.end('No authorization code received');
        server.close();
        process.exit(1);
      }
    }
  });

  server.listen(3000, () => {
    console.log('🌐 Local auth server running on http://localhost:3000');
    console.log('🔓 Opening Google OAuth page...\n');
    open(authUrl);
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n❌ Authentication cancelled');
    server.close();
    process.exit(0);
  });
}

setupGoogleAuth().catch(console.error);