// Covers the two ways a busy or stalled connection used to misbehave:
//   * keystrokes queued during a hang, then replayed into the live shell
//   * a transfer saturating the transport the interactive shell shares
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const { EventEmitter } = require('events');
const src = fs.readFileSync(path.join(ROOT, 'src/tabs.js'), 'utf8');

const grab = n => {
    let i = src.indexOf('function ' + n + '(');
    if (i < 0) return '';
    let d = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
        if (src[k] === '{') d++;
        else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
    return '';
};

const body = 'const INPUT_STALL_BYTES = 4096;\n' + ['writeInput', 'killStream'].map(grab).join('\n');

let written = [], recorded = [];
const errors = {
    safeWrite: (s, d) => { if (!s || s.destroyed || s.writableEnded) return false; written.push(d); s.writableLength += d.length; return true; },
    attempt: f => { try { return f(); } catch (e) { recorded.push(e); } },
    record: e => recorded.push(e)
};
const H = new Function('errors', body + ';return { writeInput, killStream };')(errors);

// A stand-in for an ssh2 Channel: a Duplex-ish emitter with a write buffer.
function mkStream() {
    const s = new EventEmitter();
    s.writableLength = 0;
    s.destroyed = false;
    s.writableEnded = false;
    s.ended = false;
    s.destroy = () => { s.destroyed = true; };
    s.end = () => { s.ended = true; s.writableEnded = true; };
    return s;
}
function mkTab(stream) {
    const lines = [];
    return {
        stream,
        lines,
        term: { writeln: l => lines.push(l) }
    };
}

let pass = 0, fail = 0;
const t = (n, c) => {
    try {
        const r = c();
        if (r === true) { pass++; console.log('  ok   ' + n); }
        else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
    } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};
const reset = () => { written = []; recorded = []; };

// --- normal typing ---

t('ordinary keystrokes reach the shell', () => {
    reset();
    const tab = mkTab(mkStream());
    'ls -la\r'.split('').forEach(ch => H.writeInput(tab, ch));
    return written.join('') === 'ls -la\r';
});
t('typing does not warn while the channel is draining', () => {
    reset();
    const tab = mkTab(mkStream());
    H.writeInput(tab, 'x');
    return tab.lines.length === 0 && tab._inputStalled !== true;
});
t('a large paste still goes through under the threshold', () => {
    reset();
    const tab = mkTab(mkStream());
    H.writeInput(tab, 'y'.repeat(4000));
    return written.join('').length === 4000;
});

// --- a stalled channel ---

t('input is dropped once the backlog passes the threshold', () => {
    reset();
    const s = mkStream(); s.writableLength = 5000;
    const tab = mkTab(s);
    H.writeInput(tab, 'rm -rf /\r');
    return written.length === 0;
});
t('the user is told rather than left guessing', () => {
    reset();
    const s = mkStream(); s.writableLength = 5000;
    const tab = mkTab(s);
    H.writeInput(tab, 'a');
    return tab.lines.length === 1 && /stopped accepting input/.test(tab.lines[0]);
});
t('the warning appears once, not per keystroke', () => {
    reset();
    const s = mkStream(); s.writableLength = 5000;
    const tab = mkTab(s);
    for (let i = 0; i < 50; i++) H.writeInput(tab, 'a');
    return tab.lines.length === 1;
});
t('nothing typed during a stall is kept anywhere', () => {
    reset();
    const s = mkStream(); s.writableLength = 5000;
    const tab = mkTab(s);
    'shutdown now\r'.split('').forEach(ch => H.writeInput(tab, ch));
    // Draining must not resurrect it.
    s.writableLength = 0;
    s.emit('drain');
    return written.length === 0;
});
t('the session recovers when the channel drains', () => {
    reset();
    const s = mkStream(); s.writableLength = 5000;
    const tab = mkTab(s);
    H.writeInput(tab, 'a');
    s.writableLength = 0;
    s.emit('drain');
    H.writeInput(tab, 'b');
    return written.join('') === 'b' && tab._inputStalled === false;
});
t('recovery is announced only if a warning was shown', () => {
    reset();
    const s = mkStream(); s.writableLength = 5000;
    const tab = mkTab(s);
    H.writeInput(tab, 'a');
    s.writableLength = 0;
    s.emit('drain');
    return tab.lines.length === 2 && /accepted again/.test(tab.lines[1]);
});
t('a second stall warns again', () => {
    reset();
    const s = mkStream(); s.writableLength = 5000;
    const tab = mkTab(s);
    H.writeInput(tab, 'a');
    s.writableLength = 0; s.emit('drain');
    s.writableLength = 5000;
    H.writeInput(tab, 'b');
    return tab.lines.length === 3 && /stopped accepting input/.test(tab.lines[2]);
});
t('only one drain listener is armed per stall', () => {
    reset();
    const s = mkStream(); s.writableLength = 5000;
    const tab = mkTab(s);
    for (let i = 0; i < 20; i++) H.writeInput(tab, 'a');
    return s.listenerCount('drain') === 1;
});

// --- a dead channel ---

t('a destroyed channel takes no input', () => {
    reset();
    const s = mkStream(); s.destroyed = true;
    H.writeInput(mkTab(s), 'a');
    return written.length === 0;
});
t('an ended channel takes no input', () => {
    reset();
    const s = mkStream(); s.writableEnded = true;
    H.writeInput(mkTab(s), 'a');
    return written.length === 0;
});
t('a missing channel is not an error', () => {
    reset();
    H.writeInput(mkTab(null), 'a');
    return written.length === 0 && recorded.length === 0;
});

// --- teardown must discard, not flush ---
// end() flushes the queue first, which is what replayed a hang's keystrokes
// into the shell on the way out.

t('teardown destroys the channel', () => {
    const s = mkStream();
    H.killStream(s);
    return s.destroyed === true;
});
t('teardown never calls end(), which would flush the backlog', () => {
    const s = mkStream();
    s.writableLength = 5000;
    H.killStream(s);
    return s.ended === false && s.destroyed === true;
});
t('teardown drops the drain listener so it cannot fire later', () => {
    reset();
    const s = mkStream(); s.writableLength = 5000;
    H.writeInput(mkTab(s), 'a');
    H.killStream(s);
    return s.listenerCount('drain') === 0;
});
t('tearing down nothing is safe', () => { H.killStream(null); H.killStream(undefined); return true; });

// --- wiring ---

t('every teardown path discards instead of flushing', () => {
    const ends = src.match(/tab\.stream && tab\.stream\.end\(\)/g) || [];
    return ends.length === 0 || ('still flushing at ' + ends.length + ' site(s)');
});
t('the shell feeds keystrokes through the bounded path', () =>
    /term\.onData\(d => writeInput\(tab, d\)\)/.test(src));
t('a reconnected session starts unstalled', () =>
    /tab\._inputStalled = false;\s*\n\s*tab\._inputWarned = false;/.test(src));

// --- transfers must not starve the shell ---

const sftpSrc = fs.readFileSync(path.join(ROOT, 'src/sftp.js'), 'utf8');

// Transfers now get their own connection, but that can fail over to the shell's
// one — and on that path the queue must stay small or the terminal freezes.
t('a transfer sharing the shell connection stays throttled', () => {
    const m = /const XFER_SHARED = \{ concurrency: (\d+), chunkSize: (\d+) \};/.exec(sftpSrc);
    if (!m) return 'no shared transfer options defined';
    const inFlight = Number(m[1]) * Number(m[2]);
    // ssh2 defaults to 64 * 32768 = 2 MiB queued ahead of the shell's keystrokes.
    return inFlight < 2 * 1024 * 1024 || ('still ' + inFlight + ' bytes in flight');
});
t('every transfer uses the chosen options', () => {
    const raw = sftpSrc.match(/fast(?:Put|Get)\([^)]*\{\s*step:/g) || [];
    return raw.length === 0 || ('uncapped transfer sites: ' + raw.length);
});
t('every transfer call site chooses its options explicitly', () => {
    const calls = (sftpSrc.match(/\.fast(?:Put|Get)\(/g) || []).length;
    // Drop the definition, which looks exactly like a call site.
    const body = sftpSrc.replace(/function xferOpts\([^)]*\)/, '');
    const chosen = (body.match(/xferOpts\(\w+,/g) || []).length;
    return calls === chosen || (chosen + ' of ' + calls + ' call sites');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
