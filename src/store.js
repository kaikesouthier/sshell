
const crypto = require('./crypto');
const paths = require('./paths');
const safefile = require('./safefile');
const { genId } = require('./util');

const S = {
    store: { folders: [], sessions: [] },
    // The derived key, never the passphrase that produced it.
    vaultKey: null
};

// Everything that must not outlive a lock goes here.
S.lockVault = function () {
    crypto.zeroKey(S.vaultKey);
    S.vaultKey = null;
    S.store = { folders: [], sessions: [] };
};

S.isUnlocked = () => !!(S.vaultKey && S.vaultKey.key);
S.sessionsPath = () => paths.sessionsPath();

S.normalizeStore = function (raw) {
    let sessions, folders;
    if (Array.isArray(raw)) { sessions = raw; folders = []; }
    else if (raw && typeof raw === 'object') {
        sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
        folders = Array.isArray(raw.folders) ? raw.folders : [];
    } else { sessions = []; folders = []; }

    sessions = sessions.filter(s => s && typeof s === 'object');
    folders = folders.filter(f => f && typeof f === 'object');

    // Spread the source first: rebuilding a fixed shape silently discarded any field this version does not know about, and the next save made that…
    const seenFolderIds = new Set();
    const outFolders = folders.map(f => {
        let id = f.id || genId('fld');
        // Duplicate ids make lookups ambiguous: sessions bind to one, the parent
        // map to the other.
        if (seenFolderIds.has(id)) id = genId('fld');
        seenFolderIds.add(id);
        return Object.assign({}, f, {
            id,
            name: f.name || 'Folder',
            parentId: f.parentId || null,
            collapsed: !!f.collapsed,
            icon: f.icon || null,
            iconColor: f.iconColor || null
        });
    });

    // Rendering starts from the roots and walks down, so a folder whose parent is missing or forms a loop would never be drawn — its sessions would…
    const byId = new Map(outFolders.map(f => [f.id, f]));
    outFolders.forEach(f => {
        if (f.parentId === f.id) { f.parentId = null; return; }
        // Walk up and detach the folder that actually closes the loop, not the one we happened to start from — otherwise an innocent folder gets reparented…
        const seen = new Set([f.id]);
        let cur = f;
        while (cur.parentId) {
            const parent = byId.get(cur.parentId);
            if (!parent) { cur.parentId = null; break; }
            if (seen.has(parent.id)) { cur.parentId = null; break; }
            seen.add(parent.id);
            cur = parent;
        }
    });

    const folderIds = new Set(outFolders.map(f => f.id));
    return {
        folders: outFolders,
        sessions: sessions.map(s => Object.assign({}, s, {
            id: s.id || genId('ses'),
            folderId: s.folderId && folderIds.has(s.folderId) ? s.folderId : null,
            label: s.label || s.host || 'Unnamed',
            host: s.host || '',
            port: Number(s.port) || 22,
            username: s.username || '',
            authType: s.authType === 'key' ? 'key' : 'password',
            password: s.password || '',
            keyPath: s.keyPath || '',
            passphrase: s.passphrase || '',
            icon: s.icon || null,
            iconColor: s.iconColor || null,
            os: s.os || null
        }))
    };
};

let persistFailed = false;

S.persist = function () {
    if (!S.isUnlocked()) return false;
    let payload;
    try {
        payload = JSON.stringify(crypto.encryptWithKey(S.store, S.vaultKey), null, 2);
    } catch (e) {
        reportPersistError('Could not encrypt your sessions', e);
        return false;
    }
    try {
        safefile.writeAtomic(paths.sessionsPath(), payload);
        persistFailed = false;
        return true;
    } catch (e) {
        reportPersistError('Could not save sessions.json', e);
        return false;
    }
};

// A failing disk fires on every keystroke-driven save; one dialog is enough
// until a later write succeeds.
function reportPersistError(what, e) {
    console.error('persist failed', e);
    if (persistFailed) return;
    persistFailed = true;
    try {
        const errors = require('./errors');
        require('./dialog').notify(
            what + ':\n\n' + errors.describe(e) + '\n\nYour changes are still in memory but are not written to disk.',
            { kind: 'error', title: 'Save failed' }
        );
    } catch (e2) {}
}

S.getSession = id => S.store.sessions.find(s => s.id === id);
S.getFolder = id => S.store.folders.find(f => f.id === id);

module.exports = S;
