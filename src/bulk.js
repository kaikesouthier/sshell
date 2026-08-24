
const { $, genId, filePath } = require('./util');
const S = require('./store');
const sidebar = require('./sidebar');

function menuMod() { return require('./menu'); }

let bulkAuth = 'password';

function setBulkAuth(t) {
    bulkAuth = t;
    document.querySelectorAll('.bauth-tab').forEach(b => {
        const on = b.dataset.bauth === t;
        b.classList.toggle('bg-accent', on); b.classList.toggle('text-white', on); b.classList.toggle('text-muted', !on);
    });
    $('bAuthPassword').classList.toggle('hidden', t !== 'password');
    $('bAuthKey').classList.toggle('hidden', t !== 'key');
}
function parseBulkLines() {
    return ($('bLines').value || '').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
        const m = line.split(/\s*[,|]\s*/);
        if (m.length >= 2 && m[0]) return { name: m[0], host: (m[1] || '').trim() };
        return { name: null, host: line };
    }).filter(e => e.host);
}
function updateBulkCount() { const n = parseBulkLines().length; $('bulkCount').textContent = n ? `${n} server${n === 1 ? '' : 's'} will be created` : ''; }
function openBulk() {
    $('bLines').value = ''; $('bTemplate').value = '{host}'; $('bPort').value = 22;
    $('bUser').value = ''; $('bPassword').value = ''; $('bKeyPath').value = ''; $('bPassphrase').value = '';
    sidebar.populateFolderSelect($('bFolder'), '');
    setBulkAuth('password'); $('bulkError').classList.add('hidden'); updateBulkCount();
    $('bulkModal').classList.remove('hidden');
    setTimeout(() => $('bLines').focus(), 30);
}
function closeBulk() { $('bulkModal').classList.add('hidden'); }
function saveBulk() {
    const lines = parseBulkLines();
    const user = $('bUser').value.trim();
    const err = m => { const e = $('bulkError'); e.textContent = m; e.classList.remove('hidden'); };
    if (!lines.length) return err('Add at least one host.');
    if (!user) return err('Username is required.');
    if (bulkAuth === 'key' && !$('bKeyPath').value.trim()) return err('A private key file is required for key auth.');
    const tmpl = $('bTemplate').value || '{host}';
    const folderId = $('bFolder').value || null;
    const portRaw = $('bPort').value.trim();
    const port = portRaw === '' ? 22 : parseInt(portRaw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return err('Port must be a whole number between 1 and 65535.');
    lines.forEach((ln, i) => {
        const label = ln.name || tmpl.replace(/\{n\}/g, i + 1).replace(/\{host\}/g, ln.host);
        S.store.sessions.push({
            id: genId('ses'), folderId, label, host: ln.host, port, username: user,
            authType: bulkAuth, password: $('bPassword').value,
            keyPath: $('bKeyPath').value.trim(), passphrase: $('bPassphrase').value
        });
    });
    S.persist(); sidebar.renderSidebar(); menuMod().renderTabMenu(); closeBulk();
}

function init() {
    const bulkModal = $('bulkModal');
    $('btnBulkAdd').addEventListener('click', openBulk);
    $('bulkClose').addEventListener('click', closeBulk);
    $('bulkCancel').addEventListener('click', closeBulk);
    $('bulkSave').addEventListener('click', saveBulk);
    $('bLines').addEventListener('input', updateBulkCount);
    document.querySelectorAll('.bauth-tab').forEach(b => b.addEventListener('click', () => setBulkAuth(b.dataset.bauth)));
    bulkModal.addEventListener('mousedown', e => { if (e.target === bulkModal) closeBulk(); });

    const picker = document.createElement('input'); picker.type = 'file'; picker.className = 'hidden'; document.body.appendChild(picker);
    $('bBrowseKey').addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => { if (picker.files[0]) $('bKeyPath').value = filePath(picker.files[0]); picker.value = ''; });
}

module.exports = { openBulk, closeBulk, init };
