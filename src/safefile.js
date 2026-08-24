
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

// writeFileSync truncates before it writes, so a crash or a full disk midway leaves the target empty.
function writeAtomic(file, text, opts) {
    const mode = (opts && opts.mode) || 0o600;
    const dir = path.dirname(file);
    // A predictable name opened with 'w' follows a symlink someone else
    // planted; random + 'wx' refuses to open anything that already exists.
    const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid + '-' + nodeCrypto.randomBytes(6).toString('hex'));
    const bak = file + '.bak';

    fs.mkdirSync(dir, { recursive: true });

    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', mode);
        fs.writeFileSync(fd, text, 'utf8');
        try { fs.fsyncSync(fd); } catch (e) {}
    } catch (e) {
        // Leave no half-written temp file behind for the next run to trip over.
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (e2) {} fd = undefined; }
        try { fs.unlinkSync(tmp); } catch (e2) {}
        throw e;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
    }

    // Refresh the rollback copy only from content we can still read, and keep
    // it as locked down as the original.
    try {
        if (fs.existsSync(file)) {
            // copyFileSync creates the backup at the default mode and only then
            // narrows it, leaving the vault briefly world-readable.
            const prev = fs.readFileSync(file);
            const bfd = fs.openSync(bak, 'w', mode);
            try { fs.writeFileSync(bfd, prev); } finally { fs.closeSync(bfd); }
            try { fs.chmodSync(bak, mode); } catch (e) {}
        }
    } catch (e) {}

    // Windows lets a virus scanner or sync client hold the target briefly, which fails the rename.
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
        try { fs.renameSync(tmp, file); return; }
        catch (e) {
            lastErr = e;
            if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') break;
            sleepBriefly(30 * (attempt + 1));
        }
    }
    try { fs.unlinkSync(tmp); } catch (e) {}
    throw lastErr;
}

// Synchronous by design: writeAtomic is called from synchronous save paths and
// the retry window is a few tens of milliseconds.
function sleepBriefly(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
}

function readWithBackup(file) {
    try {
        return { text: fs.readFileSync(file, 'utf8'), fromBackup: false };
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        try { return { text: fs.readFileSync(file + '.bak', 'utf8'), fromBackup: true }; }
        catch (e2) { throw e; }
    }
}

module.exports = { writeAtomic, readWithBackup };
