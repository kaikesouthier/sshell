
const MAX_LOG = 200;
const log = [];

function safeStr(v, fallback) {
    try {
        const s = typeof v === 'string' ? v : String(v);
        return typeof s === 'string' ? s : fallback;
    } catch (e) { return fallback; }
}

function record(kind, err, context) {
    const entry = {
        at: new Date().toISOString(),
        kind,
        context: safeStr(context || '', ''),
        message: safeStr((err && err.message) || err, 'unprintable error'),
        code: (err && typeof err.code === 'string') ? err.code : null,
        stack: safeStr(err && err.stack, null)
    };
    log.push(entry);
    if (log.length > MAX_LOG) log.shift();
    console.error('[' + kind + ']' + (context ? ' ' + context : ''), err);
    return entry;
}

function describe(err) {
    if (!err) return 'Unknown error.';
    const code = (typeof err.code === 'string') ? err.code : '';
    const msg = safeStr(err.message || err, 'An unprintable error occurred.');
    // ssh2 reports a refused host key as "Host denied (verification failed)",
    // which reads like a server-side rejection rather than our own prompt.
    if (/host denied \(verification failed\)/i.test(msg)) {
        return 'Connection refused because the host key was not trusted.\n\n' +
            'You declined the fingerprint, so no password was sent. If the server was ' +
            'legitimately rebuilt, connect again and accept the new key.';
    }
    const hint = CODE_HINTS[code];
    return hint ? msg + '\n\n' + hint : msg;
}

const CODE_HINTS = {
    ETXTBSY: 'The file is currently in use on the remote host — it is running, or another process holds it open. Stop the process (or the service using it) and try again.',
    EBUSY: 'The file is locked by another process. Close whatever has it open and try again.',
    EACCES: 'Permission denied. Your user may not have write access to this path.',
    EPERM: 'Operation not permitted. Your user may not have the required privileges.',
    ENOENT: 'That path no longer exists.',
    ENOSPC: 'The device is out of free space.',
    EDQUOT: 'You have exceeded your disk quota on the remote host.',
    ECONNREFUSED: 'The host refused the connection. Check the port and that the service is running.',
    ECONNRESET: 'The connection was reset by the remote host.',
    EHOSTUNREACH: 'The host is unreachable. Check the address and your network route.',
    ENETUNREACH: 'The network is unreachable.',
    ETIMEDOUT: 'The connection timed out. Check the address, port, and any firewall in between.',
    ENOTFOUND: 'That hostname could not be resolved.',
    EISDIR: 'That path is a directory, not a file.',
    ENOTDIR: 'A component of that path is not a directory.',
    ENOTEMPTY: 'The directory is not empty.'
};

// Node throws on an unhandled 'error' event. ssh2 channels, sftp handles and
// their stderr streams all emit one; every listener site must claim it.
function guardStream(stream, context) {
    if (!stream || typeof stream.on !== 'function') return stream;
    try {
        stream.on('error', err => record('stream', err, context));
        if (stream.stderr && typeof stream.stderr.on === 'function') {
            stream.stderr.on('error', err => record('stream.stderr', err, context));
        }
    } catch (e) { record('guard', e, context); }
    return stream;
}

function safeWrite(stream, data) {
    if (!stream || stream.destroyed || stream.writableEnded) return false;
    try { stream.write(data); return true; }
    catch (e) { record('write', e); return false; }
}

function attempt(fn, context) {
    try { return fn(); }
    catch (e) { record('attempt', e, context); return undefined; }
}

let notifying = false;
let notifyTimer = null;

function reportFatal(err, context) {
    // record() must never be the thing that throws: a reason with a throwing getter or a null prototype would escape the listener before preventDefault,…
    try { record('fatal', err, context); }
    catch (e) { try { console.error('[fatal] unprintable error', e); } catch (e2) {} }

    if (notifying) return;
    notifying = true;

    const release = () => { clearTimeout(notifyTimer); notifyTimer = null; notifying = false; };
    // The dialog only settles on a click or a key press.
    notifyTimer = setTimeout(release, 30000);

    let text;
    try { text = describe(err); } catch (e) { text = 'An unprintable error occurred.'; }

    try {
        const p = require('./dialog').notify(
            'Something went wrong, but the app is still running.\n\n' + text,
            { kind: 'error', title: 'Unexpected error' }
        );
        if (p && typeof p.then === 'function') p.then(release, release);
        else release();
    } catch (e) { release(); }
}

// The SFTP pane and the sidebar handle their own drops, but the terminal, tab strip and toolbars have no handler — so a file dropped there fell…
function installDropGuard() {
    const swallow = e => {
        if (e.defaultPrevented) return;      // a real drop zone already took it
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', swallow, false);
    window.addEventListener('drop', swallow, false);
}

function install() {
    installDropGuard();
    // Drop derived keys and passphrases from memory on the way out.
    window.addEventListener('beforeunload', () => {
        try { require('./store').lockVault(); } catch (e) {}
    });
    window.addEventListener('error', e => {
        try {
            if (e.error) { reportFatal(e.error, 'window.onerror'); e.preventDefault(); }
            else record('window', new Error(e.message || 'script error'), e.filename || '');
        } catch (inner) { try { console.error('[errors] handler failed', inner); } catch (e2) {} }
    });
    window.addEventListener('unhandledrejection', e => {
        try { reportFatal(e.reason, 'unhandledrejection'); e.preventDefault(); }
        catch (inner) { try { console.error('[errors] handler failed', inner); } catch (e2) {} }
    });
    try {
        process.on('uncaughtException', err => reportFatal(err, 'renderer uncaughtException'));
        process.on('unhandledRejection', err => reportFatal(err, 'renderer unhandledRejection'));
    } catch (e) { record('install', e); }
}

module.exports = { install, record, describe, guardStream, safeWrite, attempt, reportFatal };
