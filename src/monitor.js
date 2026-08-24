
const RT = require('./runtime');

const SAMPLE_CMD = [
    'echo K_HOST', 'hostname',
    'echo K_UP', 'cat /proc/uptime',
    'echo K_CPU', "grep '^cpu ' /proc/stat",
    'echo K_MEM', "grep -E 'MemTotal|MemAvailable' /proc/meminfo",
    'echo K_NET', 'cat /proc/net/dev',
    'echo K_DF', 'df -P /',
    'echo K_WHO', 'who',
    'echo K_END'
].join('; ');

function fmtUptime(sec) {
    sec = Math.floor(sec);
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + 'm ' + (sec % 60) + 's';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm';
    const d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h';
}

function parseSample(tab, text) {
    const lines = text.split('\n');
    const sec = {}; let key = null;
    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (line.startsWith('K_')) { key = line.trim(); sec[key] = []; continue; }
        if (key) sec[key].push(line);
    }
    const first = k => (sec[k] && sec[k][0]) || '';
    const now = Date.now();
    const prev = tab._monPrev || {};
    const mon = { host: (first('K_HOST') || tab.title || '').trim() };

    mon.uptime = fmtUptime(parseFloat(first('K_UP').split(/\s+/)[0]) || 0);

    const cpuNums = first('K_CPU').trim().split(/\s+/).slice(1).map(Number);
    if (cpuNums.length >= 4) {
        const idle = cpuNums[3] + (cpuNums[4] || 0);
        const total = cpuNums.reduce((a, b) => a + b, 0);
        if (prev.cpuTotal != null && total > prev.cpuTotal) {
            const dt = total - prev.cpuTotal, di = idle - prev.cpuIdle;
            mon.cpu = Math.max(0, Math.min(100, 100 * (dt - di) / dt));
        }
        tab._monPrev = Object.assign(tab._monPrev || {}, { cpuTotal: total, cpuIdle: idle });
    }

    let mt = 0, ma = 0;
    (sec['K_MEM'] || []).forEach(l => {
        const m = l.match(/(MemTotal|MemAvailable):\s+(\d+)/);
        if (m) { if (m[1] === 'MemTotal') mt = +m[2]; else ma = +m[2]; }
    });
    if (mt) { mon.memTotal = mt / 1048576; mon.memUsed = (mt - ma) / 1048576; }

    let rx = 0, tx = 0;
    (sec['K_NET'] || []).forEach(l => {
        if (!l.includes(':')) return;
        const idx = l.indexOf(':');
        const iface = l.slice(0, idx).trim();
        if (iface === 'lo') return;
        const nums = l.slice(idx + 1).trim().split(/\s+/).map(Number);
        if (nums.length >= 9) { rx += nums[0] || 0; tx += nums[8] || 0; }
    });
    if (prev.rx != null && prev.t) {
        const dtSec = (now - prev.t) / 1000;
        if (dtSec > 0) {
            mon.down = Math.max(0, (rx - prev.rx) * 8 / 1e6 / dtSec);
            mon.up = Math.max(0, (tx - prev.tx) * 8 / 1e6 / dtSec);
        }
    }
    tab._monPrev = Object.assign(tab._monPrev || {}, { rx, tx, t: now });

    const dfRow = (sec['K_DF'] || [])[ (sec['K_DF'] || []).length - 1 ] || '';
    const dm = dfRow.match(/(\d+)%/);
    if (dm) mon.disk = +dm[1];

    const counts = {};
    (sec['K_WHO'] || []).forEach(l => { const u = l.trim().split(/\s+/)[0]; if (u) counts[u] = (counts[u] || 0) + 1; });
    const users = Object.keys(counts);
    mon.userCount = users.reduce((a, u) => a + counts[u], 0);
    mon.users = users.map(u => `${u} x${counts[u]}`).join(', ');

    tab.monitor = mon;
}

const errors = require('./errors');
const MAX_FAILS = 5;

function tick(tab) {
    if (!tab || tab.closed || !tab.client || !tab.connected) return stop(tab);
    if (tab._monBusy) return;
    tab._monBusy = true;
    let buf = '';

    // A host that cannot answer (no /proc, exec disabled, channel limit reached)
    // would otherwise be re-probed every second for the life of the tab.
    const fail = e => {
        tab._monBusy = false;
        tab._monFails = (tab._monFails || 0) + 1;
        if (e) errors.record('monitor', e, tab.title);
        if (tab._monFails >= MAX_FAILS) { stop(tab); tab.monitorUnavailable = true; }
    };

    try {
        tab.client.exec(SAMPLE_CMD, (err, stream) => {
            if (err) return fail(err);
            if (tab.closed) { tab._monBusy = false; try { stream.close(); } catch (e) {} return; }
            errors.guardStream(stream, 'monitor');
            // A channel can emit 'error' without ever emitting 'close'.
            stream.on('error', e => fail(e));
            stream.on('data', d => { buf += d.toString(); });
            stream.stderr.on('data', () => {});
            stream.on('close', () => {
                tab._monBusy = false;
                try { parseSample(tab, buf); tab._monFails = 0; }
                catch (e) { errors.record('monitor.parse', e); }
                if (RT.activeTabId === tab.id && !tab.closed) {
                    errors.attempt(() => require('./statusbar').updateStatusBar(), 'statusbar');
                }
            });
        });
    } catch (e) { fail(e); }
}

function start(tab) {
    if (!tab || tab.closed || tab._monTimer || !tab.connected) return;
    tab._monPrev = null; tab._monFails = 0; tab.monitorUnavailable = false;
    tick(tab);
    tab._monTimer = setInterval(() => tick(tab), 1000);
}
function stop(tab) {
    if (!tab) return;
    if (tab._monTimer) clearInterval(tab._monTimer);
    tab._monTimer = null; tab._monBusy = false; tab._monPrev = null;
}

function setActive(activeId) {
    RT.tabs.forEach(t => {
        if (t.type !== 'terminal') return;
        if (t.id === activeId && t.connected) start(t);
        else stop(t);
    });
}

module.exports = { stop, setActive };
