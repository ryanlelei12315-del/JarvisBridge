const net = require('net');
const { execFile } = require('child_process');

// ---------- Sustained-threshold alert (hysteresis + cooldown) ----------
function sustained({ high, low, holdMs, cooldownMs, text, level }, emit) {
    let aboveSince = null;
    let active = false;
    let lastAlert = -Infinity;

    return function onValue(value, now) {
        if (value >= high) {
            if (aboveSince === null) aboveSince = now;
            if (!active && now - aboveSince >= holdMs && now - lastAlert >= cooldownMs) {
                active = true;
                lastAlert = now;
                emit(text(value), level);
            }
        } else {
            aboveSince = null;
            if (value <= low) active = false;
        }
    };
}

// ---------- Battery (Windows, via CIM) ----------
function startBattery(emit) {
    if (process.platform !== 'win32') return;

    const cmd = 'Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress';
    let first = true;
    let wasOnBattery = null;
    const warned = { 20: false, 10: false };
    let timer = null;

    const read = () => new Promise((resolve) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', cmd],
            { windowsHide: true, timeout: 15000 },
            (err, out) => {
                if (err || !out || !out.trim()) return resolve(null);
                try { resolve(JSON.parse(out)); } catch (e) { resolve(null); }
            }
        );
    });

    async function poll() {
        const b = await read();
        if (!b) {
            if (first) {
                console.log('[MONITOR] No battery detected. Battery alerts disabled.');
                clearInterval(timer);
            }
            first = false;
            return;
        }
        first = false;

        const pct = b.EstimatedChargeRemaining;
        // Win32_Battery: 1 discharging, 4 low, 5 critical
        const onBattery = [1, 4, 5].includes(b.BatteryStatus);

        if (wasOnBattery !== null) {
            if (wasOnBattery && !onBattery) emit(`Charger connected. Battery at ${pct} percent.`, 'info');
            else if (!wasOnBattery && onBattery) emit(`Charger disconnected. Battery at ${pct} percent.`, 'info');
        }
        wasOnBattery = onBattery;

        if (onBattery && typeof pct === 'number') {
            if (pct <= 10 && !warned[10]) {
                warned[10] = warned[20] = true;
                emit(`Battery critical. ${pct} percent remaining.`, 'critical');
            } else if (pct <= 20 && !warned[20]) {
                warned[20] = true;
                emit(`Battery low. ${pct} percent remaining.`, 'warn');
            } else if (pct > 25) {
                warned[10] = warned[20] = false;
            }
        } else {
            warned[10] = warned[20] = false;
        }
    }

    timer = setInterval(poll, 60000);
    poll();
}

// ---------- Internet connectivity ----------
function startNetwork(emit) {
    let everOnline = false;
    let down = false;
    let failures = 0;
    let firstFailAt = 0;

    const probe = (host, port) => new Promise((resolve) => {
        const socket = net.connect({ host, port });
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(3000, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });

    const fmt = (ms) => {
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s} seconds`;
        const m = Math.round(s / 60);
        return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
    };

    async function check() {
        const ok = (await probe('1.1.1.1', 443)) || (await probe('8.8.8.8', 53));

        if (ok) {
            failures = 0;
            if (down) {
                down = false;
                emit(`Internet connection restored after ${fmt(Date.now() - firstFailAt)}.`, 'info');
            }
            everOnline = true;
        } else {
            if (failures === 0) firstFailAt = Date.now();
            failures++;
            // Only announce an outage if we were online first (no false alarm at boot).
            if (everOnline && !down && failures >= 3) {
                down = true;
                emit('Internet connection lost.', 'warn');
            }
        }
    }

    setInterval(check, 10000);
    check();
}

// ---------- Public API ----------
function createMonitors(emit) {
    const cpu = sustained({
        high: 90, low: 75, holdMs: 30000, cooldownMs: 10 * 60000, level: 'warn',
        text: (v) => `CPU load is at ${v} percent and has stayed high for thirty seconds.`
    }, emit);

    const ram = sustained({
        high: 90, low: 80, holdMs: 30000, cooldownMs: 10 * 60000, level: 'warn',
        text: (v) => `Memory usage is at ${v} percent.`
    }, emit);

    startBattery(emit);
    startNetwork(emit);

    return {
        onMetrics(cpuPct, ramPct) {
            const now = Date.now();
            cpu(cpuPct, now);
            ram(ramPct, now);
        }
    };
}

module.exports = { createMonitors };
