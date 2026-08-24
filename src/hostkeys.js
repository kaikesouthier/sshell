
const crypto = require('crypto');
const paths = require('./paths');
const safefile = require('./safefile');

// Trust-on-first-use host key store.
let store = null;

function file() { return require('path').join(paths.getDataDir(), 'known_hosts.json'); }

function load() {
    if (store) return store;
    try {
        const parsed = JSON.parse(safefile.readWithBackup(file()).text);
        store = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) { store = {}; }
    return store;
}

function persist() {
    try { safefile.writeAtomic(file(), JSON.stringify(load(), null, 2), { mode: 0o600 }); return true; }
    catch (e) { require('./errors').record('hostkeys.save', e); return false; }
}

const idFor = (host, port) => String(host).toLowerCase() + ':' + (port || 22);

// OpenSSH-style: SHA256:<base64 of the digest, padding stripped>.
function fingerprint(keyBlob) {
    return 'SHA256:' + crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '');
}

// A host key blob is length-prefixed strings; the first is the algorithm name.
function algorithmOf(keyBlob) {
    try {
        if (!Buffer.isBuffer(keyBlob) || keyBlob.length < 8) return 'unknown';
        const len = keyBlob.readUInt32BE(0);
        if (len <= 0 || len > 64 || keyBlob.length < 4 + len) return 'unknown';
        const name = keyBlob.slice(4, 4 + len).toString('ascii');
        return /^[\x20-\x7e]+$/.test(name) ? name : 'unknown';
    } catch (e) { return 'unknown'; }
}

function isKnown(host, port) { return !!load()[idFor(host, port)]; }
function get(host, port) { return load()[idFor(host, port)] || null; }

function remember(host, port, keyBlob) {
    const s = load();
    s[idFor(host, port)] = {
        algorithm: algorithmOf(keyBlob),
        fingerprint: fingerprint(keyBlob),
        addedAt: new Date().toISOString()
    };
    persist();
}

function forget(host, port) {
    const s = load();
    delete s[idFor(host, port)];
    persist();
}

// Called by ssh2 mid-handshake. Must eventually call verify(true|false); the
// connection is held open until it does.
function verify(host, port, keyBlob, verifyCb) {
    const dialog = require('./dialog');
    const errors = require('./errors');
    let fp, alg;
    try { fp = fingerprint(keyBlob); alg = algorithmOf(keyBlob); }
    catch (e) { errors.record('hostkeys.verify', e); return verifyCb(false); }

    const known = get(host, port);
    const label = host + (port && port !== 22 ? ':' + port : '');

    if (known && known.fingerprint === fp) return verifyCb(true);

    if (known) {
        // Changed key. This is either a legitimate rebuild or an active
        // interception; refuse by default and make the user choose explicitly.
        dialog.confirm(
            'The host key for ' + label + ' has CHANGED.\n\n' +
            'Expected:\n  ' + known.fingerprint + '  (' + known.algorithm + ')\n' +
            'Received:\n  ' + fp + '  (' + alg + ')\n\n' +
            'This happens after a legitimate server rebuild — but it is also exactly what an ' +
            'interception attack looks like. If you were not expecting it, refuse: continuing ' +
            'sends your password to whoever is answering.',
            // Trusting must be the deliberate choice. Escape, the backdrop and
            // Cancel all resolve false, so anything except an explicit click
            // has to mean refuse — the opposite wiring silently pinned an
            // attacker's key whenever the user dismissed the warning.
            { danger: true, okLabel: 'Trust the new key', cancelLabel: 'Refuse (safe)', title: 'Host key changed' }
        ).then(trust => {
            if (!trust) return verifyCb(false);
            remember(host, port, keyBlob);
            verifyCb(true);
        }, e => { errors.record('hostkeys.prompt', e); verifyCb(false); });
        return;
    }

    dialog.confirm(
        'First connection to ' + label + '.\n\n' +
        'Fingerprint:\n  ' + fp + '\n  (' + alg + ')\n\n' +
        'Check this against the fingerprint shown on the server before accepting. ' +
        'Once trusted, you will be warned if it ever changes.',
        { okLabel: 'Trust and connect', cancelLabel: 'Cancel', title: 'Unknown host' }
    ).then(ok => {
        if (!ok) return verifyCb(false);
        remember(host, port, keyBlob);
        verifyCb(true);
    }, e => { errors.record('hostkeys.prompt', e); verifyCb(false); });
}

module.exports = { verify, isKnown, get, forget, fingerprint, algorithmOf };
