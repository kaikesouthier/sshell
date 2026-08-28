
const fs = require('fs');
const path = require('path');
const { clipboard, ipcRenderer } = require('electron');
const { $, escapeHtml } = require('./util');
const S = require('./store');
const config = require('./config');
const paths = require('./paths');
const modal = require('./modal');
const dialog = require('./dialog');
const reauth = require('./reauth');

let revealed = false;

function openConfig() {
    revealed = false;
    $('cfgDataDir').value = paths.getDataDir();
    $('cfgPwLocked').classList.remove('hidden');
    $('cfgPwUnlocked').classList.add('hidden');
    $('cfgPwSearch').value = '';
    wipeRevealed();
    $('configModal').classList.remove('hidden');
}

// Revealing wrote every password into data-secret attributes.
function wipeRevealed() {
    const body = $('cfgPwTable');
    if (!body) return;
    // Overwrite any row left revealed before tearing the table down, so a shown
    // secret never lingers in a detached node.
    body.querySelectorAll('.pw-val').forEach(el => { el.textContent = ''; el.dataset.shown = '0'; });
    body.innerHTML = '';
}

function closeConfig() {
    $('configModal').classList.add('hidden');
    revealed = false;
    $('cfgPwSearch').value = '';
    $('cfgPwLocked').classList.remove('hidden');
    $('cfgPwUnlocked').classList.add('hidden');
    wipeRevealed();
}

async function changeDir() {
    const res = await ipcRenderer.invoke('open-dialog', { properties: ['openDirectory', 'createDirectory'], title: 'Choose storage folder' });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return;
    const dir = res.filePaths[0];
    if (dir === paths.getDataDir()) return;
    const ok = await dialog.confirm(`Use this folder for SSHell data?\n\n${dir}\n\nYour current config and sessions will be written here and used from now on.`, { okLabel: 'Use folder' });
    if (!ok) return;

    // config.save() and S.persist() report their own failures and return rather than throwing, so the old try/catch never fired: a folder that could not…
    const previous = paths.getDataDir();
    paths.setDataDir(dir);

    let failure = null;
    try {
        config.save();
        if (!S.persist()) failure = 'The session vault could not be written there.';
        else if (!fs.existsSync(paths.sessionsPath())) failure = 'The session file is missing after writing.';
        else if (!fs.existsSync(paths.configPath())) failure = 'The config file is missing after writing.';
    } catch (e) {
        failure = e.message;
    }

    if (failure) {
        paths.setDataDir(previous);
        $('cfgDataDir').value = paths.getDataDir();
        dialog.notify(
            'Could not use that folder:\n\n' + failure +
            '\n\nYour storage location is unchanged — still:\n' + previous,
            { kind: 'error', title: 'Storage location not changed' }
        );
        return;
    }

    $('cfgDataDir').value = paths.getDataDir();
    dialog.notify('Storage location updated.\nExisting files in the previous folder were left untouched.', { kind: 'success', title: 'Done' });
}

async function reveal() {
    const ok = await reauth.confirm({ message: 'Re-enter your master passphrase to view stored passwords.', okLabel: 'Unlock' });
    if (!ok) return;
    revealed = true;
    $('cfgPwLocked').classList.add('hidden');
    $('cfgPwUnlocked').classList.remove('hidden');
    renderPwTable();
}

function renderPwTable() {
    const q = ($('cfgPwSearch').value || '').toLowerCase().trim();
    const rows = S.store.sessions.filter(s => !q || (s.label + ' ' + s.host + ' ' + s.username).toLowerCase().includes(q));
    const body = $('cfgPwTable');
    if (!rows.length) { body.innerHTML = `<tr><td colspan="4" class="px-2.5 py-6 text-center text-faint">No servers${q ? ' match' : ''}.</td></tr>`; return; }
    body.innerHTML = rows.map(s => {
        const isKey = s.authType === 'key';
        return `<tr class="border-t border-edge/50" data-id="${escapeHtml(s.id)}">
            <td class="px-2.5 py-1.5 text-txt/90 font-medium">${escapeHtml(s.label || s.host)}</td>
            <td class="px-2.5 py-1.5 font-mono text-muted">${escapeHtml(s.host)}${s.port && s.port !== 22 ? ':' + s.port : ''}</td>
            <td class="px-2.5 py-1.5 font-mono text-muted">${escapeHtml(s.username)}</td>
            <td class="px-2.5 py-1.5">
                <div class="flex items-center gap-1.5">
                    <span class="pw-val font-mono text-txt/90 truncate max-w-[180px]" data-shown="0">••••••••</span>
                    <button class="pw-eye text-faint hover:text-accent shrink-0" title="Show/hide"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.46 12C3.73 7.94 7.52 5 12 5s8.27 2.94 9.54 7c-1.27 4.06-5.06 7-9.54 7s-8.27-2.94-9.54-7z"></path></svg></button>
                    <button class="pw-copy text-faint hover:text-accent shrink-0" title="Copy"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-2M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2"></path></svg></button>
                    ${isKey ? '<span class="text-[9px] text-faint uppercase tracking-wide">key</span>' : ''}
                </div>
            </td>
        </tr>`;
    }).join('');
    // The secret is looked up from the store only when the user actually reveals
    // or copies that one row, so at rest not a single password sits in the DOM —
    // even after the master-passphrase gate has been passed.
    body.querySelectorAll('.pw-eye').forEach(btn => btn.addEventListener('click', () => {
        const tr = btn.closest('tr');
        const span = tr.querySelector('.pw-val');
        if (span.dataset.shown === '1') { span.textContent = '••••••••'; span.dataset.shown = '0'; return; }
        const s = S.getSession(tr.dataset.id);
        if (!s) return;
        span.textContent = secretOf(s);
        span.dataset.shown = '1';
    }));
    body.querySelectorAll('.pw-copy').forEach(btn => btn.addEventListener('click', () => {
        const s = S.getSession(btn.closest('tr').dataset.id);
        if (!s) return;
        clipboard.writeText(secretOf(s));
        dialog.notify('Copied to clipboard.', { kind: 'success', title: 'Copied' });
    }));
}

function secretOf(s) {
    return s.authType === 'key' ? (s.keyPath || '(no key path)') : (s.password || '(empty)');
}

function init() {
    $('cfgClose').addEventListener('click', closeConfig);
    $('cfgDone').addEventListener('click', closeConfig);
    $('configModal').addEventListener('mousedown', e => { if (e.target === $('configModal')) closeConfig(); });
    $('cfgChangeDir').addEventListener('click', changeDir);
    $('cfgReveal').addEventListener('click', reveal);
    $('cfgPwSearch').addEventListener('input', () => { if (revealed) renderPwTable(); });
}

module.exports = { openConfig, closeConfig, init };
