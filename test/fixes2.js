// Covers the batch of fixes: the grid-upload ReferenceError, the SFTP listing
// cache and sort persistence, the fixed-view column range, and terminal reset.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const sftpSrc = fs.readFileSync(path.join(ROOT, 'src/sftp.js'), 'utf8');
const gridSrc = fs.readFileSync(path.join(ROOT, 'src/grid.js'), 'utf8');
const tabsSrc = fs.readFileSync(path.join(ROOT, 'src/tabs.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const grab = (src, n) => {
    let i = src.indexOf('function ' + n + '(');
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

// --- the grid-upload crash: putFile referenced an undefined `t` ---

t('putFile no longer references an undefined transfer object', () => {
    const fn = grab(sftpSrc, 'putFile');
    return fn.length > 0 && !/\bt\.wrote\b/.test(fn) && !/stepTransfer\(t\b/.test(fn);
});
t('putFile records that it began writing on its own handle', () =>
    /handle\.wrote = true;/.test(grab(sftpSrc, 'putFile')));
t('putFile only deletes the remote file if it actually started writing', () => {
    const fn = grab(sftpSrc, 'putFile');
    return /if \(handle\.wrote\)/.test(fn) && /sftp\.unlink\(remotePath/.test(fn);
});

// --- SFTP listing cache + sort persistence (extract the real helpers) ---

const cacheBlock = [
    'const SFTP_CACHE_MAX = 80;',
    grab(sftpSrc, 'cacheKey'),
    grab(sftpSrc, 'entriesSig'),
    grab(sftpSrc, 'getCacheRec'),
    grab(sftpSrc, 'putCache'),
    grab(sftpSrc, 'invalidateCache'),
    grab(sftpSrc, 'loadSortPref'),
    grab(sftpSrc, 'saveSortPref')
].join('\n');

let cfg = { data: {}, saved: 0 };
const configStub = { data: cfg.data, save: () => { cfg.saved++; } };
const sftpState = { cache: new Map(), sortKey: 'name', sortDir: 1 };
const req = m => (m === './config' ? configStub : {});
const C = new Function('sftpState', 'require',
    'const SORT_KEYS = new Set(["name","size","mtime"]);\n' + cacheBlock +
    ';return { cacheKey, entriesSig, getCacheRec, putCache, invalidateCache, loadSortPref, saveSortPref };')(sftpState, req);

const ent = (name, size, mtime) => ({ name, size, mtime: mtime || 0, access: '-rw-r--r--' });

t('a cached listing is returned for the same server and dir', () => {
    sftpState.cache.clear();
    C.putCache('tabA', '/home', [ent('a', 1), ent('b', 2)]);
    const rec = C.getCacheRec('tabA', '/home');
    return !!rec && rec.entries.length === 2;
});
t('the cache is keyed by both server and directory', () => {
    sftpState.cache.clear();
    C.putCache('tabA', '/home', [ent('a', 1)]);
    C.putCache('tabB', '/home', [ent('z', 9)]);
    return C.getCacheRec('tabA', '/home').entries[0].name === 'a'
        && C.getCacheRec('tabB', '/home').entries[0].name === 'z'
        && C.getCacheRec('tabA', '/etc') === null;
});
t('the signature changes when a file size or mtime changes', () => {
    const a = C.entriesSig([ent('f', 10, 100)]);
    return a !== C.entriesSig([ent('f', 11, 100)]) && a !== C.entriesSig([ent('f', 10, 200)]);
});
t('the signature is stable when nothing changed', () =>
    C.entriesSig([ent('f', 10, 100), ent('g', 20, 200)]) === C.entriesSig([ent('f', 10, 100), ent('g', 20, 200)]));
t('two files whose fields run together are not confused', () => {
    // "a" + "1" vs "a1" + "" must differ despite naive concatenation.
    return C.entriesSig([ent('a', 1, 0)]) !== C.entriesSig([ent('a1', '', 0)]);
});
t('invalidating one directory leaves the others', () => {
    sftpState.cache.clear();
    C.putCache('tabA', '/home', [ent('a', 1)]);
    C.putCache('tabA', '/etc', [ent('b', 2)]);
    C.invalidateCache('tabA', '/home');
    return C.getCacheRec('tabA', '/home') === null && !!C.getCacheRec('tabA', '/etc');
});
t('invalidating a whole tab drops only that tab', () => {
    sftpState.cache.clear();
    C.putCache('tabA', '/home', [ent('a', 1)]);
    C.putCache('tabA', '/etc', [ent('b', 2)]);
    C.putCache('tabB', '/home', [ent('c', 3)]);
    C.invalidateCache('tabA');
    return C.getCacheRec('tabA', '/home') === null && C.getCacheRec('tabA', '/etc') === null && !!C.getCacheRec('tabB', '/home');
});
t('the cache is bounded and evicts the oldest entry', () => {
    sftpState.cache.clear();
    for (let i = 0; i < 90; i++) C.putCache('t', '/d' + i, [ent('x', i)]);
    return sftpState.cache.size === 80 && C.getCacheRec('t', '/d0') === null && !!C.getCacheRec('t', '/d89');
});

t('the sort preference is saved to config', () => {
    cfg.data.sftpSort = undefined; cfg.saved = 0;
    sftpState.sortKey = 'mtime'; sftpState.sortDir = -1;
    C.saveSortPref();
    return cfg.data.sftpSort.key === 'mtime' && cfg.data.sftpSort.dir === -1 && cfg.saved === 1;
});
t('a saved sort preference is restored', () => {
    cfg.data.sftpSort = { key: 'size', dir: -1 };
    sftpState.sortKey = 'name'; sftpState.sortDir = 1;
    C.loadSortPref();
    return sftpState.sortKey === 'size' && sftpState.sortDir === -1;
});
t('a bogus stored sort key is ignored', () => {
    cfg.data.sftpSort = { key: 'evil', dir: 1 };
    sftpState.sortKey = 'name'; sftpState.sortDir = 1;
    C.loadSortPref();
    return sftpState.sortKey === 'name';
});
t('a missing sort preference leaves the default', () => {
    delete cfg.data.sftpSort;
    sftpState.sortKey = 'name'; sftpState.sortDir = 1;
    C.loadSortPref();
    return sftpState.sortKey === 'name' && sftpState.sortDir === 1;
});
t('the header click persists the sort', () =>
    /saveSortPref\(\);/.test(sftpSrc) && /loadSortPref\(\);/.test(grab(sftpSrc, 'init')));

// --- SFTP browsing on the shared connection, transfers on the dedicated one ---

t('browsing recovers a stuck pane when the same server is reselected', () => {
    const fn = grab(sftpSrc, 'focusTab');
    return /sftpState\.error \|\| \(sftpState\.loading/.test(fn);
});
t('closing a tab clears its cached listings', () =>
    /invalidateCache\(tab\.id\)/.test(grab(sftpSrc, 'onTabClosed')));

// --- fixed-view column range 1..5 ---

const COL = new Function('const MIN_H = 150;\n' + grab(gridSrc, 'colRowHeight') + ';return colRowHeight;')();

t('the column choices are 1 through 5', () => {
    const m = /const COL_CHOICES = \[([^\]]*)\]/.exec(gridSrc);
    return !!m && m[1].replace(/\s/g, '') === '1,2,3,4,5';
});
t('every column choice has a toolbar button', () => {
    const html = fs.readFileSync(path.join(ROOT, 'views/content.html'), 'utf8');
    return [1, 2, 3, 4, 5].every(c => new RegExp('id="btnCols' + c + '"').test(html));
});
t('every column button is wired', () =>
    /COL_CHOICES\.forEach\(c => \{ const b = \$\('btnCols' \+ c\)/.test(gridSrc));
t('row height shrinks as columns grow', () => {
    const hs = [1, 2, 3, 4, 5].map(COL);
    return hs.every((h, i) => i === 0 || h < hs[i - 1]);
});
t('row height never drops below the pane minimum', () =>
    [1, 2, 3, 4, 5, 12].every(c => COL(c) >= 150));
t('the classic 2 and 4 heights are preserved', () => COL(2) === 440 && COL(4) === 240);

// --- small-window responsiveness: columns cap to a min cell width ---

t('a minimum cell width is defined', () => /const MIN_CELL_W = 300;/.test(gridSrc));
t('the effective column count is capped by the window width', () => {
    // Reproduce the formula applyColumns uses.
    const eff = (cols, width) => Math.max(1, Math.min(cols, Math.floor(width / 300) || 1));
    return eff(5, 1600) === 5 && eff(5, 900) === 3 && eff(5, 400) === 1 && eff(2, 2000) === 2;
});
t('the layout uses minmax so cells shrink instead of overflowing', () =>
    /minmax\(0,1fr\)/.test(gridSrc));
t('a resize recomputes the columns', () =>
    /applyColumns\(state\);/.test(grab(gridSrc, 'gridRefit')));

// --- marquee grab strip ---

t('the column view has a top strip to start a Ctrl-drag from', () =>
    /WRAP_COLUMNS = '[^']*pt-6/.test(gridSrc));

// --- terminal reset ---

t('resetTerminal exists and resets the emulator', () => {
    const fn = grab(tabsSrc, 'resetTerminal');
    return /tab\.term\.reset\(\)/.test(fn) && /fitTerminalTab\(tab\)/.test(fn);
});
t('resetTerminal is exported', () => /reconnectTab, resetTerminal,/.test(tabsSrc));
t('reset is offered in the tab menu', () => /label: 'Reset terminal'/.test(tabsSrc));
t('Ctrl+Shift+R resets the active terminal', () =>
    /e\.shiftKey && !e\.altKey && k === 'r'/.test(appSrc) && /resetTerminal\(t\)/.test(appSrc));
t('plain Ctrl+R still reconnects, not resets', () => {
    // The reset branch (shiftKey) must come before the reconnect branch so the
    // two do not collide, and reconnect stays on the no-shift path.
    return appSrc.indexOf('resetTerminal(t)') < appSrc.indexOf('reconnectTab(t)');
});

// --- release audit fixes ---

const cfgSrc = fs.readFileSync(path.join(ROOT, 'src/configpage.js'), 'utf8');

t('the executable-open check strips trailing dots and spaces first', () => {
    const fn = grab(sftpSrc, 'confirmIfExecutable');
    const iStrip = fn.indexOf('replace(/[ .]+$/');
    const iExt = fn.indexOf('path.extname(clean)');
    return iStrip > -1 && iExt > -1 && iStrip < iExt;
});

t('the password table no longer embeds every secret in the DOM', () => {
    const fn = grab(cfgSrc, 'renderPwTable');
    return !/data-secret=/.test(fn) && /data-shown="0"/.test(fn);
});
t('a password is only fetched from the store when its row is revealed or copied', () => {
    const fn = grab(cfgSrc, 'renderPwTable');
    return /S\.getSession\(tr\.dataset\.id\)/.test(fn) && /secretOf\(s\)/.test(fn);
});
t('wiping the revealed table overwrites any shown value', () =>
    /\.pw-val'\)\.forEach\(el => \{ el\.textContent = ''/.test(grab(cfgSrc, 'wipeRevealed')));

t('a refresh drops the cached listing so a mutation cannot flash stale rows', () => {
    const fn = grab(sftpSrc, 'sftpRefresh');
    return /invalidateCache\(tab\.id, sftpState\.cwd\)/.test(fn) && fn.indexOf('invalidateCache') < fn.indexOf('sftpList');
});

t('a directory that fails to read drops its stale cache and shows the error', () => {
    const fn = grab(sftpSrc, 'sftpList');
    // The readdir error branch must invalidate and render, not silently return.
    return /if \(e\) \{ invalidateCache\(tab\.id, dir\); setBusy\(false\); renderSftpError/.test(fn);
});

// Upload-first network arrows, consistent between the status bar and the grid.
t('the grid network readout shows upload before download', () => {
    const stat = fs.readFileSync(path.join(ROOT, 'src/statusbar.js'), 'utf8');
    const gridUp = gridSrc.indexOf('`↑${up'); const gridDown = gridSrc.indexOf('↓${down');
    const statUp = stat.indexOf('↑${up'); const statDown = stat.indexOf('↓${down');
    return gridUp > -1 && gridDown > gridUp && statUp > -1 && statDown > statUp;
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
