
const fs = require('fs');
const { clipboard } = require('electron');
const { Terminal } = require('xterm');
const { FitAddon } = require('xterm-addon-fit');

// True when the grid canvas is showing at anything other than 1:1.
function canvasZoomed() {
    try {
        const g = require('./tabs').activeGrid();
        return !!g && g.getMode() === 'free' && Math.abs(g.getZoom() - 1) > 0.001;
    } catch (e) { return false; }
}

function newTerminal(fontSize) {
    const theme = require('./theme');
    const term = new Terminal({
        fontSize: fontSize || 13, fontWeight: '500', fontWeightBold: '700',
        fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Consolas, monospace',
        lineHeight: 1.2, cursorBlink: true, cursorStyle: 'bar', theme: theme.getTermTheme(),
        scrollback: 5000, allowProposedApi: true
    });

    term.onSelectionChange(() => {
        try {
            // xterm maps pointer position to a cell using screen pixels against
            // unscaled CSS metrics, so on a zoomed canvas the selection is not
            // the text under the cursor. Copying it would silently put the wrong
            // content on the clipboard.
            if (canvasZoomed()) return;
            const sel = term.getSelection();
            if (sel) clipboard.writeText(sel);
        } catch (e) { require('./errors').record('clipboard', e, 'selection copy'); }
    });
    return term;
}

function buildConnectConfig(cfg) {
    if (!cfg.host) throw new Error('This session has no host set. Edit it and add one.');
    const hostkeys = require('./hostkeys');
    const port = cfg.port || 22;
    const known = hostkeys.isKnown(cfg.host, port);
    const c = {
        host: cfg.host, port, username: cfg.username,
        // An unknown host puts a fingerprint prompt in the middle of the
        // handshake; 15s is not long enough to read and check one.
        readyTimeout: known ? 15000 : 120000,
        keepaliveInterval: 20000, keepaliveCountMax: 3,
        // Without this ssh2 accepts any key and then sends the password to it.
        hostVerifier: (keyBlob, verifyCb) => hostkeys.verify(cfg.host, port, keyBlob, verifyCb)
    };
    if (cfg.authType === 'key' && cfg.keyPath) {
        try {
            c.privateKey = fs.readFileSync(cfg.keyPath);
        } catch (e) {
            const why = e.code === 'ENOENT' ? 'it does not exist'
                : e.code === 'EACCES' || e.code === 'EPERM' ? 'permission was denied'
                : e.message;
            throw new Error('Could not read the private key at ' + cfg.keyPath + ' — ' + why + '.');
        }
        if (cfg.passphrase) c.passphrase = cfg.passphrase;
    } else {
        c.password = cfg.password;
    }
    return c;
}

module.exports = { newTerminal, buildConnectConfig, FitAddon };
