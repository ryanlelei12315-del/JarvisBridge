const express = require('express');
const http = require('http');
const os = require('os');
const WebSocket = require('ws');
const { createMonitors } = require('./monitors');

const LEVELS = ['info', 'warn', 'critical'];
const STATES = ['idle', 'listening', 'thinking', 'speaking'];
let currentState = 'idle';

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---------- Broadcast ----------
function broadcast(payload) {
    const msg = JSON.stringify(payload);
    let delivered = 0;
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
            delivered++;
        }
    });
    return delivered;
}

// Single entry point for every alert (HTTP, monitors, Google watcher).
// speak=false shows the colour/pulse on the sphere but does not use the wallpaper's own voice
// (for callers such as FRIDAY that already speak the reply themselves).
function emit(text, level = 'info', speak = true) {
    console.log(`[ALERT:${level}${speak ? '' : ':silent'}] "${text}"`);
    return broadcast({ text, level, speak });
}

// ---------- Real system metrics ----------
function readCpuTimes() {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
        for (const type in cpu.times) total += cpu.times[type];
        idle += cpu.times.idle;
    }
    return { idle, total };
}

let prevCpu = readCpuTimes();
let latest = null; // stays null until the first real sample exists

function sampleMetrics() {
    const now = readCpuTimes();
    const dIdle = now.idle - prevCpu.idle;
    const dTotal = now.total - prevCpu.total;
    prevCpu = now;

    const cpu = dTotal > 0 ? Math.round(100 * (1 - dIdle / dTotal)) : 0;
    const ram = Math.round(100 * (1 - os.freemem() / os.totalmem()));
    return { type: 'metrics', cpu, ram };
}

const monitors = createMonitors(emit);

setInterval(() => {
    latest = sampleMetrics();
    if (wss.clients.size > 0) broadcast(latest);
    monitors.onMetrics(latest.cpu, latest.ram);
}, 2000);

// ---------- WebSocket ----------
wss.on('connection', (ws) => {
    console.log('[BRIDGE] Live Wallpaper interface connected.');
    if (latest) ws.send(JSON.stringify(latest));
    if (currentState !== 'idle') ws.send(JSON.stringify({ type: 'state', state: currentState }));
    ws.on('close', () => console.log('[BRIDGE] Wallpaper disconnected.'));
});

// ---------- HTTP API ----------
app.post('/alert', (req, res) => {
    const body = req.body || {};
    const text = body.text;
    const level = body.level === undefined ? 'info' : body.level;

    if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Missing "text" field.' });
    }
    if (!LEVELS.includes(level)) {
        return res.status(400).json({ error: `"level" must be one of: ${LEVELS.join(', ')}.` });
    }

    const speak = body.speak === undefined ? true : body.speak;
    if (typeof speak !== 'boolean') {
        return res.status(400).json({ error: '"speak" must be true or false.' });
    }

    const delivered = emit(text.trim().slice(0, 500), level, speak);
    return res.status(200).json({ success: true, delivered });
});

// FRIDAY (or anything else) reports what the assistant is doing: idle, listening, thinking, speaking.
app.post('/state', (req, res) => {
    const state = req.body && req.body.state;
    if (!STATES.includes(state)) {
        return res.status(400).json({ error: `"state" must be one of: ${STATES.join(', ')}.` });
    }
    currentState = state;
    console.log(`[STATE] ${state}`);
    const delivered = broadcast({ type: 'state', state });
    return res.status(200).json({ success: true, delivered });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, wallpapers: wss.clients.size });
});

// ---------- Optional Google Calendar / Gmail alerts ----------
try {
    require('./google-watch').start(emit);
} catch (err) {
    console.error('[GOOGLE] Disabled:', err.message);
}

const PORT = process.env.PORT || 3000;
// Loopback only by default: nothing else on your network can trigger alerts.
// If n8n runs in Docker it cannot reach loopback; start the bridge with BRIDGE_HOST=0.0.0.0 in that case.
const HOST = process.env.BRIDGE_HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
    console.log(`[ONLINE] Bridge Server active on ${HOST}:${PORT}`);
});
