
const { $, escapeHtml } = require('./util');
const S = require('./store');
const crypto = require('./crypto');
const modal = require('./modal');
const dialog = require('./dialog');
const reauth = require('./reauth');
const sidebar = require('./sidebar');
const bulk = require('./bulk');
const editor = require('./editor');
const configpage = require('./configpage');

function tabsMod() { return require('./tabs'); }

let openMenu = null;

function renderTabMenu() {
    const tabMenuList = $('tabMenuList');
    tabMenuList.innerHTML = '';
    if (!S.store.sessions.length) { tabMenuList.innerHTML = `<div class="text-xs text-faint px-3 py-4 text-center">No saved sessions.</div>`; return; }
    S.store.sessions.forEach(s => {
        const row = document.createElement('button');
        row.className = 'w-full text-left px-3 py-2 rounded-md hover:bg-panel3 transition-colors flex items-center gap-2.5';
        row.innerHTML = `<span class="w-6 h-6 shrink-0 flex items-center justify-center text-[10px] font-bold text-txt/70 uppercase">${escapeHtml((s.label || s.host || '?').slice(0, 2))}</span>
            <span class="min-w-0"><span class="block text-xs text-txt truncate">${escapeHtml(s.label || s.host)}</span><span class="block text-[10px] text-faint font-mono truncate">${escapeHtml(s.host)}</span></span>`;
        row.addEventListener('click', () => { hideTabMenu(); tabsMod().openTerminalTab(s.id); });
        tabMenuList.appendChild(row);
    });
}
function showTabMenu() {
    renderTabMenu();
    const tabMenu = $('tabMenu');
    const b = $('btnNewTab').getBoundingClientRect();
    tabMenu.style.top = (b.bottom + 4) + 'px'; tabMenu.style.right = '8px'; tabMenu.style.left = 'auto';
    tabMenu.classList.remove('hidden');
}
function hideTabMenu() { $('tabMenu').classList.add('hidden'); }

function menus() {
    const vaultupgrade = require('./vaultupgrade');
    const upgradeItem = vaultupgrade.needsUpgrade()
        ? [{ label: 'Strengthen Vault Encryption…', act: () => vaultupgrade.upgradeInteractive() }]
        : [];
    return {
        file: [
            { label: 'New Session…', act: () => editor.openEditor(null) },
            { label: 'New Folder…', act: () => sidebar.createFolder(null) },
            { label: 'Add Multiple Servers…', act: () => bulk.openBulk() },
            { sep: true },
            { label: 'Import Configuration…', act: importConfig },
            { label: 'Export (Encrypted .sshm)…', act: exportEncrypted },
            { label: 'Export (Plain text .json)…', act: exportPlain },
            { sep: true },
            { label: 'Configuration…', act: () => configpage.openConfig() },
            { label: 'Change Master Passphrase…', act: changePassphrase },
            ...upgradeItem,
            { sep: true },
            { label: 'Exit', act: () => window.close() }
        ],
        edit: [
            { label: 'Customization (Theme Builder)…', act: () => require('./theme').openThemeBuilder() },
            { sep: true },
            { label: 'Expand All Folders', act: () => { S.store.folders.forEach(f => f.collapsed = false); S.persist(); sidebar.renderSidebar(); } },
            { label: 'Collapse All Folders', act: () => { S.store.folders.forEach(f => f.collapsed = true); S.persist(); sidebar.renderSidebar(); } },
            { sep: true },
            { label: 'Open Grid Dashboard', act: () => tabsMod().openGridTab() }
        ],
        tools: [
            { label: 'Port Scanner…', act: () => require('./tools').openPortScanner() },
            { label: 'CIDR Ping…', act: () => require('./tools').openCidrPing() },
            { sep: true },
            { label: 'Keyboard Shortcuts', act: () => require('./shortcuts').open() },
            { label: 'About SSHell', act: showAbout }
        ]
    };
}
function openMenuDropdown(name, btn) {
    openMenu = name;
    const menuDropdown = $('menuDropdown');
    document.querySelectorAll('.menu-btn').forEach(b => b.classList.toggle('open', b.dataset.menu === name));
    menuDropdown.innerHTML = '';
    menus()[name].forEach(item => {
        if (item.sep) { const d = document.createElement('div'); d.className = 'my-1 border-t border-edge'; menuDropdown.appendChild(d); return; }
        const el = document.createElement('button');
        el.className = 'w-full text-left px-3 py-1.5 text-[13px] text-txt/90 hover:bg-accent hover:text-white transition-colors';
        el.textContent = item.label;
        el.addEventListener('click', () => { closeMenu(); item.act(); });
        menuDropdown.appendChild(el);
    });
    const r = btn.getBoundingClientRect();
    menuDropdown.style.left = r.left + 'px'; menuDropdown.style.top = r.bottom + 'px'; menuDropdown.style.right = 'auto';
    menuDropdown.classList.remove('hidden');
}
function closeMenu() {
    openMenu = null;
    $('menuDropdown').classList.add('hidden');
    document.querySelectorAll('.menu-btn').forEach(b => b.classList.remove('open'));
}
function isMenuOpen() { return !!openMenu; }

function showAbout() {
    modal.askInput({ title: 'SSHell', message: 'A modern SSH session manager with tabs, an SFTP client, live monitoring, and full theming. Sessions are encrypted at rest with AES-256-GCM.', okLabel: 'Close', fields: [] });
}

const downloadFile = (name, text) => require('./util').downloadText(name, text);

async function exportEncrypted() {
    if (!await reauth.confirm({ message: 'Re-enter your master passphrase to export every saved session.', okLabel: 'Continue' })) return;
    const r = await modal.askInput({
        title: 'Export (Encrypted)', message: 'Choose a passphrase for the exported file. You will need it to import elsewhere.', okLabel: 'Export',
        fields: [{ key: 'p1', label: 'Passphrase', type: 'password' }, { key: 'p2', label: 'Confirm passphrase', type: 'password' }]
    });
    if (!r) return;
    const weakExport = crypto.passphraseProblem(r.p1);
    if (weakExport) return dialog.notify(weakExport, { kind: 'warn' });
    if (r.p1 !== r.p2) return dialog.notify('Passphrases do not match.', { kind: 'warn' });
    downloadFile('ssh-sessions.sshm', JSON.stringify(crypto.encryptData(S.store, r.p1), null, 2));
    dialog.notify('Exported to your Downloads folder as ssh-sessions.sshm', { kind: 'success', title: 'Exported' });
}
async function exportPlain() {
    const ok = await dialog.confirm('Export as PLAIN TEXT?\nThis file will contain your passwords/keys in the clear. Store it carefully.', { danger: true, okLabel: 'Export anyway' });
    if (!ok) return;
    if (!await reauth.confirm({ message: 'Re-enter your master passphrase to write every password and key to an unencrypted file.', okLabel: 'Export' })) return;
    downloadFile('ssh-sessions.json', JSON.stringify(S.store, null, 2));
    dialog.notify('Exported to your Downloads folder as ssh-sessions.json', { kind: 'success', title: 'Exported' });
}
function importConfig() { $('importFilePicker').click(); }
function mergeImported(imported) {
    const { genId } = require('./util');
    const map = {};
    imported.folders.forEach(f => { map[f.id] = genId('fld'); });
    // Spread the source folder rather than rebuilding it field by field, which
    // silently dropped icon and iconColor on every import.
    imported.folders.forEach(f => S.store.folders.push(Object.assign({}, f, {
        id: map[f.id],
        parentId: f.parentId ? (map[f.parentId] || null) : null,
        collapsed: !!f.collapsed
    })));
    imported.sessions.forEach(s => S.store.sessions.push(Object.assign({}, s, {
        id: genId('ses'),
        folderId: s.folderId ? (map[s.folderId] || null) : null
    })));
}
async function onImportFile() {
    const fs = require('fs');
    const picker = $('importFilePicker');
    const file = picker.files && picker.files[0];
    picker.value = '';
    if (!file) return;
    let text;
    try { text = fs.readFileSync(require('./util').filePath(file), 'utf8'); } catch (e) { return dialog.notify('Could not read file: ' + e.message, { kind: 'error' }); }
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { return dialog.notify('That file is not a valid SSHell export.', { kind: 'error' }); }

    let imported;
    if (crypto.isEnvelope(parsed)) {
        while (true) {
            const r = await modal.askInput({ title: 'Import — Unlock', message: 'This export is encrypted. Enter its passphrase.', okLabel: 'Unlock', fields: [{ key: 'p', label: 'Passphrase', type: 'password' }] });
            if (!r) return;
            try { imported = S.normalizeStore(crypto.decryptData(parsed, r.p)); break; }
            catch (e) { await dialog.notify('Incorrect passphrase.', { kind: 'error' }); }
        }
    } else imported = S.normalizeStore(parsed);

    const total = imported.sessions.length;
    if (!total && !imported.folders.length) return dialog.notify('Nothing to import.', { kind: 'warn' });
    const ok = await dialog.confirm(`Import ${total} session(s) and ${imported.folders.length} folder(s)?\nThey will be added to your current list.`, { okLabel: 'Import' });
    if (!ok) return;
    mergeImported(imported);
    S.persist(); sidebar.renderSidebar(); renderTabMenu();
    dialog.notify(`Imported ${total} session(s).`, { kind: 'success', title: 'Imported' });
}
async function changePassphrase() {
    const r = await modal.askInput({
        title: 'Change Master Passphrase', okLabel: 'Change',
        fields: [
            { key: 'cur', label: 'Current passphrase', type: 'password' },
            { key: 'n1', label: 'New passphrase', type: 'password' },
            { key: 'n2', label: 'Confirm new passphrase', type: 'password' }
        ]
    });
    if (!r) return;
    if (!crypto.verifyKey(r.cur, S.vaultKey)) return dialog.notify('Current passphrase is incorrect.', { kind: 'error' });
    const weak = crypto.passphraseProblem(r.n1);
    if (weak) return dialog.notify(weak, { kind: 'warn' });
    if (r.n1 !== r.n2) return dialog.notify('New passphrases do not match.', { kind: 'warn' });
    // A new passphrase gets a new salt, so the old file cannot be re-derived
    // from the new key. Keep the previous key until the rewrite lands — a failed
    // write would otherwise leave the app holding a key that no longer opens
    // what is on disk.
    const previous = S.vaultKey;
    S.vaultKey = crypto.newVaultKey(r.n1);
    if (!S.persist()) {
        crypto.zeroKey(S.vaultKey);
        S.vaultKey = previous;
        return;
    }
    crypto.zeroKey(previous);
    // writeAtomic refreshes the .bak from the file as it was, so the single
    // rewrite above left a complete copy of the vault still readable with the
    // passphrase the user just moved away from.
    try { require('fs').unlinkSync(S.sessionsPath() + '.bak'); } catch (e) {}
    dialog.notify('Master passphrase changed.', { kind: 'success', title: 'Done' });
}

function init() {
    document.querySelectorAll('.menu-btn').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); if (openMenu === btn.dataset.menu) closeMenu(); else openMenuDropdown(btn.dataset.menu, btn); });
        btn.addEventListener('mouseenter', () => { if (openMenu && openMenu !== btn.dataset.menu) openMenuDropdown(btn.dataset.menu, btn); });
    });
    $('btnNewTab').addEventListener('click', e => { e.stopPropagation(); if ($('tabMenu').classList.contains('hidden')) showTabMenu(); else hideTabMenu(); });
    $('tabMenuNew').addEventListener('click', () => { hideTabMenu(); editor.openEditor(null); });
    $('importFilePicker').addEventListener('change', onImportFile);

    document.addEventListener('click', e => {
        if (!$('tabMenu').classList.contains('hidden') && !$('tabMenu').contains(e.target) && !e.target.closest('#btnNewTab')) hideTabMenu();
        if (openMenu && !e.target.closest('#menuDropdown') && !e.target.closest('.menu-btn')) closeMenu();
    });
}

module.exports = { renderTabMenu, showTabMenu, hideTabMenu, closeMenu, isMenuOpen, init };
