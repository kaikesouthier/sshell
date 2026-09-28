// Runs the SFTP listing renderer for real, rather than asserting about its
// source text. A previous refactor deleted the two constants the row markup
// depends on and left the uses behind: every suite passed, the app booted
// clean, and the first directory listing against a live server threw. Nothing
// here would have survived that.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src/sftp.js'), 'utf8');

let pass = 0, fail = 0;
const t = (n, c) => {
    try {
        const r = c();
        if (r === true) { pass++; console.log('  ok   ' + n); }
        else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
    } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

// Take the module-level declarations from the source rather than supplying our
// own: if a constant the renderer needs is missing, this fails, which is the
// whole point. (Stubbing them here is what hid the bug the first time.)
const between = (from, to) => {
    const i = src.indexOf(from), j = src.indexOf(to);
    if (i < 0 || j < 0 || j < i) throw new Error('cannot find the block from "' + from + '"');
    return src.slice(i, j);
};
const grab = n => {
    const i = src.indexOf('function ' + n + '(');
    if (i < 0) throw new Error('no function ' + n);
    let d = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
        if (src[k] === '{') d++;
        else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
    throw new Error('unbalanced ' + n);
};

// Everything the render path declares at module level, verbatim.
const preamble = between('const ICO =', 'function renderSftpTable() {');

const el = () => {
    const e = {
        _html: '', dataset: {}, _cls: new Set(),
        set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
        classList: { add() {}, remove() {}, toggle() {} },
        querySelectorAll: () => [], querySelector: () => null,
        addEventListener() {}, style: {}, value: ''
    };
    return e;
};
const els = {};
const $ = id => els[id] || (els[id] = el());

const mkRender = () => {
    const state = {
        cwd: '/etc', entries: [], selected: new Set(), anchor: null,
        sortKey: 'name', sortDir: 1, byName: new Map(), loading: false
    };
    const F = new Function('$', 'escapeHtml', 'fmtMtime', 'sftpState', 'paintFileSelection',
        preamble + grab('renderSftpTable') + '\n' + grab('rowHtml') + '\n' + grab('compareEntries') + '\n' + grab('sortArrow') +
        ';return { renderSftpTable, rowHtml };'
    )($, s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        () => '2026-09-28 10:00', state, () => {});
    return { F, state };
};

const entry = (over) => Object.assign({
    name: 'nginx.conf', isDir: false, size: 2048, mtime: 1700000000,
    access: '-rw-r--r--', owner: 'root', group: 'root'
}, over);

t('a file row renders', () => {
    const { F } = mkRender();
    const html = F.rowHtml(entry(), false);
    return html.indexOf('nginx.conf') !== -1 && html.indexOf('<tr') === 0;
});
t('a directory row renders', () => {
    const { F } = mkRender();
    return F.rowHtml(entry({ name: 'sites-enabled', isDir: true }), false).indexOf('sftpIcoDir') !== -1;
});
t('the parent row renders', () => {
    const { F } = mkRender();
    return F.rowHtml(entry({ name: '..', isDir: true }), true).indexOf('data-name=".."') !== -1;
});
t('every row class is a real string, not the word undefined', () => {
    const { F } = mkRender();
    const html = F.rowHtml(entry(), false) + F.rowHtml(entry({ isDir: true }), false);
    return html.indexOf('undefined') === -1;
});
t('a whole listing renders into the pane', () => {
    const { F, state } = mkRender();
    state.entries = [entry(), entry({ name: 'ssl', isDir: true }), entry({ name: 'hosts' })];
    F.renderSftpTable();
    const html = $('sftpBody').innerHTML;
    return html.indexOf('<table') !== -1 && html.indexOf('nginx.conf') !== -1 &&
        html.indexOf('ssl') !== -1 && html.indexOf('undefined') === -1;
});
t('the icon shapes are defined once for the table, not per row', () => {
    const { F, state } = mkRender();
    state.entries = [entry(), entry({ name: 'b' }), entry({ name: 'c' })];
    F.renderSftpTable();
    const html = $('sftpBody').innerHTML;
    const defs = html.split('id="sftpIcoFile"').length - 1;
    const uses = html.split('href="#sftpIcoFile"').length - 1;
    return defs === 1 && uses === 3;
});
t('an empty directory renders a table rather than throwing', () => {
    const { F, state } = mkRender();
    state.entries = [];
    F.renderSftpTable();
    return $('sftpBody').innerHTML.indexOf('<table') !== -1;
});
t('the root directory has no parent row', () => {
    const { F, state } = mkRender();
    state.cwd = '/'; state.entries = [entry()];
    F.renderSftpTable();
    return $('sftpBody').innerHTML.indexOf('data-name=".."') === -1;
});
t('rows are indexed by name so a click does not scan the whole listing', () => {
    const { F, state } = mkRender();
    state.entries = [entry(), entry({ name: 'b' })];
    F.renderSftpTable();
    return state.byName.size === 2 && state.byName.get('b').name === 'b';
});
t('a selection for a file that is gone is dropped', () => {
    const { F, state } = mkRender();
    state.entries = [entry()];
    state.selected.add('nginx.conf'); state.selected.add('deleted.conf');
    F.renderSftpTable();
    return state.selected.has('nginx.conf') && !state.selected.has('deleted.conf');
});
t('a hostile filename cannot inject markup', () => {
    const { F, state } = mkRender();
    state.entries = [entry({ name: '<img src=x onerror=alert(1)>', owner: '"><b>', group: "'x" })];
    F.renderSftpTable();
    const html = $('sftpBody').innerHTML;
    // The payload may appear as inert text; what must never appear is a real tag
    // or a quote that escapes the attribute it sits in.
    return html.indexOf('<img') === -1 &&
        html.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1 &&
        html.indexOf('"><b>') === -1 &&
        html.indexOf('&quot;&gt;&lt;b&gt;') !== -1;
});
t('a large listing renders without blowing up', () => {
    const { F, state } = mkRender();
    state.entries = Array.from({ length: 2000 }, (_, i) => entry({ name: 'f' + i }));
    F.renderSftpTable();
    return $('sftpBody').innerHTML.split('<tr').length - 1 === 2002; // files, the parent row, the header row
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
