// Pasting multi-line text, and keeping the remote PTY's size in step with the
// terminal's. Both are about what the far side is told, so they live together.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const tabsSrc = fs.readFileSync(path.join(ROOT, 'src/tabs.js'), 'utf8');
const gridSrc = fs.readFileSync(path.join(ROOT, 'src/grid.js'), 'utf8');

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

const CR = String.fromCharCode(13), LF = String.fromCharCode(10), ESC = String.fromCharCode(27);

// --- pasting ---
// A Windows clipboard ends every line with CRLF. Sent to a shell as-is that is
// two newlines, so a pasted block of commands ran an empty command between
// each one — the blank prompt lines the user saw.

const mkPaste = () => {
    const sent = [];
    const F = new Function('writeInput',
        grab(tabsSrc, 'normalizePaste') + '\n' + grab(tabsSrc, 'pasteText') +
        ';return {normalizePaste,pasteText};'
    )((tab, d) => sent.push(d));
    return { F, sent };
};
const mkTab = bracketed => ({
    id: 'a', stream: {}, term: { modes: { bracketedPasteMode: !!bracketed } }
});

t('CRLF line endings become a single carriage return', () => {
    const { F } = mkPaste();
    return F.normalizePaste('iptables -L' + CR + LF + 'iptables -S' + CR + LF) === 'iptables -L' + CR + 'iptables -S' + CR;
});
t('bare LF line endings become a carriage return too', () => {
    const { F } = mkPaste();
    return F.normalizePaste('a' + LF + 'b') === 'a' + CR + 'b';
});
t('a lone CR is left alone rather than doubled', () => {
    const { F } = mkPaste();
    return F.normalizePaste('a' + CR + 'b') === 'a' + CR + 'b';
});
t('no newline survives normalization, so no empty command is run between lines', () => {
    const { F } = mkPaste();
    const out = F.normalizePaste(['one', 'two', 'three'].join(CR + LF));
    return out.indexOf(LF) === -1 && out.split(CR).length === 3;
});
t('a paste with no trailing newline does not gain one', () => {
    const { F } = mkPaste();
    return F.normalizePaste('sudo reboot') === 'sudo reboot';
});
t('empty and null clipboards are ignored', () => {
    const { F, sent } = mkPaste();
    F.pasteText(mkTab(), '');
    F.pasteText(mkTab(), null);
    return sent.length === 0 && F.normalizePaste(null) === '';
});
t('a disconnected tab is not written to', () => {
    const { F, sent } = mkPaste();
    F.pasteText({ id: 'a', term: { modes: {} } }, 'ls');
    return sent.length === 0;
});
t('text is pasted verbatim when the program has not asked for bracketed paste', () => {
    const { F, sent } = mkPaste();
    F.pasteText(mkTab(false), 'a' + CR + LF + 'b');
    return sent.join() === 'a' + CR + 'b';
});
t('bracketed paste is wrapped when the program asked for the mode', () => {
    const { F, sent } = mkPaste();
    F.pasteText(mkTab(true), 'a' + CR + LF + 'b');
    return sent.join() === ESC + '[200~a' + CR + 'b' + ESC + '[201~';
});
t('the wrapped text is still normalized inside the brackets', () => {
    const { F, sent } = mkPaste();
    F.pasteText(mkTab(true), 'a' + CR + LF + 'b');
    return sent[0].indexOf(LF) === -1;
});
t('pasting goes through writeInput, so a stalled session drops it instead of replaying it later', () =>
    /writeInput\(tab, on \?/.test(grab(tabsSrc, 'pasteText')));
t('right-clicking a terminal pastes rather than writing the clipboard raw', () => {
    const fn = grab(tabsSrc, 'buildTerminalView');
    return /pasteText\(tab, clipboard\.readText\(\)\)/.test(fn) && !/stream\.write\(t\)/.test(fn);
});
t('Paste All sends pasted text through the paste path, not the keystroke path', () =>
    /g\.pasteToTargets\(t\)/.test(gridSrc) && /pasteToTargets: text =>/.test(gridSrc));
t('typed keys in interactive mode still go out verbatim', () =>
    /g\.broadcast\(data\)/.test(gridSrc));

// --- keeping the PTY size in step ---
// xterm and the PTY must resize together: a terminal resized without a SIGWINCH
// leaves tmux drawing for the old geometry, so its status line lands on a row
// that is no longer displayed.

const mkSync = () => {
    const sent = [];
    const syncWindow = new Function('errors', grab(tabsSrc, 'syncWindow') + ';return syncWindow;')({ record() {} });
    const tab = { id: 'a', title: 'srv', term: { rows: 24, cols: 80 }, stream: { setWindow: (r, c) => sent.push(r + 'x' + c) } };
    return { syncWindow, tab, sent };
};

t('the first fit tells the remote its size', () => {
    const { syncWindow, tab, sent } = mkSync();
    syncWindow(tab);
    return sent.join() === '24x80';
});
t('an unchanged size is not sent again, so a live drag does not flood SIGWINCH', () => {
    const { syncWindow, tab, sent } = mkSync();
    syncWindow(tab); syncWindow(tab); syncWindow(tab);
    return sent.length === 1;
});
t('every real size change is sent', () => {
    const { syncWindow, tab, sent } = mkSync();
    syncWindow(tab);
    tab.term.rows = 30; syncWindow(tab);
    tab.term.cols = 120; syncWindow(tab);
    return sent.join() === '24x80,30x80,30x120';
});
t('a size that returns to a previous one is still sent', () => {
    const { syncWindow, tab, sent } = mkSync();
    syncWindow(tab);
    tab.term.rows = 30; syncWindow(tab);
    tab.term.rows = 24; syncWindow(tab);
    return sent.length === 3;
});
t('a collapsed terminal is never reported as zero rows', () => {
    const { syncWindow, tab, sent } = mkSync();
    tab.term.rows = 0; syncWindow(tab);
    return sent.length === 0;
});
t('a tab with no stream yet is skipped', () => {
    const { syncWindow, sent } = mkSync();
    syncWindow({ id: 'a', term: { rows: 24, cols: 80 } });
    return sent.length === 0;
});
t('a stream that cannot resize is skipped rather than throwing', () => {
    const { syncWindow, sent } = mkSync();
    syncWindow({ id: 'a', term: { rows: 24, cols: 80 }, stream: {} });
    return sent.length === 0;
});
t('a setWindow that throws is recorded, not propagated', () => {
    const syncWindow = new Function('errors', grab(tabsSrc, 'syncWindow') + ';return syncWindow;')({ record() {} });
    syncWindow({ id: 'a', title: 's', term: { rows: 24, cols: 80 }, stream: { setWindow() { throw new Error('gone'); } } });
    return true;
});
t('fitting a tab always syncs the size', () => {
    const fn = grab(tabsSrc, 'fitTerminalTab');
    return /fitAddon\.fit\(\);/.test(fn) && /syncWindow\(tab\);/.test(fn);
});
t('a grid pane is never resized without the remote hearing about it', () => {
    const fn = grab(gridSrc, 'fitTab');
    return /fitAddon\.fit\(\)/.test(fn) && /tabsMod\(\)\.syncWindow\(t\)/.test(fn);
});
t('the shell is opened at the size the terminal already is', () => {
    const fn = grab(tabsSrc, 'connectTerminalTab');
    return /rows: startRows, cols: startCols/.test(fn) && /term: 'xterm-256color'/.test(fn);
});
t('a fresh stream records the size it was opened with, so the first fit is not skipped', () => {
    const fn = grab(tabsSrc, 'connectTerminalTab');
    return /tab\._win = \{ rows: startRows, cols: startCols \}/.test(fn);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
