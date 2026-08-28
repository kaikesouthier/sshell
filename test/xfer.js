// Covers src/xfer.js — the dedicated SSH connection for SFTP, so file transfers
// stop sharing a transport with the interactive shell.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const { EventEmitter } = require('events');
const src = fs.readFileSync(path.join(ROOT, 'src/xfer.js'), 'utf8');

const body = src.split('\n')
    .filter(l => !/^const .* = require\(/.test(l) && !/^const \{ .* \} = require\(/.test(l) && !/^module\.exports/.test(l))
    .join('\n');

let built = [], recorded = [], activeTransfers = new Set();

function FakeClient() {
    const c = new EventEmitter();
    c.connected = false;
    c.ended = false;
    c.destroyed = false;
    c.connect = cfg => { c.config = cfg; built.push(c); if (c.autoReady) setImmediate(() => c.emit('ready')); };
    c.end = () => { c.ended = true; };
    c.destroy = () => { c.destroyed = true; };
    c.sftp = cb => cb(null, new EventEmitter());
    return c;
}

let nextClient = null;
const Client = function () { return nextClient || FakeClient(); };
const S = { getSession: id => (id ? { host: 'h.example', port: 22, username: 'u', authType: 'password', password: 'p' } : null) };
const errors = { record: (...a) => recorded.push(a) };
const buildConnectConfig = cfg => ({ host: cfg.host, port: cfg.port, username: cfg.username });

// Timers are driven by hand so the idle logic can be tested without waiting.
let timers = [], timerSeq = 1;
const setT = (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; };
const clearT = id => { timers = timers.filter(t => t.id !== id); };
const fire = ms => { const due = timers.filter(t => t.ms === ms); timers = timers.filter(t => t.ms !== ms); due.forEach(t => t.fn()); };

const sftpStub = { hasActiveTransfers: id => activeTransfers.has(id) };
const req = m => (m === './sftp' ? sftpStub : {});

let now = 1000000;
const X = new Function('Client', 'S', 'errors', 'buildConnectConfig', 'require', 'setTimeout', 'clearTimeout', 'Date',
    body + ';return { clientFor, closeFor, touch };')(
    Client, S, errors, buildConnectConfig, req, setT, clearT, { now: () => now });

let pass = 0, fail = 0;
const t = (n, c) => {
    try {
        const r = c();
        if (r === true) { pass++; console.log('  ok   ' + n); }
        else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
    } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

const mkTab = () => ({ id: 't1', configId: 'ses1', closed: false, connected: true, client: { name: 'shell' } });
const reset = () => { built = []; recorded = []; timers = []; activeTransfers = new Set(); nextClient = null; now = 1000000; };

// --- a dedicated connection ---

t('the first request opens a second connection', () => {
    reset();
    const tab = mkTab();
    let got = null;
    X.clientFor(tab, (e, c, d) => { got = { e, c, d }; });
    if (built.length !== 1) return 'expected one connect, got ' + built.length;
    built[0].emit('ready');
    return got && got.e === null && got.d === true && got.c === built[0];
});
t('it authenticates with the session credentials', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    return built[0].config.host === 'h.example' && built[0].config.username === 'u';
});
t('the connection is reused, not rebuilt per request', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('ready');
    let second = null;
    X.clientFor(tab, (e, c, d) => { second = { c, d }; });
    return built.length === 1 && second.c === built[0] && second.d === true;
});
t('requests made while connecting all get the same client', () => {
    reset();
    const tab = mkTab();
    const got = [];
    X.clientFor(tab, (e, c, d) => got.push({ c, d }));
    X.clientFor(tab, (e, c, d) => got.push({ c, d }));
    X.clientFor(tab, (e, c, d) => got.push({ c, d }));
    built[0].emit('ready');
    return built.length === 1 && got.length === 3 && got.every(g => g.c === built[0] && g.d === true);
});

// --- falling back ---
// A server with MaxSessions=1, or one refusing a second login, must not break
// the file browser: share the session's connection instead.

t('a refused second connection falls back to the shell connection', () => {
    reset();
    const tab = mkTab();
    let got = null;
    X.clientFor(tab, (e, c, d) => { got = { e, c, d }; });
    built[0].emit('error', new Error('MaxSessions'));
    return got.e === null && got.c === tab.client && got.d === false;
});
t('a fallback is recorded, not swallowed', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('error', new Error('nope'));
    return recorded.length === 1 && recorded[0][0] === 'xfer.connect';
});
t('a refused server is not retried on every request', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('error', new Error('nope'));
    let got = null;
    X.clientFor(tab, (e, c, d) => { got = { c, d }; });
    return built.length === 1 && got.c === tab.client && got.d === false;
});
t('it tries again after the cooldown', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('error', new Error('nope'));
    now += 61 * 1000;
    X.clientFor(tab, () => {});
    return built.length === 2;
});
t('a connect timeout falls back rather than hanging', () => {
    reset();
    const tab = mkTab();
    let got = null;
    X.clientFor(tab, (e, c, d) => { got = { c, d }; });
    fire(25000);
    return got && got.c === tab.client && got.d === false;
});
t('a session with no stored config falls back', () => {
    reset();
    const tab = mkTab();
    tab.configId = null;
    let got = null;
    X.clientFor(tab, (e, c, d) => { got = { c, d }; });
    return built.length === 0 && got.c === tab.client && got.d === false;
});

// --- a dead connection ---

t('a connection that dies later is dropped', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('ready');
    built[0].emit('close');
    return !tab._xfer;
});
t('the next request after a death reconnects', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('ready');
    built[0].emit('close');
    X.clientFor(tab, () => {});
    return built.length === 2;
});
t('a late error is recorded, not thrown', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('ready');
    built[0].emit('error', new Error('dropped'));
    return recorded.some(r => r[0] === 'xfer.client');
});

// --- refusing to work at all ---

t('a closed tab gets an error, not a connection', () => {
    reset();
    const tab = mkTab(); tab.closed = true;
    let err = null;
    X.clientFor(tab, e => { err = e; });
    return !!err && built.length === 0;
});
t('a disconnected session gets an error', () => {
    reset();
    const tab = mkTab(); tab.connected = false;
    let err = null;
    X.clientFor(tab, e => { err = e; });
    return !!err && built.length === 0;
});

// --- idle teardown ---

t('an idle connection is closed', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('ready');
    fire(5 * 60 * 1000);
    return !tab._xfer && built[0].ended === true;
});
t('a connection with a transfer running is kept', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('ready');
    activeTransfers.add('t1');
    fire(5 * 60 * 1000);
    return !!tab._xfer && built[0].ended === false;
});
t('the idle timer re-arms after a busy check', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('ready');
    activeTransfers.add('t1');
    fire(5 * 60 * 1000);
    activeTransfers.delete('t1');
    fire(5 * 60 * 1000);
    return !tab._xfer;
});
t('using the connection pushes the idle deadline back', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('ready');
    const before = timers.length;
    X.clientFor(tab, () => {});
    return timers.length === before;   // re-armed, not stacked
});

// --- explicit teardown ---

t('closing a tab tears the connection down', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('ready');
    X.closeFor(tab);
    return built[0].ended === true && built[0].destroyed === true && !tab._xfer;
});
t('teardown drops a cached channel that lived on it', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('ready');
    tab.sftp = { _sshellXfer: true };
    X.closeFor(tab);
    return tab.sftp === null;
});
t('teardown leaves a channel from the shell connection alone', () => {
    reset();
    const tab = mkTab();
    X.clientFor(tab, () => {});
    built[0].emit('ready');
    const shared = { _sshellXfer: false };
    tab.sftp = shared;
    X.closeFor(tab);
    return tab.sftp === shared;
});
t('tearing down a tab that never used SFTP is safe', () => {
    reset();
    X.closeFor(mkTab()); X.closeFor(null);
    return true;
});

// --- wiring ---

const sftpSrc = fs.readFileSync(path.join(ROOT, 'src/sftp.js'), 'utf8');

// Browsing is tiny and must feel instant, so it rides the session's own
// connection; only the heavy transfers pay for a second one.
t('the file browser opens its channel on the shared session connection', () => {
    const i = sftpSrc.indexOf('function ensureSftp');
    const fn = sftpSrc.slice(i, i + 2200);
    return /tab\.client\.sftp\(/.test(fn) && !/xfer\.clientFor\(/.test(fn);
});
t('each transfer opens its channel on the dedicated transfer connection', () => {
    const i = sftpSrc.indexOf('function openTransferChannel');
    const fn = sftpSrc.slice(i, i + 1400);
    return /xfer\.clientFor\(tab,/.test(fn) && !/tab\.client\.sftp\(/.test(fn);
});
t('only browsing rides the shell connection, never a transfer', () => {
    const i = sftpSrc.indexOf('function openTransferChannel');
    const fn = sftpSrc.slice(i, i + 1400);
    return !/tab\.client\.sftp\(/.test(fn);
});
t('a dedicated connection gets the full ssh2 throughput', () => {
    const m = /const XFER_OWN = \{ concurrency: (\d+),/.exec(sftpSrc);
    return !!m && Number(m[1]) === 64;
});
t('a shared connection stays throttled', () => {
    const m = /const XFER_SHARED = \{ concurrency: (\d+), chunkSize: (\d+) \};/.exec(sftpSrc);
    return !!m && Number(m[1]) * Number(m[2]) < 1024 * 1024;
});
t('the throughput choice is made per channel', () =>
    /function xferOpts\(ch, step\)/.test(sftpSrc) && /ch && ch\._sshellXfer \? XFER_OWN : XFER_SHARED/.test(sftpSrc));
t('closing a tab closes its transfer connection', () => {
    const i = sftpSrc.indexOf('function onTabClosed');
    return /xfer\.closeFor\(tab\)/.test(sftpSrc.slice(i, i + 400));
});
t('the idle timer can see running transfers', () =>
    /function hasActiveTransfers/.test(sftpSrc) && /hasActiveTransfers,/.test(sftpSrc));

// --- the two UI fixes ---

const html = fs.readFileSync(path.join(ROOT, 'views/sidebar.html'), 'utf8');

t('the selection bar overlays rather than displacing the list', () => {
    const m = /<div id="sftpSelBar" class="([^"]*)"/.exec(html);
    return !!m && /\babsolute\b/.test(m[1]) && /\binset-0\b/.test(m[1]) && !/\bshrink-0\b/.test(m[1]);
});
t('the overlay has a positioned parent', () => {
    const i = html.indexOf('id="sftpSelBar"');
    const before = html.slice(0, i);
    const wrap = before.lastIndexOf('<div class="relative shrink-0 border-b border-edge">');
    return wrap > 0 && wrap > before.lastIndexOf('id="sftpPath"');
});
t('the overlay is opaque so it hides the toolbar under it', () => {
    const m = /<div id="sftpSelBar" class="([^"]*)"/.exec(html);
    return !!m && /bg-panel2/.test(m[1]) && /z-10/.test(m[1]);
});
t('double-clicking a file opens it with the OS', () => {
    const i = sftpSrc.indexOf("tr.addEventListener('dblclick'");
    const fn = sftpSrc.slice(i, i + 320);
    return /isDir\) return sftpList/.test(fn) && /openWithEditor\(entry, dir\)/.test(fn);
});
t('double-clicking a folder still navigates into it', () => {
    const i = sftpSrc.indexOf("tr.addEventListener('dblclick'");
    return /if \(isDir\) return sftpList\(pjoin\(dir, name\)\)/.test(sftpSrc.slice(i, i + 320));
});
t('double-click still respects a loading listing', () => {
    const i = sftpSrc.indexOf("tr.addEventListener('dblclick'");
    return /if \(sftpState\.loading\) return/.test(sftpSrc.slice(i, i + 320));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
