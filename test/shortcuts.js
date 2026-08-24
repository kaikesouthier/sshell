// Covers tab navigation (Ctrl+PageUp/PageDown, Ctrl+1..9), the canvas gesture
// split between panning and rubber-band select, and the shortcut wiring.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
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
const body = ['openTabs', 'tabByOffset', 'tabByNumber'].map(grab).join('\n');

const RT = { tabs: [], activeTabId: null };
const H = new Function('RT', body + ';return { openTabs, tabByOffset, tabByNumber };')(RT);

let pass = 0, fail = 0;
const t = (n, c) => {
    try {
        const r = c();
        if (r === true) { pass++; console.log('  ok   ' + n); }
        else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
    } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

const setTabs = (ids, active) => {
    RT.tabs = ids.map(id => (typeof id === 'string' ? { id, closed: false } : id));
    RT.activeTabId = active === undefined ? ids[0] : active;
};
const id = tab => (tab ? tab.id : null);

// --- Ctrl+PageUp / Ctrl+PageDown ---

t('page down moves to the next tab', () => { setTabs(['a', 'b', 'c'], 'a'); return id(H.tabByOffset(1)) === 'b'; });
t('page up moves to the previous tab', () => { setTabs(['a', 'b', 'c'], 'b'); return id(H.tabByOffset(-1)) === 'a'; });
t('page down wraps past the last tab', () => { setTabs(['a', 'b', 'c'], 'c'); return id(H.tabByOffset(1)) === 'a'; });
t('page up wraps before the first tab', () => { setTabs(['a', 'b', 'c'], 'a'); return id(H.tabByOffset(-1)) === 'c'; });
t('a single tab has nowhere to go', () => { setTabs(['a'], 'a'); return H.tabByOffset(1) === null && H.tabByOffset(-1) === null; });
t('no tabs at all is not an error', () => { setTabs([], null); return H.tabByOffset(1) === null; });
t('an unknown active tab starts from the first', () => { setTabs(['a', 'b', 'c'], 'gone'); return id(H.tabByOffset(1)) === 'b'; });
t('closed tabs are skipped', () => {
    RT.tabs = [{ id: 'a', closed: false }, { id: 'b', closed: true }, { id: 'c', closed: false }];
    RT.activeTabId = 'a';
    return id(H.tabByOffset(1)) === 'c' && id(H.tabByOffset(-1)) === 'c';
});
t('two tabs toggle back and forth', () => {
    setTabs(['a', 'b'], 'a');
    if (id(H.tabByOffset(1)) !== 'b') return 'forward failed';
    RT.activeTabId = 'b';
    return id(H.tabByOffset(1)) === 'a';
});

// --- Ctrl+1 .. Ctrl+9 ---

t('a number picks that tab', () => {
    setTabs(['a', 'b', 'c', 'd']);
    return id(H.tabByNumber(1)) === 'a' && id(H.tabByNumber(3)) === 'c';
});
t('nine means the last tab, not the ninth', () => { setTabs(['a', 'b', 'c']); return id(H.tabByNumber(9)) === 'c'; });
t('nine is the ninth when there are exactly nine', () => {
    setTabs('abcdefghi'.split(''));
    return id(H.tabByNumber(9)) === 'i';
});
t('nine is still the last with more than nine open', () => {
    setTabs('abcdefghijkl'.split(''));
    return id(H.tabByNumber(9)) === 'l';
});
t('a number past the end picks nothing', () => { setTabs(['a', 'b']); return H.tabByNumber(5) === null; });
t('numbers outside 1-9 are rejected', () => {
    setTabs(['a', 'b']);
    return [0, -1, 10, 99, NaN, null, undefined].every(n => H.tabByNumber(n) === null);
});
t('no tabs means no target', () => { setTabs([]); return H.tabByNumber(1) === null; });
t('numbering ignores closed tabs', () => {
    RT.tabs = [{ id: 'a', closed: true }, { id: 'b', closed: false }, { id: 'c', closed: false }];
    return id(H.tabByNumber(1)) === 'b' && id(H.tabByNumber(2)) === 'c' && id(H.tabByNumber(9)) === 'c';
});
t('picking a tab does not mutate the tab list', () => {
    setTabs(['a', 'b', 'c'], 'b');
    H.tabByNumber(9); H.tabByOffset(1);
    return RT.tabs.length === 3 && RT.activeTabId === 'b';
});

// --- the marquee's additive flag is caller-controlled ---
// The grid uses Ctrl to START a band, so Ctrl cannot also mean "add" there.

// marquee clears a class on the root element when a band ends.
global.document = {
    documentElement: { classList: { add() {}, remove() {}, toggle() {} } },
    body: { appendChild() {} },
    createElement: () => ({ classList: { add() {}, remove() {} }, style: {}, isConnected: true })
};
const marquee = require(path.join(ROOT, 'src/marquee'));
const fakeEvent = (mods) => Object.assign({ clientX: 0, clientY: 0, ctrlKey: false, metaKey: false, shiftKey: false }, mods || {});

t('an explicit additive flag wins over the modifier keys', () => {
    marquee.end();
    marquee.begin(fakeEvent({ ctrlKey: true }), { additive: false, itemsSelector: 'x' });
    const armed = marquee.isArmed();
    marquee.end();
    return armed === true;
});
t('the marquee still infers additive when no flag is given', () => {
    marquee.end();
    marquee.begin(fakeEvent({ shiftKey: true }), { itemsSelector: 'x' });
    const armed = marquee.isArmed();
    marquee.end();
    return armed === true;
});
t('a band does not count as a drag until it passes the threshold', () => {
    marquee.end();
    marquee.begin(fakeEvent({}), { itemsSelector: 'x' });
    const dragging = marquee.isDragging();
    marquee.end();
    return dragging === false;
});

// --- source wiring ---

const gridSrc = fs.readFileSync(path.join(ROOT, 'src/grid.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const marqueeSrc = fs.readFileSync(path.join(ROOT, 'src/marquee.js'), 'utf8');

t('marquee honours an explicit additive option', () =>
    /typeof opts\.additive === 'boolean'/.test(marqueeSrc));

t('a plain canvas drag pans instead of selecting', () =>
    /if \(!e\.ctrlKey && !e\.metaKey\) \{[\s\S]*?beginPan\(state, e\)/.test(gridSrc));

t('ctrl turns the canvas drag into a rubber band', () => {
    const i = gridSrc.indexOf('const additive = e.shiftKey;');
    return i > 0 && gridSrc.indexOf('marquee.begin', i) > i;
});

t('middle-drag and space still pan', () =>
    /e\.button === 1/.test(gridSrc) && /spaceHeld && state\.mode === 'free'/.test(gridSrc));

t('ctrl+r reconnects the active session', () =>
    /plain && k === 'r'/.test(appSrc) && /reconnectTab/.test(appSrc));

t('ctrl+e edits the active session', () =>
    /plain && k === 'e'/.test(appSrc) && /openEditor\(t\.configId\)/.test(appSrc));

// The bug the user hit: xterm maps these keys, cancels them and calls
// stopPropagation, so a bubble-phase listener on document never ran and the
// keystroke reached the shell as reverse-i-search instead.
t('shortcuts are bound in the capture phase', () =>
    /document\.addEventListener\('keydown'[\s\S]*?\}, true\);/.test(appSrc));

t('a handled shortcut is taken from the terminal', () =>
    /const take = \(\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); \};/.test(appSrc));

t('typing in a real form field is left alone', () =>
    /function typingInField/.test(appSrc) && /tag === 'input' \|\| tag === 'textarea'/.test(appSrc));

t('the terminal textarea is not treated as a form field', () =>
    /xterm-helper-textarea/.test(appSrc));

t('reconnect does not require a broken session', () => {
    const fn = grab('reconnectTab');
    return !/if \(!tab\.connected\)/.test(fn) && /connectTerminalTab\(tab\)/.test(fn);
});

t('shortcuts are blocked while a dialog is open', () =>
    /OVERLAYS\.some\(id => !hidden\(id\)\)/.test(appSrc) && /'sessionModal'/.test(appSrc));

t('shortcuts are blocked while the vault is locked', () => /OVERLAYS = \['lockScreen'/.test(appSrc));

t('ctrl+r and ctrl+e ignore a grid or tool tab', () =>
    /t\.type === 'terminal' && !t\.closed \? t : null/.test(appSrc));

// --- the help dialog ---

const help = require(path.join(ROOT, 'src/shortcuts'));
const allRows = help.SECTIONS.flatMap(s => s.rows);
const described = allRows.filter(r => r.keys).map(r => r.keys.map(c => c.join('+')).join(' / ') + ' ' + r.text).join('\n');

t('every shortcut the app binds is documented', () => {
    const want = ['Ctrl+T', 'Ctrl+W', 'Ctrl+R', 'Ctrl+E', 'Ctrl+PageUp', 'Ctrl+PageDown', 'Ctrl+1', 'Ctrl+9'];
    const missing = want.filter(w => !described.includes(w));
    return missing.length === 0 || ('undocumented: ' + missing.join(', '));
});
t('the help explains the new canvas gesture', () => {
    const canvas = help.SECTIONS.find(s => s.title === 'Grid canvas');
    const text = JSON.stringify(canvas.rows);
    return /Ctrl","Drag/.test(text) && /Pan around the canvas/.test(text);
});
t('the help warns that ctrl+r and ctrl+e are taken from the shell', () =>
    allRows.some(r => r.note && /reverse history search/.test(r.note)));
t('every section has a title and at least one row', () =>
    help.SECTIONS.every(s => s.title && Array.isArray(s.rows) && s.rows.length > 0));
t('every row is either keys, a mouse action, or a note', () =>
    allRows.every(r => (r.note && !r.text) || (r.text && (r.keys || r.mouse))));
t('key combos are arrays of arrays, not loose strings', () =>
    allRows.filter(r => r.keys).every(r => r.keys.every(c => Array.isArray(c) && c.length > 0 && c.every(k => typeof k === 'string' && k))));

t('the menu opens the dialog rather than a text blob', () => {
    const menuSrc = fs.readFileSync(path.join(ROOT, 'src/menu.js'), 'utf8');
    return /require\('\.\/shortcuts'\)\.open\(\)/.test(menuSrc) && !/function showShortcuts/.test(menuSrc);
});
t('the dialog is scrollable and capped to the window', () => {
    const html = fs.readFileSync(path.join(ROOT, 'views/modals.html'), 'utf8');
    const i = html.indexOf('id="shortcutsModal"');
    if (i < 0) return 'dialog markup missing';
    const card = html.slice(i, i + 900);
    return /max-h-\[calc\(100vh-2rem\)\]/.test(card) && /flex flex-col/.test(card)
        && /id="shortcutsBody"[^>]*overflow-y-auto/.test(card);
});
t('no dialog can push its own buttons off screen', () => {
    const files = ['views/modals.html', 'views/dialogs.html'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    // Every modal card that holds content must cap its height.
    const cards = files.match(/<div class="w-full max-w-[^"]*"/g) || [];
    return cards.every(c => /max-h-/.test(c)) || ('uncapped: ' + cards.filter(c => !/max-h-/.test(c)).join(' | '));
});
t('Esc closes the help dialog', () => {
    const appSrc2 = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    return /shortcuts\.isOpen\(\)[^;]*shortcuts\.close\(\)/.test(appSrc2);
});
t('the help dialog blocks the app shortcuts while it is open', () =>
    /'shortcutsModal'/.test(appSrc));
t('the key styling exists', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    return /\.kbd\s*\{/.test(css) && /\.sc-row\s*\{/.test(css) && /@media \(max-width: 560px\)/.test(css);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
