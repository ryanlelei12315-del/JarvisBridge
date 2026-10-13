// Usage:
//   jarvis "Build finished"
//   jarvis -w "Disk almost full"        (warn)
//   jarvis -c "Server down"             (critical)
//   jarvis -l warn "text"
//   some-command | jarvis
const http = require('http');

const HOST = '127.0.0.1';
const PORT = 3000;

function usage() {
    console.error('Usage: jarvis [-l info|warn|critical | -w | -c] "message"\n       command | jarvis');
    process.exit(2);
}

const args = process.argv.slice(2);
let level = 'info';
const words = [];
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-l' || a === '--level') level = args[++i];
    else if (a === '-w') level = 'warn';
    else if (a === '-c') level = 'critical';
    else if (a === '-h' || a === '--help') usage();
    else words.push(a);
}

function send(text) {
    const body = JSON.stringify({ text, level });
    const req = http.request({
        host: HOST, port: PORT, path: '/alert', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
            let json = {};
            try { json = JSON.parse(raw); } catch (e) { /* ignore */ }
            if (res.statusCode !== 200) {
                console.error('Bridge rejected the alert: ' + (json.error || raw));
                process.exit(1);
            }
            if (json.delivered === 0) console.error('Sent, but no wallpaper is connected.');
        });
    });
    req.on('error', () => {
        console.error(`Bridge not reachable on ${HOST}:${PORT}.`);
        process.exit(1);
    });
    req.end(body);
}

if (words.length) {
    send(words.join(' '));
} else if (!process.stdin.isTTY) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (input += c));
    process.stdin.on('end', () => {
        const text = input.trim();
        if (!text) usage();
        send(text);
    });
} else {
    usage();
}
