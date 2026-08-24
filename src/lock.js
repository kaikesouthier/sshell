
const fs = require('fs');
const { $ } = require('./util');
const S = require('./store');
const crypto = require('./crypto');
const paths = require('./paths');
const config = require('./config');
const safefile = require('./safefile');

function migrateTheme(data) {
    if (data && data.theme && !config.data.theme) { config.data.theme = data.theme; config.save(); }
    if (data) delete data.theme;
}

// An <input> keeps its value in the DOM until something overwrites it, and the
// lock screen stays in the document after unlocking.
function wipeField(el) {
    if (!el) return;
    try { el.value = ''; el.defaultValue = ''; } catch (e) {}
}

function showLockError(msg) { const e = $('lockError'); e.textContent = msg; e.classList.remove('hidden'); }

// A vault whose ciphertext is damaged fails authentication exactly like a wrong
// passphrase. Telling the user "incorrect passphrase" then sends them retrying
// forever while an intact .bak sits unoffered next to the file.
async function offerBackupEnvelope(err) {
    const dialog = require('./dialog');
    const errors = require('./errors');
    let parsed = null;
    try {
        const p = JSON.parse(fs.readFileSync(paths.sessionsPath() + '.bak', 'utf8'));
        if (crypto.isEnvelope(p)) parsed = p;
    } catch (e) {}
    if (!parsed) return null;

    const ok = await dialog.confirm(
        'sessions.json cannot be read:\n\n' + errors.describe(err) +
        '\n\nThis is not a wrong passphrase — the file itself is damaged. A backup from the ' +
        'previous save is available. Try unlocking that instead?',
        { okLabel: 'Use the backup', cancelLabel: 'Not now', title: 'Damaged vault' }
    );
    return ok ? parsed : null;
}

function lockUnlockFlow(envelopeIn) {
    return new Promise(resolve => {
        let envelope = envelopeIn;
        $('lockTitle').textContent = 'Unlock SSHell';
        $('lockMsg').textContent = 'Enter your master passphrase to decrypt your saved sessions.';
        $('lockPass2').classList.add('hidden');
        $('lockBtn').textContent = 'Unlock';
        $('lockHint').textContent = 'Forgot it? There is no recovery — the data is encrypted. You can delete sessions.json to start over.';
        const pass = $('lockPass'); pass.value = '';
        setTimeout(() => pass.focus(), 50);

        const attempt = async () => {
            $('lockError').classList.add('hidden');
            let opened;
            try {
                opened = crypto.openVault(envelope, pass.value);
            } catch (e) {
                if (!e || e.vaultCode !== 'MALFORMED') { showLockError('Incorrect passphrase. Try again.'); pass.select(); return; }
                const backup = await offerBackupEnvelope(e);
                if (backup) {
                    envelope = backup;
                    showLockError('Backup loaded. Enter your passphrase to unlock it.');
                } else {
                    showLockError('This vault file is damaged: ' + e.message);
                }
                pass.select();
                return;
            }
            try {
                S.vaultKey = opened.vaultKey;
                migrateTheme(opened.data);
                S.store = S.normalizeStore(opened.data);
            } catch (e) {
                // Decryption worked, so the passphrase is right — the payload is malformed.
                S.lockVault();
                showLockError('Unlocked, but the session data is malformed: ' + e.message);
                return;
            }
            // The only moment the passphrase exists in this process. Deriving a
            // stronger key needs it, so the offer has to happen before the wipe.
            try { await require('./vaultupgrade').offerAtUnlock(pass.value); }
            catch (e) { require('./errors').record('vault.upgrade', e); }
            wipeField(pass);
            cleanup(); resolve();
        };
        // attempt() is async now, so an unexpected throw would otherwise be an
        // unhandled rejection with the user left staring at a dead button.
        const run = () => { attempt().catch(e => showLockError('Could not unlock: ' + (e && e.message ? e.message : String(e)))); };
        const onKey = e => { if (e.key === 'Enter') run(); };
        $('lockBtn').addEventListener('click', run);
        pass.addEventListener('keydown', onKey);
        function cleanup() { $('lockBtn').removeEventListener('click', run); pass.removeEventListener('keydown', onKey); }
    });
}

function lockCreateFlow(title, msg) {
    return new Promise(resolve => {
        $('lockTitle').textContent = title || 'Set a master passphrase';
        $('lockMsg').textContent = msg || 'This encrypts your saved sessions. You will enter it each time the app starts.';
        $('lockPass2').classList.remove('hidden');
        $('lockBtn').textContent = 'Create';
        $('lockHint').textContent = 'Choose something you will remember — there is no recovery if you lose it.';
        const p1 = $('lockPass'), p2 = $('lockPass2');
        p1.value = ''; p2.value = '';
        setTimeout(() => p1.focus(), 50);

        const attempt = () => {
            $('lockError').classList.add('hidden');
            const weak = crypto.passphraseProblem(p1.value);
            if (weak) return showLockError(weak);
            if (p1.value !== p2.value) return showLockError('Passphrases do not match.');
            S.vaultKey = crypto.newVaultKey(p1.value);
            wipeField(p1); wipeField(p2);
            cleanup(); resolve();
        };
        const onKey = e => { if (e.key === 'Enter') attempt(); };
        $('lockBtn').addEventListener('click', attempt);
        p1.addEventListener('keydown', onKey); p2.addEventListener('keydown', onKey);
        function cleanup() { $('lockBtn').removeEventListener('click', attempt); p1.removeEventListener('keydown', onKey); p2.removeEventListener('keydown', onKey); }
    });
}

// A backup is only worth offering if it actually looks like a vault.
function looksLikeStore(o) {
    if (!o || typeof o !== 'object') return false;
    if (crypto.isEnvelope(o)) return true;
    if (Array.isArray(o)) return true;
    return Array.isArray(o.sessions) || Array.isArray(o.folders);
}

// Unreadable vault: offer the .bak, otherwise let the user start over rather
// than stranding them on a dead lock screen with no way forward.
async function recoverUnreadable(SP, err) {
    const dialog = require('./dialog');
    const errors = require('./errors');
    let bak = null;
    try {
        const parsed = JSON.parse(fs.readFileSync(SP + '.bak', 'utf8'));
        if (looksLikeStore(parsed)) bak = parsed;
    } catch (e) {}

    if (bak) {
        const ok = await dialog.confirm(
            'sessions.json could not be read:\n\n' + errors.describe(err) +
            '\n\nA backup from the previous save is available. Restore it?',
            { okLabel: 'Restore backup', cancelLabel: 'Not now', title: 'Cannot read sessions' }
        );
        if (ok) return bak;
    }

    const start = await dialog.confirm(
        'sessions.json could not be read:\n\n' + errors.describe(err) +
        '\n\nYou can start with an empty session list. The existing file will be renamed, not deleted, so you can recover it later.',
        { danger: true, okLabel: 'Start fresh', cancelLabel: 'Quit', title: 'Cannot read sessions' }
    );
    if (!start) return null;

    try { fs.renameSync(SP, SP + '.corrupt-' + Date.now()); }
    catch (e) {
        await dialog.notify('Could not rename the damaged file:\n\n' + errors.describe(e), { kind: 'error' });
        return null;
    }
    return undefined;
}

// persist() reports its own failure and returns false rather than throwing.
async function requirePersist(what) {
    if (S.persist()) return true;
    const dialog = require('./dialog');
    await dialog.notify(
        'SSHell cannot write to its data folder, so ' + what + ' could not be saved.\n\n' +
        'Location:\n' + paths.getDataDir() + '\n\n' +
        'Fix the folder permissions (or free up disk space) and start the app again. ' +
        'Nothing has been changed on disk.',
        { kind: 'error', title: 'Cannot save' }
    );
    return false;
}

async function bootWithGate(onReady) {
    const SP = paths.sessionsPath();
    // Do not gate on existsSync: that made readWithBackup's .bak fallback dead code for the vault, so a vanished sessions.json with an intact backup was…
    let exists = false;
    try { exists = fs.existsSync(SP) || fs.existsSync(SP + '.bak'); } catch (e) {}

    if (!exists) {
        await lockCreateFlow('Welcome to SSHell', 'Create a master passphrase to encrypt your sessions. You will enter it each time the app starts.');
        S.store = { folders: [], sessions: [] };
        if (!(await requirePersist('your new vault'))) return false;
    } else {
        let parsed;
        try {
            parsed = JSON.parse(safefile.readWithBackup(SP).text);
        } catch (e) {
            $('lockTitle').textContent = 'Cannot read sessions';
            const recovered = await recoverUnreadable(SP, e);
            if (recovered === null) {
                showLockError('sessions.json is unreadable. Fix or move it, then restart.');
                return false;
            }
            parsed = recovered;
            $('lockTitle').textContent = 'Unlock SSHell';
        }

        if (parsed === undefined) {
            await lockCreateFlow('Start fresh', 'Create a master passphrase to encrypt your sessions.');
            S.store = { folders: [], sessions: [] };
            if (!(await requirePersist('your new vault'))) return false;
        } else if (crypto.isEnvelope(parsed)) {
            await lockUnlockFlow(parsed);
        } else {
            migrateTheme(parsed);
            S.store = S.normalizeStore(parsed);
            await lockCreateFlow('Encrypt your sessions', 'Existing sessions were found unencrypted. Set a master passphrase to protect them.');
            if (!(await requirePersist('your newly encrypted sessions'))) return false;
        }
    }
    $('lockScreen').classList.add('hidden');
    if (onReady) onReady();
    return true;
}

module.exports = { bootWithGate };
