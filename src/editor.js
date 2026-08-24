
const { $, genId, filePath } = require('./util');
const S = require('./store');
const sidebar = require('./sidebar');
const icons = require('./icons');

function tabsMod() { return require('./tabs'); }
function menuMod() { return require('./menu'); }

let editingId = null;
let modalAuth = 'password';
let onSaved = null;
let editIcon = null, editIconColor = 'txt';
let revealAuthorised = false;
let revealPending = false;

const SECRET_FIELDS = [['fPassword', 'fPasswordEye'], ['fPassphrase', 'fPassphraseEye']];

function setRevealed(inputId, btnId, on) {
    const input = $(inputId), btn = $(btnId);
    if (!input || !btn) return;
    input.type = on ? 'text' : 'password';
    const show = btn.querySelector('[data-eye="show"]');
    const hide = btn.querySelector('[data-eye="hide"]');
    if (show) show.classList.toggle('hidden', on);
    if (hide) hide.classList.toggle('hidden', !on);
    btn.title = on ? 'Hide' : 'Show (asks for your master passphrase)';
}

function maskSecrets() { SECRET_FIELDS.forEach(([i, b]) => setRevealed(i, b, false)); }

// Hiding never needs permission. Showing does, but only for a secret that was
// loaded from the vault -- what the user just typed into a new session is
// already on screen in their own head.
async function toggleReveal(inputId, btnId) {
    const input = $(inputId);
    if (!input) return;
    if (input.type === 'text') return setRevealed(inputId, btnId, false);
    if (revealPending) return;
    if (editingId && !revealAuthorised) {
        let ok = false;
        const askedFor = editingId;
        revealPending = true;
        try {
            ok = await require('./reauth').confirm({
                message: 'Re-enter your master passphrase to view this stored secret.',
                okLabel: 'Reveal'
            });
        } finally {
            revealPending = false;
        }
        // The prompt can outlive the session it was opened for: closing the
        // editor, or switching to a different session, must not let a late
        // confirmation unmask something the user never asked about.
        if (!ok || editingId !== askedFor || $('sessionModal').classList.contains('hidden')) return;
        revealAuthorised = true;
    }
    setRevealed(inputId, btnId, true);
}

function renderIconPreview() {
    $('fIconPreview').innerHTML = editIcon
        ? icons.iconSvg(editIcon, editIconColor, 'w-6 h-6')
        : icons.iconSvg('server', editIconColor, 'w-6 h-6');
}

function setModalAuth(type) {
    modalAuth = type;
    document.querySelectorAll('.auth-tab').forEach(btn => {
        const on = btn.dataset.auth === type;
        btn.classList.toggle('bg-accent', on);
        btn.classList.toggle('text-white', on);
        btn.classList.toggle('text-muted', !on);
    });
    $('authPassword').classList.toggle('hidden', type !== 'password');
    $('authKey').classList.toggle('hidden', type !== 'key');
}

function openEditor(id, presetFolderId, savedCb) {
    editingId = id || null;
    onSaved = savedCb || null;
    $('modalError').classList.add('hidden');
    revealAuthorised = false;
    maskSecrets();
    const s = id ? S.getSession(id) : null;
    $('modalTitle').textContent = s ? 'Edit Session' : 'New Session';
    $('modalDelete').classList.toggle('hidden', !s);

    $('fLabel').value = s ? s.label : '';
    $('fHost').value = s ? s.host : '';
    $('fPort').value = s ? s.port : 22;
    $('fUser').value = s ? s.username : '';
    $('fPassword').value = s ? s.password : '';
    $('fKeyPath').value = s ? s.keyPath : '';
    $('fPassphrase').value = s ? s.passphrase : '';
    sidebar.populateFolderSelect($('fFolder'), s ? s.folderId : (presetFolderId || ''));
    setModalAuth(s ? s.authType : 'password');
    editIcon = s ? s.icon : null;
    editIconColor = (s && s.iconColor) || 'txt';
    renderIconPreview();

    $('sessionModal').classList.remove('hidden');
    setTimeout(() => $('fLabel').focus(), 30);
}
function closeEditor() {
    maskSecrets();
    revealAuthorised = false;
    $('sessionModal').classList.add('hidden');
    editingId = null;
    onSaved = null;
}
function showModalError(msg) { const e = $('modalError'); e.textContent = msg; e.classList.remove('hidden'); }

function saveEditor() {
    const host = $('fHost').value.trim();
    const username = $('fUser').value.trim();
    if (!host) return showModalError('Host is required.');
    if (!username) return showModalError('Username is required.');
    if (modalAuth === 'key' && !$('fKeyPath').value.trim()) return showModalError('A private key file is required for key auth.');

    // An out-of-range port used to be saved and only fail later as an opaque
    // connection error.
    const portRaw = $('fPort').value.trim();
    const port = portRaw === '' ? 22 : parseInt(portRaw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return showModalError('Port must be a whole number between 1 and 65535.');

    const record = {
        id: editingId || genId('ses'),
        folderId: $('fFolder').value || null,
        label: $('fLabel').value.trim() || host,
        host, port, username,
        authType: modalAuth,
        password: $('fPassword').value,
        keyPath: $('fKeyPath').value.trim(),
        passphrase: $('fPassphrase').value,
        icon: editIcon,
        iconColor: editIconColor,
        os: editingId ? (S.getSession(editingId) || {}).os || null : null
    };
    if (editingId) {
        const i = S.store.sessions.findIndex(s => s.id === editingId);
        if (i !== -1) S.store.sessions[i] = record;
        updateTabTitles(editingId, record.label);
    } else {
        S.store.sessions.push(record);
    }
    S.persist(); sidebar.renderSidebar(); menuMod().renderTabMenu();
    const cb = onSaved; onSaved = null;
    closeEditor();
    if (cb) cb();
}

function updateTabTitles(configId, label) {
    const RT = require('./runtime');
    RT.tabs.filter(t => t.configId === configId).forEach(t => t.title = label);
    tabsMod().renderTabBar();
}

function init() {
    const keyFilePicker = $('keyFilePicker');
    const sessionModal = $('sessionModal');
    $('modalClose').addEventListener('click', closeEditor);
    $('modalCancel').addEventListener('click', closeEditor);
    $('modalSave').addEventListener('click', saveEditor);
    $('modalDelete').addEventListener('click', () => { if (editingId) { const id = editingId; closeEditor(); sidebar.deleteSession(id); } });
    document.querySelectorAll('.auth-tab').forEach(b => b.addEventListener('click', () => setModalAuth(b.dataset.auth)));
    SECRET_FIELDS.forEach(([inputId, btnId]) => {
        const btn = $(btnId);
        if (btn) btn.addEventListener('click', e => { e.preventDefault(); toggleReveal(inputId, btnId); });
    });
    $('fIconBtn').addEventListener('click', async () => {
        const r = await require('./iconpicker').open({ icon: editIcon, color: editIconColor });
        if (r) { editIcon = r.icon; editIconColor = r.color || 'txt'; renderIconPreview(); }
    });
    sessionModal.addEventListener('mousedown', e => { if (e.target === sessionModal) closeEditor(); });
    sessionModal.addEventListener('keydown', e => { if (e.key === 'Enter' && !sessionModal.classList.contains('hidden')) saveEditor(); if (e.key === 'Escape') closeEditor(); });

    $('btnBrowseKey').addEventListener('click', () => keyFilePicker.click());
    keyFilePicker.addEventListener('change', () => { if (keyFilePicker.files && keyFilePicker.files[0]) $('fKeyPath').value = filePath(keyFilePicker.files[0]); keyFilePicker.value = ''; });
}

module.exports = { openEditor, closeEditor, updateTabTitles, init };
