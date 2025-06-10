#!/usr/bin/env node
import { OAuth2Client } from 'google-auth-library';
import { createServer } from 'http';
import { parse } from 'url';
import open from 'open';

// Debug version with more logging
console.log('🔍 Google Calendar Auth Debug Version\n');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

console.log('Environment check:');
console.log(`CLIENT_ID: ${CLIENT_ID ? '✅ Set' : '❌ Missing'}`);
console.log(`CLIENT_SECRET: ${CLIENT_SECRET ? '✅ Set' : '❌ Missing'}`);
console.log(`REDIRECT_URI: ${REDIRECT_URI}`);
console.log('');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.log('❌ Environment variables not set!');
  console.log('');
  console.log('🛠️  Quick Setup:');
  console.log('1. Go to: https://console.cloud.google.com/apis/credentials');
  console.log('2. Find your OAuth 2.0 Client ID');
  console.log('3. Copy Client ID and Client Secret');
  console.log('4. Run these commands:');
  console.log('');
  console.log('   export GOOGLE_CLIENT_ID="your_client_id_here"');
  console.log('   export GOOGLE_CLIENT_SECRET="your_client_secret_here"');
  console.log('');
  console.log('5. Then run: npm run auth');
  console.log('');
  console.log('💡 Make sure your OAuth app has this redirect URI:');
  console.log('   http://localhost:3000/oauth2callback');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

async function debugAuth() {
  console.log('🚀 Creating OAuth client...');
  const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  console.log('🔗 Generating auth URL...');
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('Auth URL generated:', authUrl);
  console.log('');

  // Check if port 3000 is available
  const server = createServer((req, res) => {
    console.log(`📥 Received request: ${req.method} ${req.url}`);
    
    if (req.url?.startsWith('/oauth2callback')) {
      const urlParts = parse(req.url, true);
      console.log('Query parameters:', urlParts.query);
      
      const code = urlParts.query.code as string;
      const error = urlParts.query.error as string;

      if (error) {
        console.log('❌ OAuth error:', error);
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1 style="color: red;">❌ OAuth Error</h1>
              <p>Error: ${error}</p>
              <p>Check your Google Cloud Console setup.</p>
            </body>
          </html>
        `);
        return;
      }

      if (code) {
        console.log('✅ Authorization code received:', code.substring(0, 20) + '...');
        
        // Fixed API call - pass code in object
        oauth2Client.getAccessToken({code})
          .then(({tokens}) => {
            console.log('🎉 Tokens received successfully!');
            console.log('Access token:', tokens.access_token ? '✅ Present' : '❌ Missing');
            console.log('Refresh token:', tokens.refresh_token ? '✅ Present' : '❌ Missing');
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #f0f8ff;">
                  <div style="background: white; padding: 40px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto;">
                    <h1 style="color: #28a745;">✅ Success!</h1>
                    <p>Google Calendar authentication completed.</p>
                    <p style="font-size: 14px; color: #666;">Check your terminal for the environment variables.</p>
                  </div>
                </body>
              </html>
            `);

            console.log('');
            console.log('🎯 COPY THESE ENVIRONMENT VARIABLES:');
            console.log('=' .repeat(50));
            console.log(`GOOGLE_CLIENT_ID="${CLIENT_ID}"`);
            console.log(`GOOGLE_CLIENT_SECRET="${CLIENT_SECRET}"`);
            console.log(`GOOGLE_REFRESH_TOKEN="${tokens.refresh_token}"`);
            console.log(`MCP_AUTH_TOKEN="your_secure_mcp_token_here"`);
            console.log('=' .repeat(50));

            server.close();
            process.exit(0);
          })
          .catch((error) => {
            console.error('❌ Token exchange error:', error.message);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                  <h1 style="color: red;">❌ Token Error</h1>
                  <p>${error.message}</p>
                </body>
              </html>
            `);
          });
      } else {
        console.log('❌ No authorization code in callback');
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
              <h1 style="color: red;">❌ No Authorization Code</h1>
              <p>Something went wrong with the OAuth callback.</p>
            </body>
          </html>
        `);
      }
    } else {
      // Handle other requests
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.log('❌ Port 3000 is already in use!');
      console.log('💡 Try: lsof -ti:3000 | xargs kill -9');
      console.log('   Then run npm run auth again');
    } else {
      console.error('Server error:', err);
    }
    process.exit(1);
  });

  server.listen(3000, () => {
    console.log('🌐 Auth server started on http://localhost:3000');
    console.log('🔓 Opening browser...');
    console.log('');
    
    // Try to open the browser
    open(authUrl).catch((err) => {
      console.log('⚠️  Could not auto-open browser.');
      console.log('📋 Please manually visit this URL:');
      console.log(authUrl);
    });
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log('\n🛑 Authentication cancelled by user');
    server.close();
    process.exit(0);
  });
}

debugAuth().catch((error) => {
  console.error('💥 Setup error:', error.message);
  process.exit(1);
});