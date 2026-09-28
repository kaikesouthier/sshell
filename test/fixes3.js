// Covers: "Open with…" fetching a fresh copy instead of reusing the watched
// one, and Ctrl+wheel terminal zoom.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const sftpSrc = fs.readFileSync(path.join(ROOT, 'src/sftp.js'), 'utf8');
const tabsSrc = fs.readFileSync(path.join(ROOT, 'src/tabs.js'), 'utf8');

const grab = (src, n) => {
    let i = src.indexOf('function ' + n + '(');
    if (i < 0) return '';
    if (src.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
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

// --- Open with… always downloads the server's current copy ---
// A watched file's local copy dates from when it was first opened; reopening
// it within the 30-minute watch showed that stale copy, so edits made on the
// server since (another user, a deploy, a cron job) never appeared.

let log;
const tab = { id: 'tab1', closed: false, connected: true, client: {}, _watchers: [] };
const mkOpen = () => new Function(
    'fs', 'path', 'os', 'require', 'busy', 'getSftpTab', 'dialog', 'errors', 'pjoin', 'restartTtl', 'openLocalFile',
    'addTransfer', 'openTransferChannel', 'tempDirFor',
    grab(sftpSrc, 'openWithEditor') + ';return openWithEditor;'
)(
    { mkdirSync() {}, chmodSync() {} }, path, { tmpdir: () => 'T:/tmp' }, require,
    () => false, () => tab, { notify: m => log.push('notify:' + m) }, { record() {}, describe: e => String(e && e.message || e) },
    (a, b) => a.replace(/\/$/, '') + '/' + b,
    rec => { log.push('restartTtl'); return 1; },
    p => log.push('open:' + p),
    (name) => { log.push('download:' + name); return { tab: null }; },
    () => { log.push('channel'); },
    // The real one makes an unguessable directory; the path is irrelevant here.
    () => 'T:/tmp/sshell-test'
);
const openWithEditor = mkOpen();
const watcher = (over) => Object.assign({ remote: '/etc/app.conf', local: 'x', debounce: null, uploading: false, pending: false, drop() { log.push('drop'); } }, over);

t('a file not yet watched is downloaded', () => {
    log = []; tab._watchers = [];
    openWithEditor({ name: 'app.conf', size: 10 }, '/etc');
    return log.includes('download:app.conf') && !log.some(l => l.startsWith('open:'));
});
t('a file already watched is downloaded again rather than reopened from the old copy', () => {
    log = []; tab._watchers = [watcher()];
    openWithEditor({ name: 'app.conf', size: 10 }, '/etc');
    return log.indexOf('drop') === 0 && log.includes('download:app.conf') && !log.some(l => l.startsWith('open:'));
});
t('the old watch is dropped before the new download begins', () => {
    log = []; tab._watchers = [watcher()];
    openWithEditor({ name: 'app.conf', size: 10 }, '/etc');
    return log.indexOf('drop') < log.indexOf('download:app.conf');
});
t('a save still uploading keeps the local copy and reopens it', () => {
    log = []; tab._watchers = [watcher({ uploading: true })];
    openWithEditor({ name: 'app.conf', size: 10 }, '/etc');
    return !log.includes('drop') && !log.some(l => l.startsWith('download:')) && log.some(l => l.startsWith('open:')) && log.includes('restartTtl');
});
t('a save queued behind an upload keeps the local copy too', () => {
    log = []; tab._watchers = [watcher({ pending: true })];
    openWithEditor({ name: 'app.conf', size: 10 }, '/etc');
    return !log.includes('drop') && log.some(l => l.startsWith('open:'));
});
t('a save inside the debounce window keeps the local copy too', () => {
    log = []; tab._watchers = [watcher({ debounce: 1 })];
    openWithEditor({ name: 'app.conf', size: 10 }, '/etc');
    return !log.includes('drop') && log.some(l => l.startsWith('open:'));
});
t('a watch on a different remote file is left alone', () => {
    log = []; tab._watchers = [watcher({ remote: '/etc/other.conf' })];
    openWithEditor({ name: 'app.conf', size: 10 }, '/etc');
    return !log.includes('drop') && log.includes('download:app.conf');
});
t('the watcher exposes drop so a reopen can retire it', () =>
    /rec\.drop = drop;/.test(grab(sftpSrc, 'watchAndReupload')));

// --- Ctrl+wheel terminal zoom ---

const mkFont = () => {
    const config = { data: {}, saved: 0, save() { this.saved++; } };
    const RT = { tabs: [], activeTabId: null };
    const fits = [], refits = [], timers = [];
    const F = new Function('require', 'RT', 'errors', 'fitTerminalTab', 'requestAnimationFrame', 'setTimeout', 'clearTimeout',
        'let fontSaveTimer=null;const FONT_MIN = 8, FONT_MAX = 40, FONT_DEFAULT = 13;\n' +
        grab(tabsSrc, 'termFontSize') + '\n' + grab(tabsSrc, 'setTermFontSize') +
        ';return {termFontSize,setTermFontSize};'
    )(
        () => config, RT, { attempt: (fn) => fn() },
        tb => fits.push(tb.id), fn => fn(),
        (fn, ms) => { timers.push(fn); return timers.length; }, id => { if (id > 0) timers[id - 1] = null; }
    );
    return { F, config, RT, fits, refits, timers, flush: () => { timers.splice(0).forEach(fn => fn && fn()); } };
};
const mkTerm = (id, type) => ({ id, type: type || 'terminal', term: { options: { fontSize: 13 } }, grid: null });

t('the default size is 13px', () => mkFont().F.termFontSize() === 13);
t('a saved size is used', () => { const h = mkFont(); h.config.data.termFontSize = 17; return h.F.termFontSize() === 17; });
t('a saved size outside the range falls back to the default', () => {
    const h = mkFont();
    h.config.data.termFontSize = 200; const big = h.F.termFontSize();
    h.config.data.termFontSize = 'huge'; const bad = h.F.termFontSize();
    return big === 13 && bad === 13;
});
t('setting a size changes only the terminal it was asked for', () => {
    const h = mkFont();
    h.RT.tabs = [mkTerm('a'), mkTerm('b')];
    h.F.setTermFontSize(h.RT.tabs[0], 15);
    return h.RT.tabs[0].term.options.fontSize === 15 && h.RT.tabs[1].term.options.fontSize === 13;
});
t('the size is clamped to the allowed range', () => {
    const h = mkFont(); const tb = mkTerm('a');
    return h.F.setTermFontSize(tb, 2) === 8 && h.F.setTermFontSize(tb, 999) === 40;
});
t('a resized active tab is re-fit so the remote PTY learns the new grid', () => {
    const h = mkFont();
    h.RT.tabs = [mkTerm('a'), mkTerm('b')]; h.RT.activeTabId = 'b';
    h.F.setTermFontSize(h.RT.tabs[1], 14);
    return h.fits.join() === 'b';
});
t('a pane inside a grid is not fit here — the grid coalesces that itself', () => {
    const h = mkFont();
    h.RT.tabs = [mkTerm('a'), { id: 'g', type: 'grid', grid: {} }]; h.RT.activeTabId = 'g';
    h.F.setTermFontSize(h.RT.tabs[0], 14);
    return h.fits.length === 0;
});
t('the last size chosen becomes the default for new terminals, saved once per gesture', () => {
    const h = mkFont(); const tb = mkTerm('a');
    h.F.setTermFontSize(tb, 14); h.F.setTermFontSize(tb, 15); h.F.setTermFontSize(tb, 16);
    h.flush();
    return h.config.data.termFontSize === 16 && h.config.saved === 1 && h.F.termFontSize() === 16;
});
t('setting the current size is a no-op', () => {
    const h = mkFont();
    h.F.setTermFontSize(mkTerm('a'), 13);
    return h.timers.length === 0 && h.config.data.termFontSize === undefined;
});
t('a tab without a terminal is ignored', () => mkFont().F.setTermFontSize({ id: 'x' }, 20) === 13);
t('new terminals open at the shared size', () =>
    /terminal\.newTerminal\(termFontSize\(\)\)/.test(grab(tabsSrc, 'buildTerminalView')));
const has = (src, ...bits) => bits.every(b => src.includes(b));
const gridSrc = fs.readFileSync(path.join(ROOT, 'src/grid.js'), 'utf8');

t('the tab wheel handler only claims Ctrl+wheel, resizes its own tab and blocks page zoom', () => {
    const fn = grab(tabsSrc, 'buildTerminalView');
    return has(fn, "addEventListener('wheel'", 'if (!e.ctrlKey || e.altKey) return;', 'setTermFontSize(tab, ',
        'e.preventDefault(); e.stopPropagation();', 'passive: false, capture: true');
});
t('the grid claims Ctrl+wheel over a pane in the capture phase and resizes that pane only', () => {
    const i = gridSrc.indexOf("closest('.grid-cell')");
    const block = gridSrc.slice(gridSrc.lastIndexOf("addEventListener('wheel'", i), gridSrc.indexOf('capture: true', i) + 14);
    return i > 0 && has(block, 'cell.dataset.tabId', 'setTermFontSize(t, ', 'scheduleFontFit(state, t.id)',
        'e.stopPropagation()', 'passive: false, capture: true');
});
t('the grid coalesces the PTY resize per pane', () => {
    const fn = grab(gridSrc, 'scheduleFontFit');
    return has(fn, 'clearTimeout(state._fontFit.get(tabId))', 'fitTab(state, tabId)');
});
t('plain wheel over a pane still scrolls that pane, and over the background still zooms the canvas', () => {
    const i = gridSrc.indexOf("if (e.target && e.target.closest && e.target.closest('.xterm')) return;");
    const after = gridSrc.slice(i, i + 220);
    return i > 0 && has(after, 'e.preventDefault();', 'const dir = e.deltaY < 0 ? 1 : -1;', 'zoomAt(');
});
t('the shortcuts help lists Ctrl+Wheel', () => {
    const help = fs.readFileSync(path.join(ROOT, 'src/shortcuts.js'), 'utf8');
    return /\['Ctrl', 'Wheel'\]/.test(help);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
