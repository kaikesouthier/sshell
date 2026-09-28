
const fs = require('fs');
const { clipboard } = require('electron');
const { Terminal } = require('xterm');
const { FitAddon } = require('xterm-addon-fit');

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
            // Selection is accurate at every grid zoom now that the canvas uses
            // the CSS `zoom` property (see applyZoom in grid.js), so a selection
            // always maps to the text under the cursor and is safe to copy.
            const sel = term.getSelection();
            if (sel) clipboard.writeText(sel);
        } catch (e) { require('./errors').record('clipboard', e, 'selection copy'); }
    });
    return term;
}

// Where the SSH agent is listening. An explicit setting wins; otherwise take
// the platform's usual home. On Windows that is the OpenSSH service's named
// pipe when it exists, and Pageant (PuTTY, and what most Windows key tools
// speak) otherwise — ssh2 talks to Pageant through its own helper, so there is
// nothing for the user to configure in the common case.
const OPENSSH_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';
function agentTarget(explicit) {
    const set = (explicit || '').trim();
    if (set) return set;
    if (process.platform === 'win32') {
        try { if (fs.existsSync(OPENSSH_PIPE)) return OPENSSH_PIPE; } catch (e) {}
        return 'pageant';
    }
    return process.env.SSH_AUTH_SOCK || '';
}

// opts.interactive allows the server to ask the user questions during the
// handshake (keyboard-interactive, which is how 2FA and most PAM setups work).
// It is off by default because the second connection SFTP transfers use must
// authenticate silently — prompting twice for one click would be baffling.
function buildConnectConfig(cfg, opts) {
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
    if (opts && opts.interactive) c.tryKeyboard = true;

    if (cfg.authType === 'agent') {
        const sock = agentTarget(cfg.agentPath);
        if (!sock) {
            throw new Error(process.platform === 'win32'
                ? 'No SSH agent was found. Start the OpenSSH Authentication Agent service or run Pageant, then try again.'
                : 'No SSH agent was found — SSH_AUTH_SOCK is not set. Start ssh-agent, or set the agent socket on this session.');
        }
        c.agent = sock;
    } else if (cfg.authType === 'key' && cfg.keyPath) {
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

module.exports = { newTerminal, buildConnectConfig, agentTarget, FitAddon };
