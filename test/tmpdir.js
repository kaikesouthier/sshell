// Files opened with "Open with…" are copies of remote configs and keys. Where
// they land on disk, and when they are removed, is a security question: the old
// path was os.tmpdir()/sshell/<tab id> with a clock-derived id, which another
// local account could pre-create or symlink.
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src/sftp.js'), 'utf8');

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

let pass = 0, fail = 0;
const t = (n, c) => {
    try {
        const r = c();
        if (r === true) { pass++; console.log('  ok   ' + n); }
        else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
    } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

const H = new Function('fs', 'path', 'os', 'errors',
    grab('tempDirFor') + '\n' + grab('removeTempDir') + ';return { tempDirFor, removeTempDir };'
)(fs, path, os, { record() {} });

const made = [];
const mkTab = () => ({ id: 'tab-' + Date.now(), _watchers: [] });

t('the directory is created and usable', () => {
    const tab = mkTab();
    const dir = H.tempDirFor(tab); made.push(dir);
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
});
t('the name is not derived from the tab id, so it cannot be guessed ahead of time', () => {
    const tab = mkTab();
    const dir = H.tempDirFor(tab); made.push(dir);
    return dir.indexOf(tab.id) === -1;
});
t('two tabs never share a directory', () => {
    const a = H.tempDirFor(mkTab()), b = H.tempDirFor(mkTab());
    made.push(a, b);
    return a !== b;
});
t('the same tab keeps its directory across files', () => {
    const tab = mkTab();
    const first = H.tempDirFor(tab); made.push(first);
    return H.tempDirFor(tab) === first;
});
t('a directory deleted underneath us is recreated rather than returned dead', () => {
    const tab = mkTab();
    const first = H.tempDirFor(tab);
    fs.rmSync(first, { recursive: true, force: true });
    const second = H.tempDirFor(tab); made.push(second);
    return second !== first && fs.existsSync(second);
});
t('it sits under the OS temp directory', () => {
    const tab = mkTab();
    const dir = H.tempDirFor(tab); made.push(dir);
    return path.dirname(dir) === fs.realpathSync(os.tmpdir()) || dir.startsWith(os.tmpdir());
});
if (process.platform !== 'win32') {
    t('nobody else can read it', () => {
        const tab = mkTab();
        const dir = H.tempDirFor(tab); made.push(dir);
        return (fs.statSync(dir).mode & 0o077) === 0;
    });
}

t('closing a tab removes the directory and everything in it', () => {
    const tab = mkTab();
    const dir = H.tempDirFor(tab);
    fs.writeFileSync(path.join(dir, 'secrets.conf'), 'token=abc');
    H.removeTempDir(tab);
    return !fs.existsSync(dir) && tab._tmpDir === null;
});
t('removing twice is harmless', () => {
    const tab = mkTab();
    H.tempDirFor(tab);
    H.removeTempDir(tab); H.removeTempDir(tab);
    return true;
});
t('a tab that never opened a file has nothing to remove', () => {
    H.removeTempDir(mkTab()); H.removeTempDir(null);
    return true;
});

// The important one: an edit that never reached the server is deliberately kept,
// and the failure dialog points at that exact path. Removing the directory
// because the tab closed would destroy the user's unsaved work.
t('an edit still waiting to upload keeps its local copy when the tab closes', () => {
    const fn = grab('onTabClosed');
    return /const stopped = stopWatchers\(tab\);/.test(fn) && /if \(!stopped\.length\) removeTempDir\(tab\)/.test(fn);
});
t('stopWatchers reports what it stranded, rather than always looking empty', () => {
    const fn = grab('stopWatchers');
    return /tab\._watchers = \[\];/.test(fn) && /return stranded;/.test(fn);
});
t('a save still uploading, queued, or inside the debounce counts as stranded', () => {
    const fn = grab('stopWatchers');
    return /if \(w\.debounce \|\| w\.uploading \|\| w\.pending\) stranded\.push\(w\)/.test(fn);
});
t('the old guessable path is gone', () =>
    src.indexOf("path.join(os.tmpdir(), 'sshell', String(tab.id))") === -1 && /mkdtempSync/.test(src));

made.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
