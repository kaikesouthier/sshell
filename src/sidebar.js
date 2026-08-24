
const { $, escapeHtml, genId } = require('./util');
const RT = require('./runtime');
const S = require('./store');
const modal = require('./modal');
const dialog = require('./dialog');
const icons = require('./icons');
const ctxmenu = require('./ctxmenu');
const errors = require('./errors');

function tabsMod() { return require('./tabs'); }
function editorMod() { return require('./editor'); }
function sftpMod() { return require('./sftp'); }
function menuMod() { return require('./menu'); }

// Opening a folder of servers all at once is easy to do by accident, and each
// one is a real connection to a real host.
const BULK_OPEN_WARN = 6;

// Nesting is unlimited, but indentation cannot be — at 12px a level, a tree 90 deep would push every label past the right edge of a 256px sidebar.
const INDENT_STEP = 12;
const MAX_INDENT_LEVELS = 10;
const indentFor = depth => 6 + Math.min(depth, MAX_INDENT_LEVELS) * INDENT_STEP;

const key = (type, id) => type + ':' + id;
const parseKey = k => { const i = k.indexOf(':'); return { type: k.slice(0, i), id: k.slice(i + 1) }; };

function hasSelection() { return RT.selection.size > 0; }
function isSelected(type, id) { return RT.selection.has(key(type, id)); }
function clearSelection(rerender) {
    if (!RT.selection.size) { renderSelectionBar(); return; }
    RT.selection.clear();
    RT.selectionAnchor = null;
    // The bar is driven by renderSidebar, but callers mid-drag must skip the re-render or they destroy the element being dragged.
    if (rerender !== false) renderSidebar();
    else renderSelectionBar();
}

function selectedSessionIds() {
    const out = [];
    RT.selection.forEach(k => { const p = parseKey(k); if (p.type === 'ses') out.push(p.id); });
    return out.filter(id => S.getSession(id));
}
function selectedFolderIds() {
    const out = [];
    RT.selection.forEach(k => { const p = parseKey(k); if (p.type === 'fld') out.push(p.id); });
    return out.filter(id => S.getFolder(id));
}

// Everything reachable from the current selection, de-duplicated: sessions picked directly plus every session inside a picked folder.
function resolveSelectedSessions() {
    const seen = new Set();
    const out = [];
    const push = s => { if (s && !seen.has(s.id)) { seen.add(s.id); out.push(s); } };

    const rowOrder = new Map();
    RT.rows.forEach((r, i) => rowOrder.set(key(r.type, r.id), i));
    const rank = id => {
        const k = key('ses', id);
        return rowOrder.has(k) ? rowOrder.get(k) : Number.MAX_SAFE_INTEGER;
    };
    const storeOrder = new Map(S.store.sessions.map((s, i) => [s.id, i]));

    selectedSessionIds()
        .sort((a, b) => (rank(a) - rank(b)) || ((storeOrder.get(a) || 0) - (storeOrder.get(b) || 0)))
        .forEach(id => push(S.getSession(id)));

    selectedFolderIds().forEach(fid => sessionsInFolder(fid).forEach(push));
    return out;
}

function sessionsInFolder(folderId, seen) {
    seen = seen || new Set();
    if (seen.has(folderId)) return [];
    seen.add(folderId);
    const out = S.store.sessions.filter(s => s.folderId === folderId);
    S.store.folders.filter(f => f.parentId === folderId).forEach(f => out.push(...sessionsInFolder(f.id, seen)));
    return out;
}

// True when `candidateId` sits somewhere below `ancestorId`. Dropping a folder
// into its own descendant would detach that whole branch from the root.
function isDescendantFolder(candidateId, ancestorId) {
    const seen = new Set();
    let cur = S.getFolder(candidateId);
    while (cur && cur.parentId && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (cur.parentId === ancestorId) return true;
        cur = S.getFolder(cur.parentId);
    }
    return false;
}

function toggleSelect(type, id) {
    const k = key(type, id);
    if (RT.selection.has(k)) RT.selection.delete(k);
    else RT.selection.add(k);
    RT.selectionAnchor = RT.selection.has(k) ? k : null;
    renderSidebar();
}

function selectOnly(type, id) {
    RT.selection.clear();
    RT.selection.add(key(type, id));
    RT.selectionAnchor = key(type, id);
    renderSidebar();
}

function selectRangeTo(type, id) {
    const target = key(type, id);
    const order = RT.rows.map(r => key(r.type, r.id));
    const to = order.indexOf(target);
    const from = RT.selectionAnchor ? order.indexOf(RT.selectionAnchor) : -1;
    if (to < 0 || from < 0) return selectOnly(type, id);
    const [a, b] = from <= to ? [from, to] : [to, from];
    for (let i = a; i <= b; i++) RT.selection.add(order[i]);
    renderSidebar();
}

function renderSidebar() {
    const sessionListEl = $('sessionList');
    $('sessCount').textContent = S.store.sessions.length + ' saved';
    const q = ($('sessionSearch').value || '').toLowerCase().trim();
    sessionListEl.innerHTML = '';
    markedEl = null;
    RT.rows = [];
    countCache = buildCounts();
    try {
        renderTree(sessionListEl, q);
    } finally {
        countCache = null;
    }
    renderSelectionBar();
}

function renderTree(sessionListEl, q) {

    // Drop selections whose target no longer exists, or the bulk actions would
    // silently operate on fewer items than the count promises.
    RT.selection.forEach(k => {
        const p = parseKey(k);
        const alive = p.type === 'ses' ? S.getSession(p.id) : S.getFolder(p.id);
        if (!alive) RT.selection.delete(k);
    });

    if (!S.store.sessions.length && !S.store.folders.length) {
        sessionListEl.innerHTML = `<div class="text-center text-xs text-faint px-3 py-8 leading-relaxed">No sessions yet.<br>Click <span class="text-accent">New</span> to add one.</div>`;
        return;
    }
    if (q) {
        const matchFolders = S.store.folders.filter(f => f.name.toLowerCase().includes(q));
        const matches = S.store.sessions.filter(s => (s.label + ' ' + s.host + ' ' + s.username + ' ' + (s.os || '')).toLowerCase().includes(q));
        if (!matches.length && !matchFolders.length) {
            sessionListEl.innerHTML = `<div class="text-center text-xs text-faint px-3 py-8">No matches.</div>`;
            return;
        }
        matchFolders.forEach(f => { RT.rows.push({ type: 'fld', id: f.id }); sessionListEl.appendChild(renderFolderRow(f, 0, true)); });
        matches.forEach(s => { RT.rows.push({ type: 'ses', id: s.id }); sessionListEl.appendChild(renderSessionRow(s, 0)); });
        return;
    }
    S.store.folders.filter(f => !f.parentId).forEach(f => renderFolderInto(sessionListEl, f, 0));
    S.store.sessions.filter(s => !s.folderId).forEach(s => {
        RT.rows.push({ type: 'ses', id: s.id });
        sessionListEl.appendChild(renderSessionRow(s, 0));
    });
}

function renderSelectionBar() {
    const bar = $('selectionBar');
    if (!bar) return;
    const sessCount = selectedSessionIds().length;
    const fldCount = selectedFolderIds().length;
    if (!sessCount && !fldCount) { bar.classList.add('hidden'); return; }
    const total = resolveSelectedSessions().length;
    const parts = [];
    if (sessCount) parts.push(sessCount + ' session' + (sessCount === 1 ? '' : 's'));
    if (fldCount) parts.push(fldCount + ' folder' + (fldCount === 1 ? '' : 's'));
    bar.classList.remove('hidden');
    $('selCount').textContent = parts.join(' · ');
    $('selOpen').textContent = total ? 'Open ' + total : 'Open';
    $('selOpen').disabled = !total;
    $('selOpen').classList.toggle('opacity-40', !total);
}

// Recomputing this per folder row was O(folders² × sessions) — about 10 ms of blocked UI per repaint on a deeply nested tree.
let countCache = null;

function buildCounts() {
    const direct = new Map(), kids = new Map();
    S.store.folders.forEach(f => { direct.set(f.id, 0); kids.set(f.id, []); });
    S.store.folders.forEach(f => { if (f.parentId && kids.has(f.parentId)) kids.get(f.parentId).push(f.id); });
    S.store.sessions.forEach(s => { if (s.folderId && direct.has(s.folderId)) direct.set(s.folderId, direct.get(s.folderId) + 1); });

    const total = new Map(), state = new Map();
    S.store.folders.forEach(root => {
        if (total.has(root.id)) return;
        const stack = [root.id];
        while (stack.length) {
            const id = stack[stack.length - 1];
            if (state.get(id) === 'done') { stack.pop(); continue; }
            if (state.get(id) === 'open') {
                let n = direct.get(id) || 0;
                kids.get(id).forEach(k => { n += total.get(k) || 0; });
                total.set(id, n); state.set(id, 'done'); stack.pop(); continue;
            }
            state.set(id, 'open');
            kids.get(id).forEach(k => { if (state.get(k) !== 'done') stack.push(k); });
        }
    });
    return total;
}

function countFolderSessions(folderId) {
    if (countCache) return countCache.get(folderId) || 0;
    return buildCounts().get(folderId) || 0;
}

// normalizeStore guarantees an acyclic tree, but this recursion paints the UI — a cycle slipping through at runtime would hang the renderer…
function renderFolderInto(parentEl, folder, depth, seen) {
    seen = seen || new Set();
    if (seen.has(folder.id)) return;
    seen.add(folder.id);

    RT.rows.push({ type: 'fld', id: folder.id });
    parentEl.appendChild(renderFolderRow(folder, depth, false));

    if (!folder.collapsed) {
        const childFolders = S.store.folders.filter(f => f.parentId === folder.id);
        const childSessions = S.store.sessions.filter(s => s.folderId === folder.id);
        childFolders.forEach(f => renderFolderInto(parentEl, f, depth + 1, seen));
        childSessions.forEach(s => {
            RT.rows.push({ type: 'ses', id: s.id });
            parentEl.appendChild(renderSessionRow(s, depth + 1));
        });
        if (!childFolders.length && !childSessions.length) {
            // Visually this strip *is* the folder's contents, so it has to accept
            // a drop; otherwise it reads as a dead zone inside the folder.
            const empty = document.createElement('div');
            empty.className = 'text-[10px] text-faint italic py-1 rounded';
            empty.style.paddingLeft = (indentFor(depth + 1) + 20) + 'px';
            empty.textContent = 'empty';
            empty.addEventListener('dragover', e => {
                if (!dragging()) return;
                const bad = RT.dragFolderId && !legalFolderDrop('into', folder.id, 'fld');
                e.preventDefault();
                e.dataTransfer.dropEffect = bad ? 'none' : 'move';
                mark(empty, bad ? 'drop-bad' : 'drop-into');
            });
            empty.addEventListener('dragleave', () => empty.classList.remove('drop-into', 'drop-bad'));
            empty.addEventListener('drop', e => {
                if (!dragging()) return;
                e.preventDefault(); e.stopPropagation();
                clearDropMarks();
                const folderId = RT.dragFolderId, sessId = RT.dragSessId;
                RT.dragFolderId = null; RT.dragSessId = null;
                if (folderId) {
                    if (legalFolderDrop('into', folder.id, 'fld', folderId)) moveFolder(folderId, { parentId: folder.id });
                } else if (sessId) moveSession(sessId, { folderId: folder.id });
            });
            parentEl.appendChild(empty);
        }
    }
}

function renderFolderRow(folder, depth, flat) {
    const count = countFolderSessions(folder.id);
    const selected = isSelected('fld', folder.id);

    const row = document.createElement('div');
    row.className = 'folder-row group flex items-center gap-1.5 pr-1.5 py-1.5 rounded-md cursor-pointer transition-colors ' +
        (selected ? 'is-selected' : 'hover:bg-panel2');
    row.style.paddingLeft = indentFor(depth) + 'px';
    const deepMark = depth > MAX_INDENT_LEVELS
        ? `<span class="text-[9px] text-faint font-mono shrink-0" title="Nesting level ${depth}">L${depth}</span>` : '';
    const folderIcon = folder.icon
        ? icons.iconSvg(folder.icon, folder.iconColor || 'txt', 'w-4 h-4 shrink-0')
        : `<svg class="w-4 h-4 shrink-0 ${folder.collapsed ? 'text-faint' : 'text-txt/80'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"></path></svg>`;
    row.innerHTML = `
        <svg class="chev w-3.5 h-3.5 text-faint shrink-0 ${folder.collapsed || flat ? 'collapsed' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 9l6 6 6-6"></path></svg>
        ${folderIcon}
        <span class="folder-name text-xs font-semibold text-txt/90 truncate flex-grow">${escapeHtml(folder.name)}</span>
        ${deepMark}
        <span class="text-[10px] text-faint font-mono">${count}</span>
        <div class="folder-actions flex items-center gap-0.5 shrink-0">
            <button class="fa-openall w-5 h-5 rounded flex items-center justify-center text-faint hover:text-accent hover:bg-panel3" title="Open all ${count} session(s)"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"></path></svg></button>
            <button class="fa-sub w-5 h-5 rounded flex items-center justify-center text-faint hover:text-accent hover:bg-panel3" title="New subfolder"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 11v4m-2-2h4"></path></svg></button>
            <button class="fa-add w-5 h-5 rounded flex items-center justify-center text-faint hover:text-accent hover:bg-panel3" title="New session here"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 5v14M5 12h14"></path></svg></button>
            <button class="fa-rename w-5 h-5 rounded flex items-center justify-center text-faint hover:text-accent hover:bg-panel3" title="Rename"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.4-9.4a2 2 0 112.8 2.8L11.8 15.8 8 17l1.2-3.8 8.4-8.4z"></path></svg></button>
            <button class="fa-del w-5 h-5 rounded flex items-center justify-center text-faint hover:text-bad hover:bg-panel3" title="Delete folder"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7m3-3h8a1 1 0 011 1v2H7V5a1 1 0 011-1z"></path></svg></button>
        </div>`;

    row.addEventListener('click', e => {
        if (e.target.closest('.fa-openall')) { openFolderSessions(folder.id); return; }
        if (e.target.closest('.fa-sub')) { createFolder(folder.id); return; }
        if (e.target.closest('.fa-add')) { editorMod().openEditor(null, folder.id); return; }
        if (e.target.closest('.fa-rename')) { renameFolder(folder.id); return; }
        if (e.target.closest('.fa-del')) { deleteFolder(folder.id); return; }
        if (e.ctrlKey || e.metaKey) { toggleSelect('fld', folder.id); return; }
        if (e.shiftKey) { selectRangeTo('fld', folder.id); return; }
        if (hasSelection()) { clearSelection(false); }
        if (flat) { $('sessionSearch').value = ''; }
        folder.collapsed = !folder.collapsed;
        S.persist(); renderSidebar();
    });
    row.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        showFolderMenu(e, folder);
    });
    row.draggable = true;
    attachRowDnD(row, { kind: 'fld', id: folder.id, allowInto: true, parentOf: () => folder.parentId || null });
    return row;
}

function renderSessionRow(s, depth) {
    const selected = isSelected('ses', s.id);
    const item = document.createElement('div');
    item.className = 'sess-item group flex items-center gap-2.5 pr-1.5 py-2 rounded-md cursor-pointer transition-colors ' +
        (selected ? 'is-selected' : 'hover:bg-panel2');
    item.style.paddingLeft = (indentFor(depth) + 4) + 'px';
    const avatar = s.icon
        ? icons.iconSvg(s.icon, s.iconColor || 'txt', 'w-5 h-5')
        : `<span class="text-[11px] font-bold text-txt/70 uppercase">${escapeHtml((s.label || s.host || '?').slice(0, 2))}</span>`;

    const subtitle = s.os ? escapeHtml(s.os) : escapeHtml(s.username || '');
    const openCount = RT.tabs.filter(t => t.type === 'terminal' && t.configId === s.id).length;
    item.innerHTML = `
        <div class="w-6 h-6 shrink-0 flex items-center justify-center relative">${avatar}${
            openCount ? `<span class="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-accent text-[8px] font-bold text-white flex items-center justify-center">${openCount > 9 ? '9+' : openCount}</span>` : ''
        }</div>
        <div class="min-w-0 flex-grow">
            <div class="text-xs font-medium text-txt truncate">${escapeHtml(s.label || s.host)}</div>
            <div class="text-[10px] text-faint truncate">${subtitle}</div>
        </div>
        <div class="sess-actions flex items-center gap-0.5 shrink-0">
            <button class="edit-btn w-6 h-6 rounded flex items-center justify-center text-faint hover:text-accent hover:bg-panel3 transition-colors" title="Edit"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.4-9.4a2 2 0 112.8 2.8L11.8 15.8 8 17l1.2-3.8 8.4-8.4z"></path></svg></button>
            <button class="del-btn w-6 h-6 rounded flex items-center justify-center text-faint hover:text-bad hover:bg-panel3 transition-colors" title="Delete"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3m-9 0h14"></path></svg></button>
        </div>`;
    item.addEventListener('click', e => {
        if (e.target.closest('.edit-btn')) { editorMod().openEditor(s.id); return; }
        if (e.target.closest('.del-btn')) { deleteSession(s.id); return; }
        if (e.ctrlKey || e.metaKey) { toggleSelect('ses', s.id); return; }
        if (e.shiftKey) { selectRangeTo('ses', s.id); return; }
        if (hasSelection()) clearSelection(false);
        tabsMod().openTerminalTab(s.id);
    });
    item.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        showSessionMenu(e, s);
    });
    item.draggable = true;
    attachRowDnD(item, { kind: 'ses', id: s.id, allowInto: false, parentOf: () => s.folderId || null });
    return item;
}

function showSessionMenu(e, s) {
    // Right-clicking inside a selection acts on the whole selection; right-
    // clicking outside it means the user moved on, so reset to just this row.
    if (!isSelected('ses', s.id)) selectOnly('ses', s.id);
    const targets = resolveSelectedSessions();
    const multi = targets.length > 1;
    const I = ctxmenu.ICONS;

    const items = multi ? [
        { label: 'Open ' + targets.length + ' sessions', icon: I.stack, act: () => openSessions(targets) },
        { sep: true },
        { label: 'Clear selection', icon: I.x, act: () => clearSelection() },
        { label: 'Delete ' + targets.length + ' sessions', icon: I.trash, danger: true, act: () => deleteSelection() }
    ] : [
        { label: 'Open', icon: I.open, act: () => { clearSelection(false); tabsMod().openTerminalTab(s.id); } },
        { sep: true },
        { label: 'Edit…', icon: I.edit, act: () => editorMod().openEditor(s.id) },
        { label: 'Rename…', icon: I.rename, act: () => renameSession(s.id) },
        { label: 'Duplicate', icon: I.plus, act: () => duplicateSession(s.id) },
        { sep: true },
        { label: 'Delete', icon: I.trash, danger: true, act: () => deleteSession(s.id) }
    ];

    ctxmenu.open(e.clientX, e.clientY, items, {
        title: multi ? targets.length + ' selected' : (s.label || s.host)
    });
}

function showFolderMenu(e, folder) {
    if (!isSelected('fld', folder.id)) selectOnly('fld', folder.id);
    const targets = resolveSelectedSessions();
    const folderIds = selectedFolderIds();
    const multi = folderIds.length > 1 || selectedSessionIds().length > 0;
    const count = countFolderSessions(folder.id);
    const I = ctxmenu.ICONS;

    const items = multi ? [
        { label: 'Open ' + targets.length + ' sessions', icon: I.stack, disabled: !targets.length, act: () => openSessions(targets) },
        { sep: true },
        { label: 'Clear selection', icon: I.x, act: () => clearSelection() },
        { label: 'Delete selection', icon: I.trash, danger: true, act: () => deleteSelection() }
    ] : [
        { label: 'Open all sessions', sublabel: String(count), icon: I.stack, disabled: !count, act: () => openFolderSessions(folder.id) },
        { sep: true },
        { label: 'New session here…', icon: I.plus, act: () => editorMod().openEditor(null, folder.id) },
        { label: 'New subfolder…', icon: I.folder, act: () => createFolder(folder.id) },
        { sep: true },
        { label: 'Rename…', icon: I.rename, act: () => renameFolder(folder.id) },
        { label: 'Change icon…', icon: I.palette, act: () => changeFolderIcon(folder.id) },
        { label: folder.collapsed ? 'Expand' : 'Collapse', icon: I.check, act: () => { folder.collapsed = !folder.collapsed; S.persist(); renderSidebar(); } },
        { sep: true },
        { label: 'Delete folder', icon: I.trash, danger: true, act: () => deleteFolder(folder.id) }
    ];

    ctxmenu.open(e.clientX, e.clientY, items, { title: multi ? 'Selection' : folder.name });
}

function openSessions(list) {
    if (!list.length) return;
    clearSelection(false);
    const tabs = tabsMod();
    // Stagger: opening a dozen tabs in one frame starts a dozen simultaneous
    // handshakes and freezes the UI while they all negotiate.
    list.forEach((s, i) => setTimeout(() => errors.attempt(() => tabs.openTerminalTab(s.id), 'openTerminalTab'), i * 120));
}

async function confirmBulkOpen(list, what) {
    if (list.length <= BULK_OPEN_WARN) return true;
    return dialog.confirm(
        `Open ${list.length} sessions from ${what}?\nThat is ${list.length} simultaneous SSH connections.`,
        { okLabel: `Open ${list.length}` }
    );
}

async function openFolderSessions(folderId) {
    const f = S.getFolder(folderId); if (!f) return;
    const list = sessionsInFolder(folderId);
    if (!list.length) return dialog.notify(`"${f.name}" has no sessions in it.`, { kind: 'warn' });
    if (!(await confirmBulkOpen(list, `"${f.name}"`))) return;
    openSessions(list);
}

async function openSelection() {
    const list = resolveSelectedSessions();
    if (!list.length) return;
    if (!(await confirmBulkOpen(list, 'the selection'))) return;
    openSessions(list);
}

async function deleteSelection() {
    const sessIds = selectedSessionIds();
    const fldIds = selectedFolderIds();
    if (!sessIds.length && !fldIds.length) return;

    // Sessions inside a selected folder go with it; say so up front rather than
    // deleting more than the headline number implies.
    const nested = new Set();
    fldIds.forEach(fid => sessionsInFolder(fid).forEach(s => nested.add(s.id)));
    sessIds.forEach(id => nested.add(id));
    const totalSessions = nested.size;

    const bits = [];
    if (fldIds.length) bits.push(`${fldIds.length} folder${fldIds.length === 1 ? '' : 's'}`);
    if (totalSessions) bits.push(`${totalSessions} session${totalSessions === 1 ? '' : 's'}`);

    const ok = await dialog.confirm(
        `Delete ${bits.join(' and ')}?\nThis cannot be undone.`,
        { danger: true, okLabel: 'Delete' }
    );
    if (!ok) return;

    const dropFolders = new Set(fldIds);
    // Subfolders of a deleted folder go too.
    let grew = true;
    while (grew) {
        grew = false;
        S.store.folders.forEach(f => {
            if (f.parentId && dropFolders.has(f.parentId) && !dropFolders.has(f.id)) { dropFolders.add(f.id); grew = true; }
        });
    }

    S.store.sessions = S.store.sessions.filter(s => !nested.has(s.id) && !dropFolders.has(s.folderId));
    S.store.folders = S.store.folders.filter(f => !dropFolders.has(f.id));

    clearSelection(false);
    S.persist(); renderSidebar(); menuMod().renderTabMenu();
}

async function renameSession(id) {
    const s = S.getSession(id); if (!s) return;
    const r = await modal.askInput({
        title: 'Rename Session', okLabel: 'Save',
        fields: [{ key: 'name', label: 'Session name', value: s.label || s.host }]
    });
    if (!r) return;
    const name = (r.name || '').trim();
    if (!name || name === s.label) return;
    s.label = name;
    S.persist();
    editorMod().updateTabTitles(id, name);
    renderSidebar(); menuMod().renderTabMenu();
}

function duplicateSession(id) {
    const s = S.getSession(id); if (!s) return;
    const copy = Object.assign({}, s, { id: genId('ses'), label: (s.label || s.host) + ' (copy)' });
    const at = S.store.sessions.findIndex(x => x.id === id);
    S.store.sessions.splice(at < 0 ? S.store.sessions.length : at + 1, 0, copy);
    S.persist(); renderSidebar(); menuMod().renderTabMenu();
}

async function deleteSession(id) {
    const s = S.getSession(id);
    if (!s) return;
    if (!(await dialog.confirm(`Delete session "${s.label || s.host}"?\nThis cannot be undone.`, { danger: true, okLabel: 'Delete' }))) return;
    S.store.sessions = S.store.sessions.filter(x => x.id !== id);
    RT.selection.delete(key('ses', id));
    S.persist(); renderSidebar(); menuMod().renderTabMenu();
}

async function createFolder(parentId) {
    const r = await modal.askInput({ title: 'New Folder', okLabel: 'Create', fields: [{ key: 'name', label: 'Folder name', placeholder: 'e.g. Production' }] });
    if (!r || !(r.name || '').trim()) return;
    S.store.folders.push({ id: genId('fld'), name: r.name.trim(), parentId: parentId || null, collapsed: false });
    S.persist(); renderSidebar(); menuMod().renderTabMenu();
}
async function renameFolder(id) {
    const f = S.getFolder(id); if (!f) return;
    const r = await modal.askInput({ title: 'Rename Folder', okLabel: 'Save', fields: [{ key: 'name', label: 'Folder name', value: f.name }] });
    if (!r || !(r.name || '').trim()) return;
    f.name = r.name.trim(); S.persist(); renderSidebar();
}
async function changeFolderIcon(id) {
    const f = S.getFolder(id); if (!f) return;
    const r = await require('./iconpicker').open({ icon: f.icon, color: f.iconColor });
    if (!r) return;
    f.icon = r.icon; f.iconColor = r.color || 'txt';
    S.persist(); renderSidebar();
}
// Every folder id at or below `id`.
function folderSubtree(id) {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
        grew = false;
        S.store.folders.forEach(f => {
            if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
        });
    }
    return out;
}

// Deleting a folder removes what is inside it, matching the multi-select delete.
// It used to quietly reparent the contents instead, which meant "delete" left
// every session behind and the two delete paths disagreed.
async function deleteFolder(id) {
    const f = S.getFolder(id); if (!f) return;
    const drop = folderSubtree(id);
    const sessions = S.store.sessions.filter(s => drop.has(s.folderId));
    const subfolders = drop.size - 1;

    const bits = [];
    if (sessions.length) bits.push(`${sessions.length} session${sessions.length === 1 ? '' : 's'}`);
    if (subfolders) bits.push(`${subfolders} subfolder${subfolders === 1 ? '' : 's'}`);
    const what = bits.length ? ` and its ${bits.join(' and ')}` : '';

    const ok = await dialog.confirm(
        `Delete "${f.name}"${what}?\nThis cannot be undone.`,
        { danger: true, okLabel: sessions.length ? `Delete ${sessions.length + 1} item${sessions.length ? 's' : ''}` : 'Delete folder' }
    );
    if (!ok) return;

    S.store.sessions = S.store.sessions.filter(s => !drop.has(s.folderId));
    S.store.folders = S.store.folders.filter(x => !drop.has(x.id));
    drop.forEach(fid => RT.selection.delete(key('fld', fid)));
    S.persist(); renderSidebar(); menuMod().renderTabMenu();
}

let markedEl = null;
function clearDropMarks() {
    // Track the single marked row rather than scanning the document on every dragover.
    if (markedEl) { markedEl.classList.remove('drop-into', 'drop-before', 'drop-after', 'drop-bad'); markedEl = null; }
    const list = $('sessionList');
    if (list) list.classList.remove('drop-root');
}
function mark(el, cls) {
    clearDropMarks();
    el.classList.add(cls);
    markedEl = el;
}
function dragging() { return RT.dragSessId || RT.dragFolderId; }
function endDrag(el) {
    RT.dragSessId = null; RT.dragFolderId = null;
    if (el) el.classList.remove('dragging');
    clearDropMarks();
    // A cancelled drag never reaches a drop handler, so nothing else would
    // repaint the rows this dragstart de-selected.
    renderSidebar();
}

// Folder rows take a drop three ways: nest into the middle, or become a sibling
// above or below. Session rows only reorder, so they split in half.
function dropZone(e, el, allowInto) {
    const r = el.getBoundingClientRect();
    const y = e.clientY - r.top;
    if (!allowInto) return y < r.height / 2 ? 'before' : 'after';
    if (y < r.height * 0.3) return 'before';
    if (y > r.height * 0.7) return 'after';
    return 'into';
}

// Folders being dragged, minus any whose ancestor is also being dragged — those
// travel with their parent, and moving both would fight over the same subtree.
function draggedFolderIds(id) {
    const ids = isSelected('fld', id) ? selectedFolderIds() : [id];
    return ids.filter(fid => !ids.some(other => other !== fid && isDescendantFolder(fid, other)));
}

function wouldCycle(movingIds, targetParentId) {
    if (!targetParentId) return false;
    return movingIds.some(fid => fid === targetParentId || isDescendantFolder(targetParentId, fid));
}

function attachRowDnD(el, opts) {
    const { kind, id, allowInto, parentOf } = opts;

    el.addEventListener('dragstart', e => {
        if (!isSelected(kind, id)) clearSelection(false);
        if (kind === 'ses') RT.dragSessId = id; else RT.dragFolderId = id;
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', id); } catch (_) {}
    });
    el.addEventListener('dragend', () => endDrag(el));

    el.addEventListener('dragover', e => {
        if (!dragging()) return;
        const zone = dropZone(e, el, allowInto);
        const bad = RT.dragFolderId && !legalFolderDrop(zone, id, kind);
        e.preventDefault();
        e.dataTransfer.dropEffect = bad ? 'none' : 'move';
        mark(el, bad ? 'drop-bad' : 'drop-' + zone);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-into', 'drop-before', 'drop-after', 'drop-bad'));

    el.addEventListener('drop', e => {
        if (!dragging()) return;
        e.preventDefault(); e.stopPropagation();
        const zone = dropZone(e, el, allowInto);
        clearDropMarks();

        // Consume the drag ids here rather than relying on dragend, which is not guaranteed to fire once the source row is detached by a re-render.
        const folderId = RT.dragFolderId, sessId = RT.dragSessId;
        RT.dragFolderId = null; RT.dragSessId = null;

        if (folderId) {
            if (!legalFolderDrop(zone, id, kind, folderId)) return;
            const target = kind === 'fld'
                ? (zone === 'into' ? { parentId: id } : { parentId: parentOf(), [zone === 'before' ? 'beforeId' : 'afterId']: id })
                : { parentId: parentOf() };
            moveFolder(folderId, target);
        } else if (sessId) {
            if (kind === 'fld') {
                moveSession(sessId, zone === 'into' ? { folderId: id } : { folderId: parentOf() });
            } else {
                moveSession(sessId, { folderId: parentOf(), [zone === 'before' ? 'beforeId' : 'afterId']: id });
            }
        }
    });
}

function legalFolderDrop(zone, targetId, targetKind, dragId) {
    const moving = draggedFolderIds(dragId || RT.dragFolderId);
    if (targetKind === 'fld' && zone === 'into') {
        if (moving.includes(targetId)) return false;
        return !wouldCycle(moving, targetId);
    }
    const parent = targetKind === 'fld' ? (S.getFolder(targetId) || {}).parentId : (S.getSession(targetId) || {}).folderId;
    return !wouldCycle(moving, parent || null);
}

// Order the ids the way they appear on screen, then by their position in the store for anything not currently rendered — a collapsed or filtered-out…
function orderForMove(ids, kind, arr) {
    const rowRank = new Map();
    RT.rows.forEach((r, i) => { if (r.type === kind) rowRank.set(r.id, i); });
    const storeRank = new Map(arr.map((x, i) => [x.id, i]));
    return ids.slice().sort((a, b) => {
        const ra = rowRank.has(a) ? rowRank.get(a) : Number.MAX_SAFE_INTEGER;
        const rb = rowRank.has(b) ? rowRank.get(b) : Number.MAX_SAFE_INTEGER;
        return (ra - rb) || ((storeRank.get(a) || 0) - (storeRank.get(b) || 0));
    });
}

// Splice `moving` back in relative to `anchorId`, which is still in `arr`.
// Falls back to appending only when the anchor genuinely cannot be found.
function spliceRelative(arr, moving, anchorId, after) {
    const to = arr.findIndex(x => x.id === anchorId);
    if (to < 0) { arr.push(...moving); return; }
    arr.splice(after ? to + 1 : to, 0, ...moving);
}

function moveFolder(dragId, opts) {
    const ids = draggedFolderIds(dragId);
    if (!ids.length) return;
    const parentId = opts.parentId || null;
    if (wouldCycle(ids, parentId)) {
        return dialog.notify('A folder cannot be moved inside itself or one of its own subfolders.', { kind: 'warn' });
    }
    // Dropping onto a row that is itself being moved has no meaningful destination.
    const anchor = opts.beforeId || opts.afterId || null;
    if (anchor && ids.includes(anchor)) return;

    const arr = S.store.folders;
    const finalIds = orderForMove(ids, 'fld', arr);

    const moving = [];
    finalIds.forEach(fid => {
        const at = arr.findIndex(f => f.id === fid);
        if (at >= 0) moving.push(arr.splice(at, 1)[0]);
    });
    if (!moving.length) return;
    moving.forEach(f => { f.parentId = parentId; });

    if (opts.beforeId) spliceRelative(arr, moving, opts.beforeId, false);
    else if (opts.afterId) spliceRelative(arr, moving, opts.afterId, true);
    else arr.push(...moving);

    S.persist(); renderSidebar();
}

function moveSession(id, opts) {
    // Move every selected session when the dragged row is part of a selection —
    // including ones scrolled or filtered out of view.
    const ids = isSelected('ses', id) ? selectedSessionIds() : [id];
    if (!ids.length) return;
    const anchor = opts.beforeId || opts.afterId || null;
    if (anchor && ids.includes(anchor)) return;

    const arr = S.store.sessions;
    const finalIds = orderForMove(ids, 'ses', arr);

    const moving = [];
    finalIds.forEach(sid => {
        const at = arr.findIndex(s => s.id === sid);
        if (at >= 0) moving.push(arr.splice(at, 1)[0]);
    });
    if (!moving.length) return;

    moving.forEach(s => { s.folderId = opts.folderId || null; });

    if (opts.beforeId) spliceRelative(arr, moving, opts.beforeId, false);
    else if (opts.afterId) spliceRelative(arr, moving, opts.afterId, true);
    else arr.push(...moving);

    S.persist(); renderSidebar();
}

function populateFolderSelect(sel, selectedId) {
    sel.innerHTML = '<option value="">— Ungrouped —</option>';
    const seen = new Set();
    const add = (folder, depth) => {
        if (seen.has(folder.id) || depth > 20) return;
        seen.add(folder.id);
        const opt = document.createElement('option');
        opt.value = folder.id;
        opt.textContent = ' '.repeat(depth * 2) + (depth ? '└ ' : '') + folder.name;
        if (folder.id === selectedId) opt.selected = true;
        sel.appendChild(opt);
        S.store.folders.filter(f => f.parentId === folder.id).forEach(c => add(c, depth + 1));
    };
    S.store.folders.filter(f => !f.parentId).forEach(f => add(f, 0));
}

// ---- Resizable sidebar ---------------------------------------------------
// Sessions and SFTP get their own remembered width: the file browser wants far
// more room than the session tree, and forcing one width on both is annoying.
const SIDEBAR_MIN = 190, SIDEBAR_MAX = 900;
// The window can be as narrow as 940px, so an unconditional 900px sidebar left
// about forty pixels of terminal. The stored width is never rewritten — it is
// only clamped on the way out, so it comes back when the window grows again.
const CONTENT_MIN = 420;
function maxSidebar() {
    const w = (typeof window !== 'undefined' && window.innerWidth) || 1600;
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w - CONTENT_MIN));
}
const DEFAULT_W = { sessions: 256, sftp: 460 };

function sidebarWidthFor(view) {
    const config = require('./config');
    const saved = Number((config.data.sidebarWidth || {})[view]);
    if (isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) return saved;
    return DEFAULT_W[view];
}
function applySidebarWidth(view) {
    const px = Math.min(sidebarWidthFor(view), maxSidebar());
    document.documentElement.style.setProperty('--sidebar-w', px + 'px');
}
let widthSaveTimer = null;
function rememberSidebarWidth(view, px) {
    const config = require('./config');
    if (!config.data.sidebarWidth || typeof config.data.sidebarWidth !== 'object') config.data.sidebarWidth = {};
    config.data.sidebarWidth[view] = px;
    clearTimeout(widthSaveTimer);
    widthSaveTimer = setTimeout(() => errors.attempt(() => config.save(), 'sidebar width'), 400);
}

function installSidebarResizer() {
    const aside = $('sidebar');
    if (!aside || aside.querySelector('.side-grip')) return;
    // A width chosen on a wide monitor must not survive onto a narrow window.
    window.addEventListener('resize', () => applySidebarWidth(RT.sftpMode ? 'sftp' : 'sessions'));
    aside.classList.add('relative');
    const grip = document.createElement('div');
    grip.className = 'side-grip';
    grip.title = 'Drag to resize — double-click to reset';
    aside.appendChild(grip);

    let dragging = false, startX = 0, startW = 0;
    const view = () => (RT.sftpMode ? 'sftp' : 'sessions');

    const move = e => {
        if (!dragging) return;
        const px = Math.round(Math.min(maxSidebar(), Math.max(SIDEBAR_MIN, startW + (e.clientX - startX))));
        document.documentElement.style.setProperty('--sidebar-w', px + 'px');
    };
    const stop = () => {
        if (!dragging) return;
        dragging = false;
        grip.classList.remove('grip-active');
        document.documentElement.classList.remove('resizing-sidebar');
        const px = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10);
        if (isFinite(px)) rememberSidebarWidth(view(), px);
        // Terminals and the canvas need to re-measure against the new width.
        errors.attempt(() => {
            const a = RT.tabs.find(t => t.id === RT.activeTabId);
            if (a && a.type === 'terminal') tabsMod().fitTerminalTab(a);
            else if (a && a.type === 'grid' && a.grid) a.grid.refit();
        }, 'sidebar resize refit');
    };

    grip.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        dragging = true;
        startX = e.clientX;
        startW = aside.getBoundingClientRect().width;
        grip.classList.add('grip-active');
        document.documentElement.classList.add('resizing-sidebar');
        e.preventDefault();
    });
    grip.addEventListener('dblclick', () => {
        const v = view();
        document.documentElement.style.setProperty('--sidebar-w', DEFAULT_W[v] + 'px');
        rememberSidebarWidth(v, DEFAULT_W[v]);
    });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
}

function setSidebarView(mode) {
    RT.sftpMode = mode === 'sftp';
    $('sessionsPane').classList.toggle('hidden', RT.sftpMode);
    $('sessionsPane').classList.toggle('flex', !RT.sftpMode);
    $('sftpPane').classList.toggle('hidden', !RT.sftpMode);
    $('sftpPane').classList.toggle('flex', RT.sftpMode);
    $('tabSessions').classList.toggle('active', !RT.sftpMode);
    $('tabSftp').classList.toggle('active', RT.sftpMode);

    applySidebarWidth(RT.sftpMode ? 'sftp' : 'sessions');
    setTimeout(() => {
        const a = RT.tabs.find(t => t.id === RT.activeTabId);
        if (a && a.type === 'terminal') tabsMod().fitTerminalTab(a);
        else if (a && a.type === 'grid' && a.grid) a.grid.refit();
    }, 180);
    if (RT.sftpMode) sftpMod().sftpOnActiveChange();
}

function selectAllVisible() {
    RT.rows.forEach(r => RT.selection.add(key(r.type, r.id)));
    if (RT.rows.length) RT.selectionAnchor = key(RT.rows[0].type, RT.rows[0].id);
    renderSidebar();
}

function init() {
    const sessionListEl = $('sessionList');
    installSidebarResizer();
    $('btnNewSession').addEventListener('click', () => editorMod().openEditor(null));
    $('btnNewFolder').addEventListener('click', () => createFolder(null));
    $('btnEmptyNew').addEventListener('click', () => editorMod().openEditor(null));
    $('sessionSearch').addEventListener('input', renderSidebar);
    $('btnGrid').addEventListener('click', () => tabsMod().openGridTab());
    $('tabSessions').addEventListener('click', () => setSidebarView('sessions'));
    $('tabSftp').addEventListener('click', () => setSidebarView('sftp'));

    $('selOpen').addEventListener('click', openSelection);
    $('selDelete').addEventListener('click', deleteSelection);
    $('selClear').addEventListener('click', () => clearSelection());

    // Ctrl+A only makes sense while the sidebar has focus; stealing it from a
    // terminal or a text field would be worse than not having the shortcut.
    document.addEventListener('keydown', e => {
        if (!e.ctrlKey && !e.metaKey) return;
        if ((e.key || '').toLowerCase() !== 'a') return;
        if (RT.sftpMode) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (!sessionListEl.contains(t) && t !== document.body) return;
        e.preventDefault();
        selectAllVisible();
    });

    // Dropping on the empty space below the tree moves the item back to the root.
    sessionListEl.addEventListener('dragover', e => {
        if (!dragging() || e.target !== sessionListEl) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDropMarks();
        sessionListEl.classList.add('drop-root');
    });
    sessionListEl.addEventListener('dragleave', e => { if (e.target === sessionListEl) sessionListEl.classList.remove('drop-root'); });
    sessionListEl.addEventListener('drop', e => {
        if (!dragging() || e.target !== sessionListEl) return;
        e.preventDefault();
        sessionListEl.classList.remove('drop-root');
        if (RT.dragFolderId) moveFolder(RT.dragFolderId, { parentId: null });
        else moveSession(RT.dragSessId, { folderId: null });
    });
    sessionListEl.addEventListener('click', e => { if (e.target === sessionListEl && hasSelection()) clearSelection(); });
    sessionListEl.addEventListener('contextmenu', e => {
        if (e.target !== sessionListEl) return;
        e.preventDefault();
        const I = ctxmenu.ICONS;
        ctxmenu.open(e.clientX, e.clientY, [
            { label: 'New session…', icon: I.plus, act: () => editorMod().openEditor(null) },
            { label: 'New folder…', icon: I.folder, act: () => createFolder(null) },
            { sep: true },
            { label: 'Select all', icon: I.check, act: selectAllVisible },
            { label: 'Clear selection', icon: I.x, disabled: !hasSelection(), act: () => clearSelection() }
        ]);
    });
}

module.exports = {
    renderSidebar, setSidebarView, populateFolderSelect, createFolder, init,
    hasSelection, clearSelection, openFolderSessions, deleteSession
};
