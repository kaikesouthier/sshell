
const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');
const { ipcRenderer, clipboard } = require('electron');
const { $, escapeHtml, humanBytes, fmtMtime, pjoin, pbase, filePath } = require('./util');
const RT = require('./runtime');
const modal = require('./modal');
const dialog = require('./dialog');
const errors = require('./errors');
const xfer = require('./xfer');

const sftpState = { tabId: null, cwd: null, entries: [], loading: false, error: null, sortKey: 'name', sortDir: 1, reqSeq: 0, selected: new Set(), anchor: null, cache: new Map() };

// A small per-(server, directory) listing cache so switching servers or folders
// repaints instantly instead of blanking to a spinner for a round trip. Every
// visit still re-reads the directory in the background, so what you see is only
// ever a frame stale — the cache is for the first paint, not the source of truth.
const SFTP_CACHE_MAX = 80;
// The chosen sort column and direction persist across restarts.
const SORT_KEYS = new Set(['name', 'size', 'mtime']);
function loadSortPref() {
    try {
        const s = require('./config').data.sftpSort;
        if (s && SORT_KEYS.has(s.key)) { sftpState.sortKey = s.key; sftpState.sortDir = s.dir === -1 ? -1 : 1; }
    } catch (e) {}
}
function saveSortPref() {
    try {
        const config = require('./config');
        config.data.sftpSort = { key: sftpState.sortKey, dir: sftpState.sortDir };
        config.save();
    } catch (e) {}
}

function cacheKey(tabId, dir) { return tabId + '|' + dir; }
function entriesSig(entries) { return entries.map(e => JSON.stringify([e.name, e.size, e.mtime, e.access])).join(String.fromCharCode(10)); }
function getCacheRec(tabId, dir) { return sftpState.cache.get(cacheKey(tabId, dir)) || null; }
function putCache(tabId, dir, entries) {
    const k = cacheKey(tabId, dir);
    sftpState.cache.delete(k);
    sftpState.cache.set(k, { entries, sig: entriesSig(entries) });
    while (sftpState.cache.size > SFTP_CACHE_MAX) sftpState.cache.delete(sftpState.cache.keys().next().value);
}
function invalidateCache(tabId, dir) {
    if (dir == null) {
        const prefix = tabId + '|';
        Array.from(sftpState.cache.keys()).forEach(k => { if (k.indexOf(prefix) === 0) sftpState.cache.delete(k); });
    } else {
        sftpState.cache.delete(cacheKey(tabId, dir));
    }
}

function targetsTab(id) { return sftpState.tabId === id; }
function onTabClosed(tab) {
    stopWatchers(tab);
    xfer.closeFor(tab);
    invalidateCache(tab.id);
    if (sftpState.tabId === tab.id) {
        // Invalidate any listing still in flight, and clear the busy flag.
        sftpState.reqSeq++;
        errors.attempt(() => clearTarget('That session was closed. Pick another server to browse.'), 'sftp close');
    }
}
function getSftpTab() { return RT.tabs.find(t => t.id === sftpState.tabId && !t.closed) || null; }

const SFTP_OPEN_TIMEOUT = 20000;

function ensureSftp(tab, cb) {
    if (!tab || tab.closed || !tab.client || !tab.connected) return cb(new Error('Not connected. Open the session tab first.'));
    if (tab.sftp && !tab.sftp._sshellDead) return cb(null, tab.sftp);
    if (tab._sftpOpening) { (tab._sftpWaiters = tab._sftpWaiters || []).push(cb); return; }

    tab._sftpOpening = true;
    tab._sftpWaiters = [cb];
    let settled = false;

    const flush = (err, sftp) => {
        if (settled) return; settled = true;
        clearTimeout(tab._sftpOpenTimer); tab._sftpOpenTimer = null;
        tab._sftpOpening = false;
        const waiters = tab._sftpWaiters || []; tab._sftpWaiters = null;
        waiters.forEach(w => { try { w(err, sftp); } catch (e) { errors.record('sftp.waiter', e); } });
    };

    // If the transport dies mid-request, client.sftp() may never call back.
    tab._sftpOpenTimer = setTimeout(
        () => flush(new Error('Timed out opening an SFTP channel on this host.')),
        SFTP_OPEN_TIMEOUT
    );

    // Browsing (readdir/stat/mkdir/unlink/rename) is tiny and must feel instant,
    // so it rides the session's already-open connection rather than paying to
    // open — and wait on — a second SSH login. Only the heavy file transfers get
    // their own connection (see openTransferChannel), which is what actually
    // needs to stay off the interactive shell's pipe.
    try {
        tab.client.sftp((err, sftp) => {
            // The timeout already gave up on this one. Nothing will ever read
            // it, its unclaimed 'error' events would throw, and the server keeps
            // the session slot until the connection drops.
            if (settled) return discardChannel(err ? null : sftp);
            if (err) return flush(err);
            // The SFTP channel is an EventEmitter: an unclaimed 'error' throws.
            sftp.on('error', e => {
                sftp._sshellDead = true;
                if (tab.sftp === sftp) tab.sftp = null;
                errors.record('sftp.channel', e, tab.title);
            });
            sftp.on('close', () => {
                sftp._sshellDead = true;
                if (tab.sftp === sftp) tab.sftp = null;
            });
            tab.sftp = sftp;
            flush(null, sftp);
        });
    } catch (e) {
        flush(e);
    }
}

const RETRYABLE = new Set(['ETXTBSY', 'EBUSY', 'EAGAIN', 'EWOULDBLOCK']);

function errCode(e) {
    if (!e) return null;
    if (e.code && typeof e.code === 'string') return e.code;
    const m = /\b(ETXTBSY|EBUSY|EAGAIN|EACCES|EPERM|ENOSPC|EDQUOT|ENOENT|EISDIR|ENOTDIR|ENOTEMPTY)\b/.exec(e.message || '');
    return m ? m[1] : null;
}

// ETXTBSY / EBUSY mean the target is held open right now — a running binary on the remote side, an antivirus or editor on the local side.
function withRetry(label, attemptFn, cb, tries, isAlive) {
    const max = tries || 4;
    let n = 0;
    let done = false;
    const finish = e => { if (done) return; done = true; cb(e); };
    const run = () => {
        if (done) return;
        // The last backoff lands ~3.75s out; by then the tab may be gone and the captured handle dead.
        if (isAlive && !isAlive()) return finish(new Error('The connection was closed before the transfer finished.'));
        n++;
        let settled = false;
        try {
            attemptFn(err => {
                if (settled) return; settled = true;
                if (!err) return finish(null);
                const code = errCode(err);
                if (RETRYABLE.has(code) && n < max) {
                    errors.record('sftp.retry', err, label + ' attempt ' + n);
                    setTimeout(run, 250 * Math.pow(2, n - 1));
                    return;
                }
                if (code && !err.code) err.code = code;
                finish(err);
            });
        } catch (e) {
            if (settled) return; settled = true;
            finish(e);
        }
    };
    run();
}

const alive = tab => () => !!tab && !tab.closed && !!tab.client && tab.connected;


function updateTargetLabel() {
    const el = $('sftpTarget');
    if (!el) return;
    const t = getSftpTab();
    el.textContent = t ? t.title : '';
    el.classList.toggle('hidden', !t);
}

function clearTarget(msg) {
    sftpState.tabId = null;
    $('sftpPath').value = '';
    setBusy(false);
    updateTargetLabel();
    renderSftpPlaceholder(msg);
}

// Point the browser at a specific session, regardless of which tab is in front.
function focusTab(tabId) {
    const t = RT.tabs.find(x => x.id === tabId && x.type === 'terminal' && !x.closed);
    if (!t) return;
    if (!t.connected) return clearTarget('That session is not connected.');
    if (sftpState.tabId === t.id) {
        updateTargetLabel();
        // Re-selecting the same server should recover a pane that got stuck on
        // the loader or an error, rather than doing nothing — which is what
        // "click Sessions then SFTP again" was working around.
        if (sftpState.error || (sftpState.loading && !sftpState.entries.length)) {
            if (sftpState.cwd) sftpList(sftpState.cwd); else openSftpFor(t);
        }
        return;
    }
    // The selection belongs to the server it was made on. Carrying it across
    // meant a bulk Delete could act on same-named files on a different host.
    clearFileSelection();
    sftpState.entries = [];
    sftpState.tabId = t.id;
    sftpState.cwd = t.sftpCwd || null;
    updateTargetLabel();
    openSftpFor(t);
}

// The server currently highlighted in the grid, if any.
function gridSelectedTab() {
    try {
        const g = require('./tabs').activeGrid();
        if (!g) return null;
        const picked = g.interactiveTargets();
        return picked.length ? picked[0] : null;
    } catch (e) { return null; }
}

function sftpOnActiveChange() {
    const active = RT.tabs.find(x => x.id === RT.activeTabId && x.type === 'terminal' && !x.closed);

    // A terminal tab is in front — that is unambiguously what the user means.
    if (active) {
        if (!active.connected) return clearTarget('This session is not connected yet.');
        focusTab(active.id);
        return;
    }

    // Grid or tool tab in front: keep browsing whichever server was chosen,
    // rather than blanking the pane.
    const held = RT.tabs.find(x => x.id === sftpState.tabId && !x.closed && x.connected);
    if (held) { updateTargetLabel(); return; }

    const fromGrid = gridSelectedTab();
    if (fromGrid) return focusTab(fromGrid.id);

    clearTarget('Open a session, or click a server in the grid, to browse its files.');
}
function openSftpFor(tab) {
    // Opening a channel can take up to the 20s timeout.
    const req = ++sftpState.reqSeq;
    const stale = () => req !== sftpState.reqSeq || sftpState.tabId !== tab.id;

    setBusy(true); renderSftpLoader();
    ensureSftp(tab, (err, sftp) => {
        if (stale()) return;
        if (err) { setBusy(false); return renderSftpError('SFTP error: ' + errors.describe(err), null); }
        if (sftpState.cwd) return sftpList(sftpState.cwd);
        let settled = false;
        try {
            sftp.realpath('.', (e, abs) => {
                if (settled) return; settled = true;
                if (stale()) return;
                const start = (e || !abs) ? '/' : abs;
                tab.sftpCwd = start; sftpState.cwd = start;
                sftpList(start);
            });
        } catch (e) {
            if (settled || stale()) return;
            settled = true; setBusy(false);
            renderSftpError('SFTP error: ' + errors.describe(e), null);
        }
    });
}
// A refresh always follows something that changed the directory — a delete,
// rename, upload, save-back, or the manual button — so drop the cached copy
// first. Otherwise the instant cache paint would flash the pre-change listing
// (a just-deleted file reappearing) for a round trip before the read corrects
// it. Plain navigation still paints from cache; only refresh bypasses it.
function sftpRefresh() {
    if (!sftpState.cwd) return;
    const tab = getSftpTab();
    if (tab) invalidateCache(tab.id, sftpState.cwd);
    sftpList(sftpState.cwd);
}

function sftpList(dir) {
    const tab = getSftpTab(); if (!tab) return;
    const previousDir = sftpState.cwd;
    // Responses can land out of order (a slow parent listing arriving after a
    // fast child). Only the newest request may write to the shared state.
    const req = ++sftpState.reqSeq;
    const stale = () => req !== sftpState.reqSeq || getSftpTab() !== tab;

    const rec = getCacheRec(tab.id, dir);
    sftpState.error = null;
    $('sftpPath').value = dir;

    if (rec) {
        // Paint the last-known listing at once; the readdir below refreshes it.
        tab.sftpCwd = dir; sftpState.cwd = dir;
        if (dir !== previousDir) { sftpState.selected.clear(); sftpState.anchor = null; }
        sftpState.entries = rec.entries;
        setBusy(false);
        renderSftpTable();
    } else {
        setBusy(true); renderSftpLoader();
    }

    ensureSftp(tab, (err, sftp) => {
        if (stale()) return;
        if (err) { if (!rec) { setBusy(false); renderSftpError('SFTP error: ' + errors.describe(err), dir); } return; }
        let settled = false;
        try {
            sftp.readdir(dir, (e, list) => {
                if (settled) return; settled = true;
                if (stale()) return;
                // The directory failed to read — most often it was deleted or
                // its permissions changed since it was cached. Drop the stale
                // copy and surface it rather than silently showing a listing
                // that no longer exists. (A navigate-away already returned via
                // stale() above, so this only fires while the user is on it.)
                if (e) { invalidateCache(tab.id, dir); setBusy(false); renderSftpError('Cannot open ' + dir + '\n\n' + errors.describe(e), dir); return; }
                tab.sftpCwd = dir; sftpState.cwd = dir;
                if (dir !== previousDir && !rec) { sftpState.selected.clear(); sftpState.anchor = null; }
                let entries;
                try { entries = (list || []).map(parseEntry); }
                catch (pe) { errors.record('parseEntry', pe); entries = []; }
                const changed = !rec || rec.sig !== entriesSig(entries);
                putCache(tab.id, dir, entries);
                sftpState.entries = entries;
                setBusy(false);
                // Skip a redundant repaint when the cached view already matches,
                // so a background refresh never resets scroll or a live selection.
                if (changed) renderSftpTable();
            });
        } catch (e) {
            if (settled || stale()) return;
            settled = true;
            if (!rec) { setBusy(false); renderSftpError('Cannot open ' + dir + '\n\n' + errors.describe(e), dir); }
        }
    });
}

function parseEntry(item) {
    item = item || {};
    const a = item.attrs || {};
    const long = item.longname || '';
    const parts = long.trim().split(/\s+/);
    const perms = parts[0] || '';
    const isDir = perms[0] === 'd' || (a.mode && (a.mode & 0o170000) === 0o040000);
    return {
        name: item.filename || '(unnamed)', isDir,
        size: a.size || 0, mtime: a.mtime || 0,
        access: perms || (isDir ? 'd????????' : '-????????'),
        owner: parts[2] || (a.uid != null ? String(a.uid) : '-'),
        group: parts[3] || (a.gid != null ? String(a.gid) : '-')
    };
}


function setBusy(on) {
    sftpState.loading = on;
    $('sftpPane').classList.toggle('sftp-busy', on);
}
function renderSftpLoader() {
    $('sftpBody').innerHTML = `<div class="flex flex-col items-center justify-center gap-3 py-12 text-faint"><div class="spinner"></div><span class="text-xs">Loading…</span></div>`;
}
function renderSftpPlaceholder(msg) {
    $('sftpBody').innerHTML = `<div class="flex items-center justify-center text-center text-xs text-faint px-4 py-10 whitespace-pre-line">${escapeHtml(msg)}</div>`;
}
function renderSftpError(msg, retryDir) {
    sftpState.error = msg;
    $('sftpBody').innerHTML = `
        <div class="flex flex-col items-center justify-center gap-3 py-10 px-4 text-center">
            <svg class="w-8 h-8 text-bad" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path></svg>
            <div class="text-xs text-bad whitespace-pre-line max-w-[380px]">${escapeHtml(msg)}</div>
            <button id="sftpRetry" class="mt-1 bg-accent hover:bg-accent-hover text-white text-xs font-semibold px-4 py-2 rounded-md transition-colors flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.6M20 20v-5h-.6M5 9a7 7 0 0111.6-3M19 15a7 7 0 01-11.6 3"></path></svg>Retry
            </button>
        </div>`;
    const btn = $('sftpBody').querySelector('#sftpRetry');
    if (btn) btn.addEventListener('click', () => {
        const dir = retryDir || sftpState.cwd;
        if (dir) sftpList(dir);
        else { const t = getSftpTab(); if (t) openSftpFor(t); else sftpOnActiveChange(); }
    });
}


function compareEntries(a, b) {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; 
    let r;
    if (sftpState.sortKey === 'size') r = a.size - b.size;
    else if (sftpState.sortKey === 'mtime') r = a.mtime - b.mtime;
    else r = a.name.localeCompare(b.name);
    return r * sftpState.sortDir;
}
function sortArrow(key) {
    if (sftpState.sortKey !== key) return '';
    return sftpState.sortDir === 1 ? ' ▲' : ' ▼';
}
function selectedEntries() {
    return sftpState.entries.filter(e => sftpState.selected.has(e.name));
}
function clearFileSelection(render) {
    if (!sftpState.selected.size) return false;
    sftpState.selected.clear();
    sftpState.anchor = null;
    if (render !== false) paintFileSelection();
    return true;
}
function paintFileSelection() {
    const body = $('sftpBody');
    if (!body) return;
    body.querySelectorAll('tr[data-name]').forEach(tr => {
        tr.classList.toggle('is-selected', sftpState.selected.has(tr.dataset.name));
    });
    updateFileSelectionBar();
}
function updateFileSelectionBar() {
    const bar = $('sftpSelBar');
    if (!bar) return;
    const n = sftpState.selected.size;
    bar.classList.toggle('hidden', n === 0);
    if (n) $('sftpSelCount').textContent = n + ' selected';
}
// Row order as displayed, so Shift+click can resolve a range.
function visibleNames() {
    const body = $('sftpBody');
    if (!body) return [];
    return Array.from(body.querySelectorAll('tr[data-name]'))
        .map(tr => tr.dataset.name).filter(n => n !== '..');
}
function selectRangeOfFiles(name) {
    const order = visibleNames();
    const to = order.indexOf(name);
    const from = sftpState.anchor ? order.indexOf(sftpState.anchor) : -1;
    if (to < 0 || from < 0) { sftpState.selected.add(name); sftpState.anchor = name; return; }
    const [a, b] = from <= to ? [from, to] : [to, from];
    for (let i = a; i <= b; i++) sftpState.selected.add(order[i]);
}

function renderSftpTable() {
    const dir = sftpState.cwd;
    const entries = sftpState.entries.slice().sort(compareEntries);
    const rows = [];
    if (dir && dir !== '/') rows.push(rowHtml({ name: '..', isDir: true, size: 0, mtime: 0, access: 'd---------', owner: '', group: '' }, true));
    entries.forEach(en => rows.push(rowHtml(en, false)));

    $('sftpBody').innerHTML = `
        <table class="w-full text-[11px] border-collapse" style="min-width:520px">
            <thead class="sticky top-0 bg-panel text-faint z-[1]">
                <tr class="text-left">
                    <th data-sort="name" class="sort-th font-semibold px-2 py-1.5">Name${sortArrow('name')}</th>
                    <th data-sort="size" class="sort-th font-semibold px-2 py-1.5 text-right whitespace-nowrap">Size (KB)${sortArrow('size')}</th>
                    <th data-sort="mtime" class="sort-th font-semibold px-2 py-1.5 whitespace-nowrap">Last Modified${sortArrow('mtime')}</th>
                    <th class="font-semibold px-2 py-1.5">Owner</th>
                    <th class="font-semibold px-2 py-1.5">Group</th>
                    <th class="font-semibold px-2 py-1.5 whitespace-nowrap">Access</th>
                </tr>
            </thead>
            <tbody>${rows.join('')}</tbody>
        </table>`;

    $('sftpBody').querySelectorAll('.sort-th').forEach(th => th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (sftpState.sortKey === key) sftpState.sortDir *= -1;
        else { sftpState.sortKey = key; sftpState.sortDir = 1; }
        saveSortPref();
        renderSftpTable();
    }));
    // Drop selections for names that are no longer listed.
    const present = new Set(entries.map(e => e.name));
    sftpState.selected.forEach(n => { if (!present.has(n)) sftpState.selected.delete(n); });

    $('sftpBody').querySelectorAll('tr[data-name]').forEach(tr => {
        const name = tr.dataset.name;
        const isDir = tr.dataset.dir === '1';
        const entry = name === '..' ? null : entries.find(e => e.name === name);

        tr.addEventListener('click', e => {
            if (sftpState.loading || !entry) return;
            if (e.ctrlKey || e.metaKey) {
                if (sftpState.selected.has(name)) sftpState.selected.delete(name);
                else { sftpState.selected.add(name); sftpState.anchor = name; }
            } else if (e.shiftKey) {
                selectRangeOfFiles(name);
            } else {
                sftpState.selected.clear();
                sftpState.selected.add(name);
                sftpState.anchor = name;
            }
            paintFileSelection();
        });
        tr.addEventListener('dblclick', () => {
            if (sftpState.loading) return;
            if (isDir) return sftpList(pjoin(dir, name));
            if (entry) openWithEditor(entry, dir);
        });
        if (entry) tr.addEventListener('contextmenu', e => {
            e.preventDefault();
            if (sftpState.loading) return;
            // Right-clicking outside the selection re-targets it to that row.
            if (!sftpState.selected.has(name)) { sftpState.selected.clear(); sftpState.selected.add(name); sftpState.anchor = name; paintFileSelection(); }
            showFileMenu(e.clientX, e.clientY, entry, dir);
        });
    });
    paintFileSelection();
}
function rowHtml(en, isUp) {
    const k = en.size / 1024;
    const kb = en.isDir ? '—' : (k >= 100 ? Math.round(k).toString() : k >= 1 ? k.toFixed(1) : k.toFixed(2));
    const icon = en.isDir
        ? `<svg class="w-3.5 h-3.5 inline-block mr-1 -mt-0.5 ${isUp ? 'text-faint' : 'text-accent/80'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"></path></svg>`
        : `<svg class="w-3.5 h-3.5 inline-block mr-1 -mt-0.5 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4a1 1 0 011-1h9l6 6v11a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"></path></svg>`;
    return `<tr data-name="${escapeHtml(en.name)}" data-dir="${en.isDir ? 1 : 0}" class="sftp-row border-b border-edge/40 ${en.isDir ? 'dir' : ''}">
        <td class="px-2 py-1.5 max-w-[180px]"><span class="sftp-name truncate inline-block align-middle max-w-[150px] font-medium text-txt/90">${icon}${escapeHtml(en.name)}</span></td>
        <td class="px-2 py-1.5 text-right font-mono text-muted whitespace-nowrap">${kb}</td>
        <td class="px-2 py-1.5 font-mono text-muted whitespace-nowrap">${isUp ? '' : fmtMtime(en.mtime)}</td>
        <td class="px-2 py-1.5 font-mono text-muted">${escapeHtml(en.owner)}</td>
        <td class="px-2 py-1.5 font-mono text-muted">${escapeHtml(en.group)}</td>
        <td class="px-2 py-1.5 font-mono text-faint whitespace-nowrap">${isUp ? '' : escapeHtml(en.access)}</td>
    </tr>`;
}


async function downloadSelected(dir) {
    const picked = selectedEntries().filter(e => !e.isDir);
    if (!picked.length) return dialog.notify('Select one or more files to download.', { kind: 'warn' });
    const tab = getSftpTab(); if (!tab) return;

    let res;
    try { res = await ipcRenderer.invoke('open-dialog', { properties: ['openDirectory', 'createDirectory'], title: 'Download ' + picked.length + ' file(s) to…' }); }
    catch (e) { return dialog.notify('Could not open the folder picker:\n\n' + errors.describe(e), { kind: 'error' }); }
    if (!res || res.canceled || !res.filePaths || !res.filePaths[0]) return;
    const destDir = res.filePaths[0];

    picked.forEach(entry => {
        const safe = (path.basename(String(entry.name)) || 'download').replace(/[\\/:*?"<>|\0]/g, '_');
        const local = path.join(destDir, safe);
        const t = addTransfer(entry.name, 'down', entry.size);
        t.tab = tab; t.local = local; t.remote = pjoin(dir, entry.name);
        openTransferChannel(tab, (err, ch) => {
            if (err) { finishTransfer(t, err); return; }
            if (t.cancelled) { closeChannel(ch); return finishTransfer(t, null); }
            t.channel = ch;
            withRetry('fastGet ' + entry.name,
                guardedAttempt(t, ch, done => ch.fastGet(t.remote, local, xferOpts(ch, (tr, c, to) => stepTransfer(t, tr, to)), done)),
                e => {
                    finishTransfer(t, e);
                    if (e && !wasCancelled(t)) noteUploadError(entry.name, e);
                },
                4, alive(tab));
        });
    });
}

async function deleteSelected(dir) {
    const picked = selectedEntries();
    if (!picked.length) return;
    const tab = getSftpTab(); if (!tab) return;
    const dirs = picked.filter(e => e.isDir).length;
    const files = picked.length - dirs;
    const bits = [];
    if (files) bits.push(files + ' file' + (files === 1 ? '' : 's'));
    if (dirs) bits.push(dirs + ' folder' + (dirs === 1 ? '' : 's') + ' and everything inside');

    const ok = await dialog.confirm(
        'Delete ' + bits.join(' and ') + '?\nThis cannot be undone.',
        { danger: true, okLabel: 'Delete ' + picked.length }
    );
    if (!ok) return;

    ensureSftp(tab, async (err, sftp) => {
        if (err) return dialog.notify(errors.describe(err), { kind: 'error', title: 'SFTP error' });
        setBusy(true); renderSftpLoader();
        const failed = [];
        for (const entry of picked) {
            const full = pjoin(dir, entry.name);
            try {
                if (entry.isDir) await rmTree(sftp, full);
                else await new Promise((res, rej) => sftp.unlink(full, e => e ? rej(e) : res()));
            } catch (e) { failed.push(entry.name + ' — ' + errors.describe(e).split('\n')[0]); }
        }
        setBusy(false);
        clearFileSelection(false);
        sftpRefresh();
        if (failed.length) {
            dialog.notify(failed.length + ' item(s) could not be deleted:\n\n' + failed.slice(0, 8).join('\n'),
                { kind: 'error', title: 'Delete failed' });
        }
    });
}

function showFileMenu(x, y, entry, dir) {
    const fileMenu = $('fileMenu');
    const items = [];
    const picked = selectedEntries();

    if (picked.length > 1) {
        const files = picked.filter(e => !e.isDir).length;
        if (files) items.push({ label: 'Download ' + files + ' file' + (files === 1 ? '' : 's') + '…', act: () => downloadSelected(dir) });
        items.push({ sep: true });
        items.push({ label: 'Clear selection', act: () => clearFileSelection() });
        items.push({ label: 'Delete ' + picked.length + ' items', danger: true, act: () => deleteSelected(dir) });
    } else {
        if (entry.isDir) items.push({ label: 'Open', act: () => sftpList(pjoin(dir, entry.name)) });
        else {
            items.push({ label: 'Open with…', act: () => openWithEditor(entry, dir) });
            items.push({ label: 'Download…', act: () => downloadEntry(entry, dir) });
        }
        items.push({ sep: true });
        items.push({ label: 'Rename…', act: () => renameEntry(entry, dir) });
        items.push({ label: 'Delete', danger: true, act: () => deleteEntry(entry, dir) });
    }
    fileMenu.innerHTML = '';
    items.forEach(it => {
        if (it.sep) { const d = document.createElement('div'); d.className = 'my-1 border-t border-edge'; fileMenu.appendChild(d); return; }
        const b = document.createElement('button');
        b.className = 'w-full text-left px-3 py-1.5 text-[13px] transition-colors ' + (it.danger ? 'text-bad hover:bg-bad hover:text-white' : 'text-txt/90 hover:bg-accent hover:text-white');
        b.textContent = it.label;
        b.addEventListener('click', () => { hideFileMenu(); it.act(); });
        fileMenu.appendChild(b);
    });
    fileMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    fileMenu.style.top = Math.min(y, window.innerHeight - 180) + 'px';
    fileMenu.classList.remove('hidden');
}
function hideFileMenu() { $('fileMenu').classList.add('hidden'); }


function busy() { return sftpState.loading; }


function pReaddir(sftp, p) { return new Promise((res, rej) => sftp.readdir(p, (e, l) => e ? rej(e) : res(l))); }
function pUnlink(sftp, p) { return new Promise((res, rej) => sftp.unlink(p, e => e ? rej(e) : res())); }
function pRmdir(sftp, p) { return new Promise((res, rej) => sftp.rmdir(p, e => e ? rej(e) : res())); }
function entryIsDir(item) { const a = item.attrs || {}; return (item.longname || '')[0] === 'd' || (a.mode && (a.mode & 0o170000) === 0o040000); }

const MAX_DEPTH = 40;

// Returns null when the tree could not be read, so callers can refuse to delete
// rather than showing a falsely reassuring "0 items".
async function countTree(sftp, dir, depth) {
    depth = depth || 0;
    if (depth > MAX_DEPTH) return null;
    let n = 0;
    let list;
    try { list = await pReaddir(sftp, dir); }
    catch (e) { return depth === 0 ? null : 0; }
    for (const it of list) {
        n++;
        if (entryIsDir(it)) {
            const sub = await countTree(sftp, pjoin(dir, it.filename), depth + 1);
            if (sub === null) return null;
            n += sub;
        }
    }
    return n;
}

async function rmTree(sftp, dir, depth) {
    depth = depth || 0;
    if (depth > MAX_DEPTH) throw new Error('Directory nesting is deeper than ' + MAX_DEPTH + ' levels; stopping.');
    const list = await pReaddir(sftp, dir);
    for (const it of list) {
        const full = pjoin(dir, it.filename);
        if (entryIsDir(it)) await rmTree(sftp, full, depth + 1);
        else await pUnlink(sftp, full);
    }
    await pRmdir(sftp, dir);
}

function badName(name) {
    if (!name) return 'Enter a name.';
    if (name === '.' || name === '..') return 'That name is reserved.';
    if (name.includes('/')) return 'A name cannot contain "/".';
    if (name.includes('\0')) return 'That name contains an invalid character.';
    return null;
}

async function renameEntry(entry, dir) {
    if (busy()) return;
    const r = await modal.askInput({ title: 'Rename', okLabel: 'Rename', fields: [{ key: 'name', label: 'New name', value: entry.name }] });
    if (!r) return;
    const next = (r.name || '').trim();
    if (next === entry.name) return;
    const bad = badName(next);
    if (bad) return dialog.notify(bad, { kind: 'warn' });

    const tab = getSftpTab(); if (!tab) return;
    ensureSftp(tab, (err, sftp) => {
        if (err) return dialog.notify(errors.describe(err), { kind: 'error', title: 'SFTP error' });
        withRetry('rename ' + entry.name,
            done => sftp.rename(pjoin(dir, entry.name), pjoin(dir, next), done),
            e => {
                if (e) dialog.notify('Could not rename ' + entry.name + ':\n\n' + errors.describe(e), { kind: 'error', title: 'Rename failed' });
                sftpRefresh();
            });
    });
}

function deleteEntry(entry, dir) {
    if (busy()) return;
    const full = pjoin(dir, entry.name);
    const tab = getSftpTab(); if (!tab) return;
    ensureSftp(tab, async (err, sftp) => {
        if (err) return dialog.notify(errors.describe(err), { kind: 'error', title: 'SFTP error' });
        try {
            if (entry.isDir) {
                setBusy(true); renderSftpLoader();
                let n;
                try { n = await countTree(sftp, full); }
                finally { setBusy(false); }
                if (n === null) {
                    // Without this the pane stays on "Loading…" for good.
                    renderSftpTable();
                    return dialog.notify('Could not read the contents of "' + entry.name + '". Nothing was deleted.', { kind: 'error' });
                }
                renderSftpTable();
                const msg = n === 0
                    ? `Delete empty folder "${entry.name}"?`
                    : `"${entry.name}" contains ${n} item${n === 1 ? '' : 's'}.\nAre you sure you want to delete the folder and all ${n} of them? This cannot be undone.`;
                const ok = await dialog.confirm(msg, { danger: true, okLabel: n ? `Delete ${n} item${n === 1 ? '' : 's'}` : 'Delete' });
                if (!ok) return;
                setBusy(true); renderSftpLoader();
                try { await rmTree(sftp, full); }
                catch (e) { dialog.notify('Delete stopped partway through:\n\n' + errors.describe(e), { kind: 'error', title: 'Delete failed' }); }
                finally { setBusy(false); sftpRefresh(); }
            } else {
                const ok = await dialog.confirm(`Delete file "${entry.name}"?`, { danger: true, okLabel: 'Delete' });
                if (!ok) return;
                withRetry('unlink ' + entry.name,
                    done => sftp.unlink(full, done),
                    e => {
                        if (e) dialog.notify('Could not delete ' + entry.name + ':\n\n' + errors.describe(e), { kind: 'error', title: 'Delete failed' });
                        sftpRefresh();
                    });
            }
        } catch (e) {
            setBusy(false);
            dialog.notify(errors.describe(e), { kind: 'error', title: 'Delete failed' });
        }
    });
}

async function newSftpFile() {
    if (busy() || !getSftpTab()) return;
    const r = await modal.askInput({ title: 'New File', okLabel: 'Create', fields: [{ key: 'name', label: 'File name', placeholder: 'notes.txt' }] });
    if (!r) return;
    const name = (r.name || '').trim();
    const bad = badName(name);
    if (bad) return dialog.notify(bad, { kind: 'warn' });
    const cwd = sftpState.cwd; if (!cwd) return;
    ensureSftp(getSftpTab(), (err, sftp) => {
        if (err) return dialog.notify(errors.describe(err), { kind: 'error', title: 'SFTP error' });
        sftp.open(pjoin(cwd, name), 'wx', (e, h) => {
            if (e) {
                const why = errCode(e) === 'EEXIST' || /exist/i.test(e.message || '')
                    ? 'A file named "' + name + '" already exists here.'
                    : errors.describe(e);
                return dialog.notify(why, { kind: 'error', title: 'Create failed' });
            }
            sftp.close(h, closeErr => {
                if (closeErr) errors.record('sftp.close', closeErr);
                sftpRefresh();
            });
        });
    });
}

async function newSftpFolder() {
    if (busy() || !getSftpTab()) return;
    const r = await modal.askInput({ title: 'New Folder', okLabel: 'Create', fields: [{ key: 'name', label: 'Folder name', placeholder: 'uploads' }] });
    if (!r) return;
    const name = (r.name || '').trim();
    const bad = badName(name);
    if (bad) return dialog.notify(bad, { kind: 'warn' });
    const cwd = sftpState.cwd; if (!cwd) return;
    ensureSftp(getSftpTab(), (err, sftp) => {
        if (err) return dialog.notify(errors.describe(err), { kind: 'error', title: 'SFTP error' });
        sftp.mkdir(pjoin(cwd, name), e => {
            if (e) dialog.notify('Could not create "' + name + '":\n\n' + errors.describe(e), { kind: 'error', title: 'Create failed' });
            sftpRefresh();
        });
    });
}

async function downloadEntry(entry, dir) {
    if (busy()) return;
    const tab = getSftpTab(); if (!tab) return;
    let res;
    // basename only: a hostile server can put anything in `filename`, and a full path here aims the save dialog wherever it likes — e.g.
    const suggested = (path.basename(String(entry.name)) || 'download').replace(/[\\/:*?"<>|\0]/g, '_');
    try { res = await ipcRenderer.invoke('save-dialog', { defaultPath: suggested }); }
    catch (e) { return dialog.notify('Could not open the save dialog:\n\n' + errors.describe(e), { kind: 'error' }); }
    if (!res || res.canceled || !res.filePath) return;

    const t = addTransfer(entry.name, 'down', entry.size);
    t.tab = tab; t.local = res.filePath; t.remote = pjoin(dir, entry.name);

    openTransferChannel(tab, (err, ch) => {
        if (err) { finishTransfer(t, err); if (!wasCancelled(t)) dialog.notify(errors.describe(err), { kind: 'error', title: 'SFTP error' }); return; }
        if (t.cancelled) { closeChannel(ch); return finishTransfer(t, null); }
        t.channel = ch;
        withRetry('fastGet ' + entry.name,
            guardedAttempt(t, ch, done => ch.fastGet(t.remote, t.local, xferOpts(ch, (tr, c, to) => stepTransfer(t, tr, to)), done)),
            e => {
                finishTransfer(t, e);
                if (e && !wasCancelled(t)) {
                    dialog.notify('Could not download ' + entry.name + ':\n\n' + errors.describe(e), { kind: 'error', title: 'Download failed' });
                }
            },
            4, alive(tab));
    });
}
function openWithEditor(entry, dir) {
    if (busy()) return;
    const tab = getSftpTab(); if (!tab) return;

    const tmpDir = path.join(os.tmpdir(), 'sshell', String(tab.id));
    try {
        // 0700: these are copies of remote files (configs, keys) and the default
        // mode leaves them readable by every local account.
        fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(tmpDir, 0o700); } catch (e) {}
    } catch (e) {
        return dialog.notify('Could not create a temporary folder:\n\n' + errors.describe(e), { kind: 'error' });
    }

    const safeName = (path.basename(String(entry.name)) || 'file').replace(/[\\/:*?"<>|\0]/g, '_');
    const remote = pjoin(dir, entry.name);
    // Two remote files with the same basename would otherwise share one temp path.
    const bucket = require('crypto').createHash('sha1').update(dir).digest('hex').slice(0, 8);
    const local = path.join(tmpDir, bucket + '-' + safeName);

    // A file opened earlier is still watched for save-back, and its local copy
    // dates from that moment — so reopening it showed what the server had back
    // then, and anything changed there since (another user, a deploy, a cron
    // job) stayed invisible until the watch expired. Fetch a fresh copy every
    // time, unless local edits are still on their way up: a new download would
    // land on top of them and the watcher would push the old contents back.
    const existing = (tab._watchers || []).find(w => w.remote === remote);
    if (existing) {
        if (existing.debounce || existing.uploading || existing.pending) { existing.ttl = restartTtl(existing); openLocalFile(local); return; }
        existing.drop();
    }

    const t = addTransfer(entry.name, 'down', entry.size);
    t.tab = tab; t.local = local; t.remote = remote;

    openTransferChannel(tab, (chErr, ch) => {
        if (chErr) { finishTransfer(t, chErr); if (!wasCancelled(t)) dialog.notify(errors.describe(chErr), { kind: 'error', title: 'SFTP error' }); return; }
        if (t.cancelled) { closeChannel(ch); return finishTransfer(t, null); }
        t.channel = ch;
        withRetry('fastGet ' + entry.name,
            guardedAttempt(t, ch, done => ch.fastGet(remote, local, xferOpts(ch, (tr, c, to) => stepTransfer(t, tr, to)), done)),
            async e => {
                finishTransfer(t, e);
                if (wasCancelled(t)) return;
                if (e) return dialog.notify('Could not download ' + entry.name + ':\n\n' + errors.describe(e), { kind: 'error', title: 'Download failed' });
                if (!(await confirmIfExecutable(entry.name))) {
                    try { fs.unlinkSync(local); } catch (err) {}
                    return;
                }
                openLocalFile(local);
                watchAndReupload(tab, local, remote, entry.name);
            },
            4, alive(tab));
    });
}

// Handing an arbitrary extension to the OS handler is execution: .exe/.scr/.hta on Windows, .desktop on Linux.
const EXECUTABLE_EXT = new Set([
    '.exe', '.com', '.scr', '.bat', '.cmd', '.pif', '.msi', '.msp', '.cpl', '.hta',
    '.jar', '.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.ps1', '.psm1', '.reg',
    '.lnk', '.url', '.desktop', '.appref-ms', '.sh', '.run', '.bin', '.app', '.command'
]);

async function confirmIfExecutable(name) {
    // Windows silently strips trailing dots and spaces from a filename, so a
    // remote server naming a file "run.exe " or "run.exe." would land on disk as
    // "run.exe" while path.extname sees ".exe " / "." and slips past the list.
    const clean = String(name || '').replace(/[ .]+$/, '');
    const ext = (path.extname(clean) || '').toLowerCase();
    if (!EXECUTABLE_EXT.has(ext)) return true;
    return dialog.confirm(
        '"' + name + '" is a ' + ext + ' file.\n\n' +
        'Opening it hands it to your operating system, which may RUN it rather than ' +
        'display it. The name and extension came from the remote server. Only continue ' +
        'if you are certain this file is safe.',
        { danger: true, okLabel: 'Open anyway', cancelLabel: 'Cancel', title: 'This file may execute' }
    );
}

function openLocalFile(local) {
    if (process.platform === 'win32') {
        try {
            const child = child_process.spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', local], { detached: true, stdio: 'ignore' });
            child.on('error', e => errors.record('openLocalFile', e, local));
            child.unref();
            return;
        } catch (e) { errors.record('openLocalFile', e, local); }
    }
    require('electron').shell.openPath(local).then(
        msg => { if (msg) dialog.notify('Could not open the file:\n\n' + msg, { kind: 'error' }); },
        e => dialog.notify('Could not open the file:\n\n' + errors.describe(e), { kind: 'error' })
    );
}

const WATCH_TTL = 30 * 60 * 1000;

function stopWatchers(tab, silent) {
    const list = tab._watchers || [];
    tab._watchers = [];
    const stranded = [];
    list.forEach(w => {
        try { w.watcher && w.watcher.close(); } catch (e) {}
        // A save still inside the 400ms debounce, mid-upload, or queued behind
        // one would previously vanish without a word when the tab closed.
        if (w.debounce || w.uploading || w.pending) stranded.push(w);
        clearTimeout(w.debounce); clearTimeout(w.ttl);
        w.debounce = null; w.ttl = null;
    });
    if (stranded.length && !silent) {
        const lines = stranded.slice(0, 6).map(w => '· ' + w.name + '\n   ' + w.local);
        dialog.notify(
            'The session closed before these edits finished uploading:\n\n' + lines.join('\n') +
            (stranded.length > 6 ? '\n· …and ' + (stranded.length - 6) + ' more' : '') +
            '\n\nThe local copies above have been kept so you can re-upload them.',
            { kind: 'warn', title: 'Edits not uploaded' }
        );
    }
    // Temp files for cleanly-finished edits are no longer needed; stranded ones
    // are deliberately left behind.
    list.filter(w => stranded.indexOf(w) < 0).forEach(w => {
        try { fs.unlinkSync(w.local); } catch (e) {}
    });
}

// Editors on Windows (and vim/emacs everywhere) save atomically: write a temp file, then rename it over the target.
function restartTtl(rec) {
    clearTimeout(rec.ttl);
    rec.ttl = setTimeout(() => rec.expire(), WATCH_TTL);
    return rec.ttl;
}

function watchAndReupload(tab, local, remote, name) {
    const rec = { local, remote, name, watcher: null, debounce: null, ttl: null, uploading: false, pending: false, lastMtime: 0 };
    tab._watchers = tab._watchers || [];
    tab._watchers.push(rec);

    const drop = () => {
        try { rec.watcher && rec.watcher.close(); } catch (e) {}
        clearTimeout(rec.debounce); clearTimeout(rec.ttl);
        rec.debounce = null; rec.ttl = null;
        tab._watchers = (tab._watchers || []).filter(w => w !== rec);
        // Never delete a file whose contents have not reached the server yet:
        // the failure dialog points the user at this exact path.
        if (!rec.uploading && !rec.pending) { try { fs.unlinkSync(local); } catch (e) {} }
    };
    rec.drop = drop;
    rec.expire = () => {
        if (rec.uploading || rec.pending) { restartTtl(rec); return; }
        drop();
    };

    const upload = () => {
        if (tab.closed) return drop();
        // A save that lands mid-upload used to be dropped silently; queue it and
        // run one more pass once the current transfer finishes.
        if (rec.uploading) { rec.pending = true; return; }
        rec.uploading = true;

        let size = 0;
        try { size = fs.statSync(local).size; } catch (e) { rec.uploading = false; return; }

        const t = addTransfer(name + ' (save)', 'up', size);
        t.tab = tab; t.local = local; t.remote = remote;
        // A cancelled save-back must not delete the remote file — this is an
        // edit of an existing file, so leave whatever is already there.
        t.keepRemoteOnCancel = true;

        openTransferChannel(tab, (err, sftp) => {
            if (err) {
                rec.uploading = false;
                finishTransfer(t, err);
                if (!wasCancelled(t)) dialog.notify('Could not upload your changes to ' + name + ':\n\n' + errors.describe(err), { kind: 'error', title: 'Save failed' });
                return;
            }
            if (t.cancelled) { closeChannel(sftp); rec.uploading = false; return finishTransfer(t, null); }
            t.channel = sftp;
            withRetry('fastPut ' + name,
                guardedAttempt(t, sftp, done => {
                    t.wrote = true;
                    sftp.fastPut(local, remote, xferOpts(sftp, (tr, ch, to) => stepTransfer(t, tr, to)), done);
                }),
                e => {
                    finishTransfer(t, e);
                    rec.uploading = false;
                    if (wasCancelled(t)) { rec.pending = false; return; }
                    if (e) {
                        // Clear the queued flag before reporting, or a failed save
                        // leaves pending stuck true and the record un-droppable.
                        const hadPending = rec.pending;
                        rec.pending = false;
                        dialog.notify(
                            'Could not save ' + name + ' back to the server:\n\n' + errors.describe(e) +
                            '\n\nYour edits are still in the local copy at:\n' + local,
                            { kind: 'error', title: 'Save failed' }
                        );
                        if (hadPending) setTimeout(upload, 500);
                        return;
                    }
                    if (rec.pending) { rec.pending = false; setTimeout(upload, 150); return; }
                    if (sftpState.tabId === tab.id && !tab.closed) sftpRefresh();
                },
                4, alive(tab));
        });
    };

    const onChange = () => {
        let mtime = 0;
        try { mtime = fs.statSync(local).mtimeMs; } catch (e) { return; }
        if (mtime === rec.lastMtime) return;
        rec.lastMtime = mtime;
        restartTtl(rec);
        clearTimeout(rec.debounce);
        rec.debounce = setTimeout(() => { rec.debounce = null; upload(); }, 400);
    };

    try {
        rec.watcher = fs.watch(path.dirname(local), (ev, changed) => {
            if (!changed || path.basename(changed) !== path.basename(local)) return;
            onChange();
        });
        rec.watcher.on('error', e => { errors.record('fs.watch', e, local); drop(); });
    } catch (e) {
        errors.record('fs.watch', e, local);
        // Directory watching is unavailable on some network/virtual filesystems;
        // polling still catches saves, just a little later.
        const poll = setInterval(() => { if (tab.closed) { clearInterval(poll); return; } onChange(); }, 1500);
        rec.watcher = { close: () => clearInterval(poll), on: () => {} };
    }

    try { rec.lastMtime = fs.statSync(local).mtimeMs; } catch (e) {}
    restartTtl(rec);
}


// A dropped folder can fan out into hundreds of files; batching them keeps the
// SSH connection from hitting its channel limit and stalling every transfer.
const MAX_ACTIVE_UPLOADS = 4;
let uploadQueue = [];
let activeUploads = 0;
let uploadErrors = [];
let uploadErrorTimer = null;

function noteUploadError(name, e) {
    uploadErrors.push(name + ' — ' + (e && e.message || e));
    clearTimeout(uploadErrorTimer);
    // Batch the report: one dialog for a failed folder beats one per file.
    uploadErrorTimer = setTimeout(() => {
        const list = uploadErrors.slice(0, 10);
        const more = uploadErrors.length - list.length;
        dialog.notify(
            uploadErrors.length + ' item' + (uploadErrors.length === 1 ? '' : 's') + ' failed to upload:\n\n' +
            list.join('\n') + (more > 0 ? '\n…and ' + more + ' more.' : ''),
            { kind: 'error', title: 'Upload failed' }
        );
        uploadErrors = [];
    }, 600);
}

let pumping = false;

function pumpUploads() {
    // A job can fail synchronously (ensureSftp rejects immediately, statSync throws), calling done() inside the loop and re-entering pumpUploads.
    if (pumping) return;
    pumping = true;
    try {
        while (activeUploads < MAX_ACTIVE_UPLOADS && uploadQueue.length) {
            const job = uploadQueue.shift();
            activeUploads++;
            let finished = false;
            // Idempotent: ssh2 can invoke a transfer callback more than once, and
            // a double decrement drove the counter negative and broke the cap.
            job(() => {
                if (finished) return;
                finished = true;
                activeUploads--;
                pumpUploads();
            });
        }
    } finally { pumping = false; }
}
function enqueueUpload(job) { uploadQueue.push(job); pumpUploads(); }

function uploadFile(localPath, remotePath, tab) {
    tab = tab || getSftpTab(); if (!tab) return;
    enqueueUpload(done => {
        let total = 0;
        try { total = fs.statSync(localPath).size; }
        catch (e) { noteUploadError(pbase(remotePath), e); return done(); }

        const t = addTransfer(pbase(remotePath), 'up', total);
        t.tab = tab; t.local = localPath; t.remote = remotePath;

        openTransferChannel(tab, (err, ch) => {
            if (err) { finishTransfer(t, err); if (!wasCancelled(t)) noteUploadError(pbase(remotePath), err); return done(); }
            if (t.cancelled) { closeChannel(ch); finishTransfer(t, null); return done(); }
            t.channel = ch;
            withRetry('fastPut ' + remotePath,
                guardedAttempt(t, ch, cb => {
                    t.wrote = true;
                    ch.fastPut(localPath, remotePath, xferOpts(ch, (tr, c, to) => stepTransfer(t, tr, to)), cb);
                }),
                e => {
                    finishTransfer(t, e);
                    if (e && !wasCancelled(t)) noteUploadError(pbase(remotePath), e);
                    if (sftpState.tabId === tab.id && !tab.closed) sftpRefresh();
                    done();
                },
                4, alive(tab));
        });
    });
}

// `tab` is captured once at drop time and threaded all the way down.
function uploadPath(localPath, remoteParent, depth, tab) {
    depth = depth || 0;
    tab = tab || getSftpTab();
    if (!tab) return;
    if (depth > MAX_DEPTH) return noteUploadError(path.basename(localPath), new Error('nesting deeper than ' + MAX_DEPTH + ' levels'));
    let st;
    try { st = fs.lstatSync(localPath); }
    catch (e) { return noteUploadError(path.basename(localPath), e); }
    if (st.isSymbolicLink()) return;

    const base = path.basename(localPath);
    const remote = pjoin(remoteParent, base);

    if (st.isDirectory()) {
        ensureSftp(tab, (err, sftp) => {
            if (err) return noteUploadError(base, err);
            // An existing directory is fine; anything else means the children
            // have nowhere to land, so stop instead of recursing blindly.
            sftp.mkdir(remote, mkErr => {
                if (mkErr) {
                    sftp.stat(remote, (statErr, attrs) => {
                        const exists = !statErr && attrs && typeof attrs.isDirectory === 'function' && attrs.isDirectory();
                        if (!exists) return noteUploadError(base, mkErr);
                        recurse(sftp);
                    });
                    return;
                }
                recurse(sftp);
            });
        });
    } else if (st.isFile()) {
        uploadFile(localPath, remote, tab);
    }

    function recurse() {
        let children = [];
        try { children = fs.readdirSync(localPath); }
        catch (e) { return noteUploadError(base, e); }
        children.forEach(c => uploadPath(path.join(localPath, c), remote, depth + 1, tab));
    }
}


let transfers = [];
let xferSeq = 1;
function addTransfer(name, dir, total) {
    const t = {
        id: xferSeq++, name, dir, total: total || 0, done: 0, speed: 0, status: 'active',
        cancelled: false, finished: false, settle: null, channel: null, tab: null, local: null, remote: null,
        _lastBytes: 0, _lastTime: Date.now(), _cancelTimer: null
    };
    transfers.push(t); renderTransfers(); return t;
}

function transferById(id) { return transfers.find(t => t.id === id) || null; }

// The transfer connection closes itself when idle; it must not do that out from
// under a running transfer.
function hasActiveTransfers(tabId) {
    return transfers.some(t => t.tab && t.tab.id === tabId && (t.status === 'active' || t.status === 'cancelling'));
}

// fastGet/fastPut have no abort hook, so each transfer gets its own SFTP
// channel: ending it aborts that transfer at the protocol level without
// disturbing the file browser or any other transfer on the same connection.
// On a dedicated connection nothing interactive is behind the queue, so the
// full ssh2 default is fine. When that connection could not be made and we are
// sharing the session's own transport, keep much less in flight or the terminal
// stops responding until the transfer ends.
const XFER_OWN = { concurrency: 64, chunkSize: 32768 };
const XFER_SHARED = { concurrency: 16, chunkSize: 32768 };
function xferOpts(ch, step) {
    return Object.assign({}, ch && ch._sshellXfer ? XFER_OWN : XFER_SHARED, { step });
}

// How long a cancel waits for the server to acknowledge the closed channel
// before the transfer is settled locally regardless.
const CANCEL_GRACE_MS = 3000;

// ssh2 only calls fastGet/fastPut back once the server answers. A request left
// pending when the socket dies, or issued on a channel that is already
// closing, is kept forever and never called back — so a transfer cut off by a
// dropped connection froze at its last percentage, and Cancel then left it on
// "cancelling…" for good. Settle the attempt from the channel's own close
// instead; the cancel watchdog covers a dead connection that never sends one.
// `owner` is the transfer record (or putFile's handle): its `cancelled` flag
// decides whether the close counts as a failure, and `settle` lets the
// watchdog force the attempt to finish.
function guardedAttempt(owner, ch, fn) {
    return done => {
        let called = false;
        const once = e => {
            if (called) return; called = true;
            try { ch.removeListener('close', onClose); } catch (err) {}
            if (owner.settle === once) owner.settle = null;
            done(e);
        };
        const onClose = () => once(owner.cancelled ? null : new Error('The connection was closed before the transfer finished.'));
        if (owner.cancelled) return once(null);
        owner.settle = once;
        try { ch.once('close', onClose); } catch (e) {}
        try { fn(once); } catch (e) { once(e); }
    };
}

function openTransferChannel(tab, cb) {
    if (!tab || tab.closed || !tab.client || !tab.connected) return cb(new Error('Not connected.'));
    let settled = false;
    const timer = setTimeout(() => {
        if (settled) return; settled = true;
        cb(new Error('Timed out opening a transfer channel on this host.'));
    }, SFTP_OPEN_TIMEOUT);
    xfer.clientFor(tab, (cerr, client, dedicated) => {
        if (settled) return;
        if (cerr || !client) { settled = true; clearTimeout(timer); return cb(cerr || new Error('No connection available.')); }
        try {
            client.sftp((err, ch) => {
                if (settled) return discardChannel(err ? null : ch);
                settled = true;
                clearTimeout(timer);
                if (err) return cb(err);
                // Transfers on their own connection can keep far more in flight,
                // because nothing they starve is interactive.
                ch._sshellXfer = dedicated;
                ch.on('error', e => errors.record('sftp.transfer', e, tab.title));
                cb(null, ch);
            });
        } catch (e) {
            if (settled) return;
            settled = true;
            clearTimeout(timer); cb(e);
        }
    });
}

// Tear down a channel nobody claimed. The listener matters: end() can emit
// 'error', and an unclaimed 'error' on an EventEmitter throws.
function discardChannel(ch) {
    if (!ch) return;
    try { ch.on('error', () => {}); } catch (e) {}
    closeChannel(ch);
}

function closeChannel(ch) {
    if (!ch) return;
    try { ch.end(); } catch (e) {}
    try { if (typeof ch.destroy === 'function') ch.destroy(); } catch (e) {}
}

// A cancelled transfer leaves a truncated file behind; remove it so the user is
// never left with a half-written file that looks complete.
function discardPartial(t) {
    if (t.dir === 'down') {
        if (!t.local) return;
        setTimeout(() => { try { fs.unlinkSync(t.local); } catch (e) {} }, 150);
        return;
    }
    if (!t.remote || !t.tab || t.keepRemoteOnCancel) return;
    // Nothing was written yet, so there is no partial file — only whatever was
    // already on the server under that name. Deleting it would destroy a file
    // the transfer never touched.
    if (!t.wrote) return;
    // The transfer channel is gone, so clean up over the browsing channel.
    ensureSftp(t.tab, (err, sftp) => {
        if (err) return errors.record('sftp.cancel.cleanup', err);
        sftp.unlink(t.remote, e => {
            if (e && errCode(e) !== 'ENOENT') errors.record('sftp.cancel.cleanup', e, t.remote);
            if (sftpState.tabId === t.tab.id && !t.tab.closed) sftpRefresh();
        });
    });
}

function cancelTransfer(id) {
    const t = transferById(id);
    if (!t || t.status !== 'active' || t.cancelled) return;
    t.cancelled = true;
    t.status = 'cancelling';
    t.speed = 0;
    renderTransfers();
    closeChannel(t.channel);
    // fastGet/fastPut call back with an error once the server acknowledges the
    // close; finishTransfer sees the cancelled flag and removes the partial. A
    // dead connection never acknowledges, so stop waiting for it.
    t._cancelTimer = setTimeout(() => {
        t._cancelTimer = null;
        if (t.settle) t.settle(null); else finishTransfer(t, null);
    }, CANCEL_GRACE_MS);
}

function cancelAllTransfers() { transfers.slice().forEach(t => cancelTransfer(t.id)); }
function stepTransfer(t, transferred, total) {
    t.done = transferred; if (total) t.total = total;
    const now = Date.now(), dt = now - t._lastTime;
    if (dt >= 250) { t.speed = (transferred - t._lastBytes) / (dt / 1000); t._lastBytes = transferred; t._lastTime = now; renderTransfers(); }
}
// Idempotent: the same transfer can be settled by its callback, its channel's
// close and the cancel watchdog, in any order.
function finishTransfer(t, err) {
    if (t.finished) return;
    t.finished = true;
    clearTimeout(t._cancelTimer); t._cancelTimer = null;
    closeChannel(t.channel);
    t.channel = null;
    if (t.cancelled) {
        t.status = 'cancelled';
        t.speed = 0;
        discardPartial(t);
    } else {
        t.status = err ? 'error' : 'done';
        if (!err && t.total) t.done = t.total;
        t.speed = 0;
    }
    renderTransfers();
    const linger = t.status === 'error' ? 6000 : t.status === 'cancelled' ? 3500 : 2500;
    setTimeout(() => { transfers = transfers.filter(x => x.id !== t.id); renderTransfers(); }, linger);
}

// True once the user has cancelled, so callers can skip their success paths.
function wasCancelled(t) { return !!(t && t.cancelled); }
function renderTransfers() {
    const panel = $('sftpTransfers'), list = $('sftpXferList');
    if (!transfers.length) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    const active = transfers.filter(t => t.status === 'active');
    let sumDone = 0, sumTotal = 0, sumSpeed = 0;
    active.forEach(t => { sumDone += t.done; sumTotal += t.total; sumSpeed += t.speed; });
    const pct = sumTotal ? Math.min(100, Math.round(100 * sumDone / sumTotal)) : (active.length ? 0 : 100);
    const summary = $('sftpXferSummary');
    summary.textContent = active.length ? `${active.length} active · ${pct}% · ${humanBytes(sumSpeed)}/s` : 'done';
    const cancelAll = $('sftpXferCancelAll');
    if (cancelAll) cancelAll.classList.toggle('hidden', active.length < 2);

    const X = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>';

    list.innerHTML = transfers.map(t => {
        const p = t.total ? Math.min(100, Math.round(100 * t.done / t.total)) : (t.status === 'done' ? 100 : 0);
        const color = t.status === 'error' ? 'bg-bad'
            : t.status === 'done' ? 'bg-ok'
                : t.status === 'cancelled' ? 'bg-faint' : 'bg-accent';
        const arrow = t.dir === 'up' ? '↑' : '↓';
        const right =
            t.status === 'error' ? '<span class="text-bad">failed</span>'
                : t.status === 'done' ? '<span class="text-ok">done</span>'
                    : t.status === 'cancelled' ? '<span class="text-faint">cancelled</span>'
                        : t.status === 'cancelling' ? '<span class="text-warn">cancelling…</span>'
                            : `${p}% · ${humanBytes(t.speed)}/s`;
        const cancelBtn = t.status === 'active'
            ? `<button class="xfer-cancel shrink-0 w-4 h-4 rounded flex items-center justify-center text-faint hover:text-bad hover:bg-panel3 transition-colors" data-xfer="${t.id}" title="Cancel this transfer">${X}</button>`
            : '<span class="w-4 h-4 shrink-0"></span>';
        return `<div class="px-2 py-1.5 rounded-md bg-panel">
            <div class="flex items-center justify-between gap-2 text-[10px] mb-1">
                <span class="truncate text-txt/90 flex-grow"><span class="text-faint">${arrow}</span> ${escapeHtml(t.name)}</span>
                <span class="font-mono text-muted whitespace-nowrap">${right}</span>
                ${cancelBtn}
            </div>
            <div class="h-1 rounded bg-panel3 overflow-hidden"><div class="h-full ${color} transition-all" style="width:${p}%"></div></div>
        </div>`;
    }).join('');

    list.querySelectorAll('.xfer-cancel').forEach(b =>
        b.addEventListener('click', () => cancelTransfer(Number(b.dataset.xfer))));
}


function init() {
    loadSortPref();
    $('sftpUpload').addEventListener('click', () => { if (busy() || !getSftpTab()) return; $('sftpUploadPicker').click(); });
    $('sftpUploadPicker').addEventListener('change', () => {
        const files = Array.from($('sftpUploadPicker').files || []);
        const target = getSftpTab();
        if (target && sftpState.cwd) files.forEach(f => { const p = filePath(f); if (p) uploadPath(p, sftpState.cwd, 0, target); });
        $('sftpUploadPicker').value = '';
    });
    $('sftpNewFile').addEventListener('click', newSftpFile);
    $('sftpNewFolder').addEventListener('click', newSftpFolder);
    $('sftpRefresh').addEventListener('click', () => { if (!busy()) sftpRefresh(); });
    $('sftpUp').addEventListener('click', () => { if (!busy() && sftpState.cwd) sftpList(pjoin(sftpState.cwd, '..')); });
    $('sftpPath').addEventListener('keydown', e => { if (e.key === 'Enter' && !busy() && $('sftpPath').value.trim()) sftpList($('sftpPath').value.trim()); });

    const sftpDrop = $('sftpDrop');
    let dragDepth = 0;
    sftpDrop.addEventListener('dragenter', e => { if (RT.dragSessId || RT.dragFolderId || RT.dragTabId) return; e.preventDefault(); dragDepth++; $('sftpDropHint').classList.remove('hidden'); });
    sftpDrop.addEventListener('dragover', e => { if (RT.dragSessId || RT.dragFolderId || RT.dragTabId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    sftpDrop.addEventListener('dragleave', () => { if (RT.dragSessId || RT.dragFolderId || RT.dragTabId) return; if (--dragDepth <= 0) { dragDepth = 0; $('sftpDropHint').classList.add('hidden'); } });
    sftpDrop.addEventListener('drop', e => {
        if (RT.dragSessId || RT.dragFolderId || RT.dragTabId) return;
        e.preventDefault(); dragDepth = 0; $('sftpDropHint').classList.add('hidden');
        if (busy()) return;
        if (!getSftpTab()) return dialog.notify('Connect a session first.', { kind: 'warn' });
        if (!sftpState.cwd) return dialog.notify('Open a folder first.', { kind: 'warn' });
        const files = Array.from(e.dataTransfer.files || []);
        const target = getSftpTab();
        if (target) files.forEach(f => { const p = filePath(f); if (p) uploadPath(p, sftpState.cwd, 0, target); });
    });

    $('sftpXferCancelAll').addEventListener('click', cancelAllTransfers);

    $('sftpSelClear').addEventListener('click', () => clearFileSelection());
    $('sftpSelDelete').addEventListener('click', () => { if (sftpState.cwd) deleteSelected(sftpState.cwd); });
    $('sftpSelDownload').addEventListener('click', () => { if (sftpState.cwd) downloadSelected(sftpState.cwd); });

    // Rubber-band select over the file list. Starting on a row would fight the
    // row's own click handling, so only empty space begins a band.
    const marquee = require('./marquee');
    marquee.install();
    sftpDrop.addEventListener('pointerdown', e => {
        if (e.button !== 0 || sftpState.loading) return;
        if (e.target.closest('tr[data-name]')) return;
        // A column header is not empty space: clicking one to re-sort should
        // keep the selection, not drop it and start a band over the list.
        if (e.target.closest('thead')) return;
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) clearFileSelection();
        marquee.begin(e, {
            root: $('sftpBody'),
            clip: sftpDrop,
            itemsSelector: 'tr[data-name]',
            onSelect: (hits, additive) => {
                if (!additive) sftpState.selected.clear();
                hits.forEach(tr => { if (tr.dataset.name !== '..') sftpState.selected.add(tr.dataset.name); });
                // Leave a usable anchor behind, or the next Shift+click adds a
                // single file instead of extending from the band.
                const last = hits.length ? hits[hits.length - 1].dataset.name : null;
                if (last && last !== '..') sftpState.anchor = last;
                paintFileSelection();
            }
        });
    });
    document.addEventListener('click', e => { if (!$('fileMenu').classList.contains('hidden') && !$('fileMenu').contains(e.target)) hideFileMenu(); });
    // Silent: the window is going away, so a dialog cannot be shown — but the
    // temp copies of remote files still need clearing out.
    window.addEventListener('beforeunload', () => RT.tabs.forEach(t => stopWatchers(t, true)));
}

// Shared with the grid bulk uploader so both paths get the same retry and
// dead-channel handling rather than a second copy of fastPut.
// Returns a handle the caller can abort. Runs on its own channel so cancelling
// one server's transfer leaves the others running.
function putFile(tab, localPath, remotePath, onProgress, cb) {
    const handle = { cancelled: false, finished: false, settle: null, channel: null, cancel: null, _cancelTimer: null };
    handle.cancel = () => {
        if (handle.cancelled) return;
        handle.cancelled = true;
        closeChannel(handle.channel);
        // Same watchdog as cancelTransfer: a dead connection never acknowledges
        // the close, and the grid must not wait on it forever.
        handle._cancelTimer = setTimeout(() => {
            handle._cancelTimer = null;
            if (handle.settle) handle.settle(null);
        }, CANCEL_GRACE_MS);
    };

    const finish = e => {
        if (handle.finished) return;
        handle.finished = true;
        clearTimeout(handle._cancelTimer); handle._cancelTimer = null;
        closeChannel(handle.channel);
        handle.channel = null;
        if (handle.cancelled) {
            // Only a transfer that actually began writing left a truncated file
            // behind; cancelling during connect must not delete whatever was
            // already on the server under that name.
            if (handle.wrote) {
                ensureSftp(tab, (er, sftp) => {
                    if (er) return;
                    sftp.unlink(remotePath, u => {
                        if (u && errCode(u) !== 'ENOENT') errors.record('sftp.cancel.cleanup', u, remotePath);
                    });
                });
            }
            const err = new Error('cancelled'); err.cancelled = true;
            return cb(err);
        }
        cb(e);
    };

    openTransferChannel(tab, (err, ch) => {
        if (err) return finish(err);
        if (handle.cancelled) { closeChannel(ch); return finish(null); }
        handle.channel = ch;
        withRetry('fastPut ' + remotePath,
            guardedAttempt(handle, ch, done => {
                handle.wrote = true;
                ch.fastPut(localPath, remotePath,
                    xferOpts(ch, (transferred, chunk, total) => { if (onProgress) onProgress(transferred, total); }),
                    done);
            }),
            finish, 4, alive(tab));
    });

    return handle;
}

function ensureRemoteDir(tab, dir, cb) {
    ensureSftp(tab, (err, sftp) => {
        if (err) return cb(err);
        sftp.stat(dir, (statErr, attrs) => {
            if (!statErr) {
                const isDir = attrs && typeof attrs.isDirectory === 'function' && attrs.isDirectory();
                return cb(isDir ? null : new Error(dir + ' exists but is not a directory.'));
            }
            // mkdir -p: walk the path creating each level, ignoring "already
            // exists" along the way, then confirm the result really is a dir.
            const parts = dir.split('/').filter(Boolean);
            let cur = dir.startsWith('/') ? '' : '.';
            let i = 0;
            const next = () => {
                if (i >= parts.length) {
                    return sftp.stat(dir, (e2, a2) => {
                        if (e2) return cb(e2);
                        const ok = a2 && typeof a2.isDirectory === 'function' && a2.isDirectory();
                        cb(ok ? null : new Error('Could not create ' + dir + '.'));
                    });
                }
                cur = cur + '/' + parts[i++];
                sftp.mkdir(cur, () => next());
            };
            next();
        });
    });
}

module.exports = {
    sftpOnActiveChange, sftpRefresh, targetsTab, onTabClosed, hasActiveTransfers, init,
    putFile, ensureRemoteDir, focusTab, cancelAllTransfers, clearFileSelection
};
