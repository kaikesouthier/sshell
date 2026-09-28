// SSH agent authentication and keyboard-interactive. Neither can be exercised
// against a real server here, so this covers the decisions: where the agent is
// looked for, what reaches ssh2's connect config, and who answers a server's
// questions.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const termSrc = fs.readFileSync(path.join(ROOT, 'src/terminal.js'), 'utf8');
const tabsSrc = fs.readFileSync(path.join(ROOT, 'src/tabs.js'), 'utf8');
const storeSrc = fs.readFileSync(path.join(ROOT, 'src/store.js'), 'utf8');
const editorSrc = fs.readFileSync(path.join(ROOT, 'src/editor.js'), 'utf8');
const modalsHtml = fs.readFileSync(path.join(ROOT, 'views/modals.html'), 'utf8');

const grab = (src, n) => {
    const i = src.indexOf('function ' + n + '(');
    if (i < 0) return '';
    let d = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
        if (src[k] === '{') d++;
        else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
    return '';
};

let pass = 0, fail = 0;
const t = (n, c) => {
    try {
        const r = c();
        if (r === true) { pass++; console.log('  ok   ' + n); }
        else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
    } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

// --- where the agent is looked for ---

const mkAgentTarget = (platform, env, exists) => new Function('process', 'fs',
    termSrc.slice(termSrc.indexOf('const OPENSSH_PIPE'), termSrc.indexOf('function buildConnectConfig')) +
    ';return agentTarget;'
)({ platform, env: env || {} }, { existsSync: p => !!(exists && exists(p)) });

t('an explicit socket always wins', () => {
    const f = mkAgentTarget('linux', { SSH_AUTH_SOCK: '/tmp/env.sock' });
    return f('/tmp/mine.sock') === '/tmp/mine.sock';
});
t('surrounding whitespace in the setting is ignored', () =>
    mkAgentTarget('win32')('  //./pipe/custom  ') === '//./pipe/custom');
t('on Linux it falls back to SSH_AUTH_SOCK', () =>
    mkAgentTarget('linux', { SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh' })('') === '/run/user/1000/keyring/ssh');
t('on Linux with no agent running it finds nothing, rather than guessing', () =>
    mkAgentTarget('linux', {})('') === '');
t("on Windows it prefers the OpenSSH agent's pipe when that service is running", () => {
    const f = mkAgentTarget('win32', {}, p => p.indexOf('openssh-ssh-agent') !== -1);
    return f('') === '\\\\.\\pipe\\openssh-ssh-agent';
});
t('on Windows it falls back to Pageant, which is what PuTTY and most key tools speak', () =>
    mkAgentTarget('win32', {}, () => false)('') === 'pageant');
t('a thrown existsSync does not break detection', () => {
    const f = new Function('process', 'fs',
        termSrc.slice(termSrc.indexOf('const OPENSSH_PIPE'), termSrc.indexOf('function buildConnectConfig')) + ';return agentTarget;'
    )({ platform: 'win32', env: {} }, { existsSync() { throw new Error('denied'); } });
    return f('') === 'pageant';
});

// --- what reaches ssh2 ---

const mkBuild = (platform, env, exists) => new Function('fs', 'require', 'process',
    termSrc.slice(termSrc.indexOf('const OPENSSH_PIPE'), termSrc.indexOf('module.exports')) +
    ';return buildConnectConfig;'
)(
    { readFileSync: () => 'KEYDATA', existsSync: p => !!(exists && exists(p)) },
    m => m === './hostkeys' ? { isKnown: () => true, verify: () => {} } : {},
    { platform, env: env || {} }
);
const build = mkBuild('linux', { SSH_AUTH_SOCK: '/run/agent.sock' });
const base = { host: 'h', username: 'u', port: 22 };

t('an agent session sends no password or key to ssh2', () => {
    const c = build(Object.assign({}, base, { authType: 'agent', password: 'leftover', keyPath: '/k' }));
    return c.agent === '/run/agent.sock' && c.password === undefined && c.privateKey === undefined;
});
t('a per-session agent path overrides the environment', () => {
    const c = build(Object.assign({}, base, { authType: 'agent', agentPath: '/tmp/other.sock' }));
    return c.agent === '/tmp/other.sock';
});
t('an agent session with no agent anywhere refuses with an actionable message', () => {
    const noAgent = mkBuild('linux', {});
    try { noAgent(Object.assign({}, base, { authType: 'agent' })); return 'it did not throw'; }
    catch (e) { return /No SSH agent was found/.test(e.message) && /SSH_AUTH_SOCK/.test(e.message); }
});
t('the Windows message names the things a Windows user would actually start', () => {
    const win = mkBuild('win32', {}, () => false);
    // Pageant is always reachable on Windows, so force the empty case.
    const f = new Function('fs', 'require', 'process',
        termSrc.slice(termSrc.indexOf('const OPENSSH_PIPE'), termSrc.indexOf('module.exports'))
            .replace("return 'pageant';", "return '';") + ';return buildConnectConfig;'
    )({ existsSync: () => false }, () => ({ isKnown: () => true, verify: () => {} }), { platform: 'win32', env: {} });
    try { f(Object.assign({}, base, { authType: 'agent' })); return 'it did not throw'; }
    catch (e) { return /OpenSSH Authentication Agent|Pageant/.test(e.message); }
});
t('password and key sessions are untouched by any of this', () => {
    const p = build(Object.assign({}, base, { authType: 'password', password: 'pw' }));
    const k = build(Object.assign({}, base, { authType: 'key', keyPath: '/k', passphrase: 'pp' }));
    return p.password === 'pw' && p.agent === undefined &&
        k.privateKey === 'KEYDATA' && k.passphrase === 'pp' && k.agent === undefined;
});
t('the server may only ask questions when the caller allows it', () => {
    const quiet = build(Object.assign({}, base, { authType: 'password', password: 'pw' }));
    const asking = build(Object.assign({}, base, { authType: 'password', password: 'pw' }), { interactive: true });
    return quiet.tryKeyboard === undefined && asking.tryKeyboard === true;
});
t('the session tab asks, and the transfer connection stays silent', () =>
    /buildConnectConfig\(cfg, \{ interactive: true \}\)/.test(tabsSrc) &&
    /config = buildConnectConfig\(cfg\);/.test(fs.readFileSync(path.join(ROOT, 'src/xfer.js'), 'utf8')));
t('host key verification still applies to an agent session', () => {
    const c = build(Object.assign({}, base, { authType: 'agent' }));
    return typeof c.hostVerifier === 'function';
});

// --- answering the server's questions ---

const mkAnswer = () => {
    const asked = [];
    let pending = null;
    const answerAuthPrompts = new Function('require', 'errors', 'MAX_PROMPTS', 'MAX_PROMPT_LEN',
        grab(tabsSrc, 'answerAuthPrompts') + ';return answerAuthPrompts;'
    )(
        m => m === './modal' ? { askInput: o => { asked.push(o); return new Promise(r => { pending = r; }); } } : {},
        { record() {} }, 8, 200
    );
    return { answerAuthPrompts, asked, answer: v => pending(v) };
};

t('the stored password answers the ordinary single hidden prompt, without bothering the user', () => {
    const h = mkAnswer();
    const tab = {}, cfg = { authType: 'password', password: 'secret' };
    let sent = null;
    h.answerAuthPrompts(tab, cfg, [{ prompt: 'Password:', echo: false }], v => { sent = v; });
    return sent && sent.join() === 'secret' && h.asked.length === 0;
});
t('it is offered once per attempt, so a wrong password does not loop forever', () => {
    const h = mkAnswer();
    const tab = {}, cfg = { authType: 'password', password: 'secret' };
    h.answerAuthPrompts(tab, cfg, [{ prompt: 'Password:', echo: false }], () => {});
    h.answerAuthPrompts(tab, cfg, [{ prompt: 'Password:', echo: false }], () => {});
    return h.asked.length === 1;
});
t('a second question — a 2FA code — is asked of the user', () => {
    const h = mkAnswer();
    let sent = null;
    h.answerAuthPrompts({}, { authType: 'password', password: 'secret' },
        [{ prompt: 'Password:', echo: false }, { prompt: 'Verification code:', echo: true }], v => { sent = v; });
    if (h.asked.length !== 1) return 'the user was not asked';
    const f = h.asked[0].fields;
    return f.length === 2 && f[0].type === 'password' && f[1].type === 'text' && f[1].label === 'Verification code:';
});
t('a key or agent session never sends a stored password', () => {
    const h = mkAnswer();
    h.answerAuthPrompts({}, { authType: 'agent', password: 'stale' }, [{ prompt: 'Token:', echo: false }], () => {});
    return h.asked.length === 1;
});
t('a server asking nothing is answered immediately', () => {
    const h = mkAnswer();
    let sent = null;
    h.answerAuthPrompts({}, {}, [], v => { sent = v; });
    return sent && sent.length === 0 && h.asked.length === 0;
});
t('a hostile server cannot fill the screen with prompts', () => {
    const h = mkAnswer();
    const many = Array.from({ length: 500 }, (_, i) => ({ prompt: 'q' + i, echo: true }));
    h.answerAuthPrompts({}, {}, many, () => {});
    return h.asked[0].fields.length === 8;
});
t('an absurdly long prompt is truncated', () => {
    const h = mkAnswer();
    h.answerAuthPrompts({}, {}, [{ prompt: 'x'.repeat(5000), echo: true }], () => {});
    return h.asked[0].fields[0].label.length === 200;
});
t('a prompt with no text still gets a usable label', () => {
    const h = mkAnswer();
    h.answerAuthPrompts({}, {}, [{ echo: true }], () => {});
    return h.asked[0].fields[0].label === 'Response';
});
t('a superseded connection answers nothing', () =>
    /if \(!isCurrent\(\)\) return finish\(\[\]\);/.test(tabsSrc.slice(tabsSrc.indexOf("conn.on('keyboard-interactive'"), tabsSrc.indexOf("conn.on('ready'"))));
t('each connection attempt gets one fresh go with the stored password', () =>
    /tab\._askedStored = false;/.test(grab(tabsSrc, 'connectTerminalTab')));

// --- storage and the editor ---

t('an agent session survives a vault round trip', () =>
    /authType: s\.authType === 'key' \|\| s\.authType === 'agent' \? s\.authType : 'password'/.test(storeSrc) &&
    /agentPath: s\.agentPath \|\| ''/.test(storeSrc));
t('a session saved by an older build still reads as password auth', () => {
    const normalize = /authType: s\.authType === 'key' \|\| s\.authType === 'agent' \? s\.authType : 'password'/;
    const f = new Function('s', 'return ' + normalize.exec(storeSrc)[0].replace('authType: ', ''));
    return f({}) === 'password' && f({ authType: 'nonsense' }) === 'password' && f({ authType: 'agent' }) === 'agent';
});
t('the editor offers Agent as a third choice', () =>
    /data-auth="agent"/.test(modalsHtml) && /id="authAgent"/.test(modalsHtml) && /id="fAgentPath"/.test(modalsHtml));
t('the editor refuses to save an agent session when no agent can be found', () =>
    /modalAuth === 'agent' && !require\('\.\/terminal'\)\.agentTarget/.test(editorSrc));
t('the key-file requirement does not fire for an agent session', () => {
    const fn = grab(editorSrc, 'saveEditor');
    return /modalAuth === 'key' && !\$\('fKeyPath'\)/.test(fn);
});
t('the agent path is saved and reloaded', () =>
    /agentPath: \$\('fAgentPath'\)\.value\.trim\(\)/.test(editorSrc) &&
    /\$\('fAgentPath'\)\.value = s \? \(s\.agentPath \|\| ''\) : ''/.test(editorSrc));
t('the editor tells you which agent it found', () =>
    /fAgentHint/.test(editorSrc) && /fAgentHint/.test(modalsHtml));

const ta = async (n, c) => {
    try {
        const r = await c();
        if (r === true) { pass++; console.log('  ok   ' + n); }
        else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
    } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

(async () => {
    await ta('what the user types is sent back in the order asked', async () => {
        const h = mkAnswer();
        let sent = null;
        h.answerAuthPrompts({}, { authType: 'agent' },
            [{ prompt: 'a', echo: true }, { prompt: 'b', echo: true }], v => { sent = v; });
        h.answer({ p0: 'first', p1: 'second' });
        await new Promise(r => setTimeout(r, 5));
        return !!sent && sent.join() === 'first,second';
    });
    await ta('cancelling answers nothing, so the handshake fails instead of hanging', async () => {
        const h = mkAnswer();
        let sent = 'unset';
        h.answerAuthPrompts({}, { authType: 'agent' }, [{ prompt: 'a', echo: true }], v => { sent = v; });
        h.answer(null);
        await new Promise(r => setTimeout(r, 5));
        return Array.isArray(sent) && sent.length === 0;
    });
    await new Promise(r => setTimeout(r, 20));
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})();
