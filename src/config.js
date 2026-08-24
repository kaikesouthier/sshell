
const paths = require('./paths');
const safefile = require('./safefile');

const C = { data: { theme: null }, loadFailed: false };

C.load = function () {
    C.loadFailed = false;
    try {
        const p = JSON.parse(safefile.readWithBackup(paths.configPath()).text);
        C.data = (p && typeof p === 'object' && !Array.isArray(p)) ? p : { theme: null };
    } catch (e) {
        C.data = { theme: null };
        // "File not there yet" is normal on first run.
        if (e.code !== 'ENOENT') {
            C.loadFailed = true;
            console.error('config load failed; refusing to overwrite', e);
        }
    }
    if (typeof C.data.theme === 'undefined') C.data.theme = null;
};

C.save = function () {
    if (C.loadFailed) return false;
    try { safefile.writeAtomic(paths.configPath(), JSON.stringify(C.data, null, 2)); return true; }
    catch (e) { console.error('config save failed', e); return false; }
};

module.exports = C;
