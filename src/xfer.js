
const { Client } = require('ssh2');
const S = require('./store');
const errors = require('./errors');
const { buildConnectConfig } = require('./terminal');

// SFTP used to borrow the session's own connection, so a large transfer queued
// megabytes of file data on the same transport carrying keystrokes and the
// metrics poll — the terminal froze until the upload finished. A second
// connection gives transfers their own pipe, and the shell stops competing.
//
// Both supported auth types (password, private key) are non-interactive, so the
// extra connection authenticates silently with the credentials already stored.
const CONNECT_TIMEOUT = 25000;
// Long enough to survive a pause between transfers, short enough that idle tabs
// do not each hold a second session open on the server indefinitely.
const IDLE_MS = 5 * 60 * 1000;
// A server that refuses a second session (MaxSessions, MaxStartups, a licence
// limit) should not be asked again on every keystroke of the file browser.
const RETRY_AFTER_MS = 60 * 1000;

function sftpMod() { return require('./sftp'); }

function busy(tab) {
    try { return sftpMod().hasActiveTransfers(tab.id); }
    catch (e) { return false; }
}

function touch(tab) {
    const st = tab._xfer;
    if (!st) return;
    clearTimeout(st.idle);
    st.idle = setTimeout(() => {
        if (!tab._xfer) return;
        // Never drop the connection out from under a running transfer.
        if (busy(tab)) return touch(tab);
        closeFor(tab);
    }, IDLE_MS);
}

function closeFor(tab) {
    const st = tab && tab._xfer;
    if (!st) return;
    tab._xfer = null;
    clearTimeout(st.idle);
    st.dead = true;
    // Channels opened on this client die with it; anything holding one sees its
    // own 'close' and marks itself dead.
    if (tab.sftp && tab.sftp._sshellXfer) tab.sftp = null;
    try { st.client.end(); } catch (e) {}
    try { if (typeof st.client.destroy === 'function') st.client.destroy(); } catch (e) {}
}

function fallbackTo(tab, waiters, err, host) {
    if (err) errors.record('xfer.connect', err, host || '');
    tab._xferRetryAfter = Date.now() + RETRY_AFTER_MS;
    waiters.forEach(w => { try { w(null, tab.client, false); } catch (e) { errors.record('xfer.waiter', e); } });
}

function connect(tab, cb) {
    const cfg = S.getSession(tab.configId);
    if (!cfg) return fallbackTo(tab, [cb], null);

    let config;
    try { config = buildConnectConfig(cfg); }
    catch (e) { return fallbackTo(tab, [cb], e, cfg.host); }

    // The host key is already trusted from the session's own connection, so the
    // verifier matches silently rather than prompting a second time.
    const client = new Client();
    const st = { client, connecting: true, ready: false, dead: false, waiters: [cb], idle: null };
    tab._xfer = st;

    let settled = false;
    const finish = err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        st.connecting = false;
        const waiters = st.waiters;
        st.waiters = [];
        if (err) {
            st.dead = true;
            if (tab._xfer === st) tab._xfer = null;
            try { client.end(); } catch (e) {}
            return fallbackTo(tab, waiters, err, cfg.host);
        }
        st.ready = true;
        touch(tab);
        waiters.forEach(w => { try { w(null, client, true); } catch (e) { errors.record('xfer.waiter', e); } });
    };

    const timer = setTimeout(() => finish(new Error('Timed out opening a transfer connection.')), CONNECT_TIMEOUT);

    client.on('ready', () => finish(null));
    client.on('error', e => {
        if (!settled) return finish(e);
        // It died after being handed out. Drop it; the next request reconnects.
        st.dead = true;
        if (tab._xfer === st) tab._xfer = null;
        errors.record('xfer.client', e, cfg.host);
    });
    client.on('close', () => {
        st.dead = true;
        if (tab._xfer === st) tab._xfer = null;
    });

    try { client.connect(config); }
    catch (e) { finish(e); }
}

// cb(err, client, dedicated) — `dedicated` is false when this fell back to the
// session's own connection, which callers use to throttle themselves.
function clientFor(tab, cb) {
    if (!tab || tab.closed || !tab.client || !tab.connected) {
        return cb(new Error('Not connected. Open the session tab first.'));
    }

    const st = tab._xfer;
    if (st && st.ready && !st.dead) { touch(tab); return cb(null, st.client, true); }
    if (st && st.connecting) { st.waiters.push(cb); return; }
    if (tab._xferRetryAfter && Date.now() < tab._xferRetryAfter) return cb(null, tab.client, false);

    connect(tab, cb);
}

module.exports = { clientFor, closeFor, touch, IDLE_MS, RETRY_AFTER_MS, CONNECT_TIMEOUT };
