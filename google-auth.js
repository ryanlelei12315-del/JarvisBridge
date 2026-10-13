// One-time (or re-run if expired) Google sign-in. Creates token.json next to this file.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const { google } = require('googleapis');

const CRED_FILE = path.join(__dirname, 'credentials.json');
const TOKEN_FILE = path.join(__dirname, 'token.json');
const PORT = 3001;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/gmail.metadata'
];

if (!fs.existsSync(CRED_FILE)) {
    console.error('credentials.json not found in ' + __dirname);
    process.exit(1);
}
const creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).installed;
if (!creds) {
    console.error('credentials.json must be an OAuth client of type "Desktop app".');
    process.exit(1);
}

const client = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT);
const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT);
    if (url.pathname !== '/oauth2callback') { res.writeHead(404); return res.end(); }

    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error || !code) {
        res.end('Authorization failed: ' + (error || 'no code returned'));
        console.error('Authorization failed:', error || 'no code returned');
        return server.close(() => process.exit(1));
    }

    try {
        const { tokens } = await client.getToken(code);
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
        res.end('Authorized. You can close this tab.');
        console.log('Saved token.json. Restart the bridge to enable Calendar and Gmail alerts.');
        server.close(() => process.exit(0));
    } catch (e) {
        res.end('Token exchange failed: ' + e.message);
        console.error('Token exchange failed:', e.message);
        server.close(() => process.exit(1));
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('Open this URL to authorize (trying to open it automatically):\n\n' + authUrl + '\n');
    exec(`start "" "${authUrl}"`);
});
