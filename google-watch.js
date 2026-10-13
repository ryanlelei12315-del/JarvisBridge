const fs = require('fs');
const path = require('path');

const CRED_FILE = path.join(__dirname, 'credentials.json');
const TOKEN_FILE = path.join(__dirname, 'token.json');
const CAL_LEAD_MIN = 10;          // announce events starting within this many minutes
const CAL_POLL_MS = 60 * 1000;
const MAIL_POLL_MS = 2 * 60 * 1000;
const MAX_MAIL_ANNOUNCE = 3;

function start(emit) {
    if (!fs.existsSync(CRED_FILE) || !fs.existsSync(TOKEN_FILE)) {
        console.log('[GOOGLE] Not configured (credentials.json / token.json missing). Calendar and Gmail alerts off.');
        return;
    }

    let google;
    try {
        ({ google } = require('googleapis'));
    } catch (e) {
        console.log('[GOOGLE] googleapis is not installed. Run: npm install googleapis');
        return;
    }

    const creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).installed;
    if (!creds) {
        console.log('[GOOGLE] credentials.json must be an OAuth client of type "Desktop app".');
        return;
    }

    const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'http://127.0.0.1:3001/oauth2callback');
    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
    auth.on('tokens', (t) => {
        try {
            const current = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
            fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...current, ...t }, null, 2));
        } catch (e) {
            console.error('[GOOGLE] Could not save refreshed token:', e.message);
        }
    });

    const calendar = google.calendar({ version: 'v3', auth });
    const gmail = google.gmail({ version: 'v1', auth });

    let authDead = false;
    const lastError = {};

    async function guarded(name, fn) {
        if (authDead) return;
        try {
            await fn();
            lastError[name] = '';
        } catch (e) {
            const msg = (e && e.message) || String(e);
            if (/invalid_grant/i.test(msg)) {
                authDead = true;
                console.error('[GOOGLE] Authorization expired. Run: node google-auth.js');
                emit('Google authorization has expired. Run google auth again to restore calendar and email alerts.', 'warn');
                return;
            }
            if (lastError[name] !== msg) {
                console.error(`[GOOGLE] ${name} failed: ${msg}`);
                lastError[name] = msg;
            }
        }
    }

    // ----- Calendar -----
    const announced = new Set();

    async function pollCalendar() {
        const now = new Date();
        const res = await calendar.events.list({
            calendarId: 'primary',
            timeMin: now.toISOString(),
            timeMax: new Date(now.getTime() + CAL_LEAD_MIN * 60000).toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 10
        });

        for (const ev of res.data.items || []) {
            if (!ev.start || !ev.start.dateTime) continue;      // skip all-day events
            if (ev.status === 'cancelled') continue;
            const me = (ev.attendees || []).find((a) => a.self);
            if (me && me.responseStatus === 'declined') continue;

            const key = `${ev.id}|${ev.start.dateTime}`;
            if (announced.has(key)) continue;
            if (announced.size > 500) announced.clear();
            announced.add(key);

            const mins = Math.max(1, Math.round((new Date(ev.start.dateTime) - now) / 60000));
            emit(`${ev.summary || 'An event'} starts in ${mins} ${mins === 1 ? 'minute' : 'minutes'}.`, 'info');
        }
    }

    // ----- Gmail (metadata scope: headers only, no message bodies) -----
    const seen = new Set();
    let primed = false;

    function senderName(from) {
        const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
        return m ? m[1] : from.split('@')[0];
    }

    async function pollMail() {
        const list = await gmail.users.messages.list({
            userId: 'me',
            labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
            maxResults: 10
        });
        const ids = (list.data.messages || []).map((m) => m.id);

        // First poll only records what is already there, so old mail is not announced.
        if (!primed) {
            ids.forEach((id) => seen.add(id));
            primed = true;
            return;
        }

        const fresh = ids.filter((id) => !seen.has(id));
        fresh.forEach((id) => seen.add(id));
        if (seen.size > 500) { seen.clear(); ids.forEach((id) => seen.add(id)); }

        for (const id of fresh.slice(0, MAX_MAIL_ANNOUNCE)) {
            const msg = await gmail.users.messages.get({
                userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject']
            });
            const headers = (msg.data.payload && msg.data.payload.headers) || [];
            const get = (n) => (headers.find((h) => h.name.toLowerCase() === n) || {}).value || '';
            const subject = get('subject').slice(0, 100) || 'No subject';
            emit(`Important email from ${senderName(get('from')) || 'unknown sender'}. ${subject}`, 'info');
        }
        if (fresh.length > MAX_MAIL_ANNOUNCE) {
            emit(`And ${fresh.length - MAX_MAIL_ANNOUNCE} more important emails.`, 'info');
        }
    }

    setInterval(() => guarded('Calendar', pollCalendar), CAL_POLL_MS);
    setInterval(() => guarded('Gmail', pollMail), MAIL_POLL_MS);
    guarded('Calendar', pollCalendar);
    guarded('Gmail', pollMail);
    console.log('[GOOGLE] Calendar and Gmail watchers active.');
}

module.exports = { start };
