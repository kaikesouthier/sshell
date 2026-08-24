
const fs = require('fs');
const crypto = require('./crypto');
const S = require('./store');
const paths = require('./paths');
const config = require('./config');

function dialogMod() { return require('./dialog'); }

// Vaults created before the cost was raised keep their original parameters on
// every save, so that an older build can still open the file. That is the right
// default, but it also means such a vault stays permanently cheaper to attack
// offline — and the re-auth gate, which re-derives as its throttle, is
// correspondingly cheaper to hammer. The only way out is to re-encrypt.
function needsUpgrade() {
    const vk = S.vaultKey;
    return !!(vk && vk.key && vk.params && vk.params.n < crypto.CURRENT.n);
}

function costLabel(params) {
    const mib = Math.round(128 * (params.n || 0) * (params.r || 8) / (1024 * 1024));
    return 'N=' + (params.n || 0) + ' (~' + mib + ' MiB per guess)';
}

// Re-encrypts the whole vault under a new key at the current cost, with a fresh
// salt. Deriving needs the passphrase itself, which is why this runs at unlock
// or behind an explicit prompt — nothing holds one otherwise.
async function upgrade(passphrase) {
    if (!S.isUnlocked()) return { ok: false, reason: 'The vault is locked.' };
    if (!crypto.verifyKey(passphrase, S.vaultKey)) {
        return { ok: false, reason: 'That is not the current master passphrase. Nothing was changed.' };
    }
    if (!needsUpgrade()) return { ok: true, already: true };

    const previous = S.vaultKey;
    S.vaultKey = crypto.newVaultKey(passphrase);

    if (!S.persist()) {
        // persist() has already told the user why.
        crypto.zeroKey(S.vaultKey);
        S.vaultKey = previous;
        return { ok: false, reason: 'The vault could not be written, so nothing was changed.' };
    }

    // Read the new file straight back and open it before anything old is thrown
    // away. Reading the primary directly matters: readWithBackup would happily
    // fall through to the old-cost .bak and report success on a broken write.
    try {
        const parsed = JSON.parse(fs.readFileSync(paths.sessionsPath(), 'utf8'));
        const check = crypto.openVault(parsed, passphrase);
        crypto.zeroKey(check.vaultKey);
        if (!check.data || !Array.isArray(check.data.sessions)) throw new Error('the re-read vault has no session list');
    } catch (e) {
        // Put the old key back and rewrite with it, so disk and memory agree.
        crypto.zeroKey(S.vaultKey);
        S.vaultKey = previous;
        S.persist();
        return { ok: false, reason: 'The re-encrypted vault could not be read back, so it was restored: ' + (e && e.message ? e.message : String(e)) };
    }

    crypto.zeroKey(previous);
    // The backup still holds the whole vault at the old, weaker cost. Leaving it
    // would keep exactly the artefact this upgrade exists to remove; the next
    // save writes a fresh one.
    try { fs.unlinkSync(paths.sessionsPath() + '.bak'); } catch (e) {}
    return { ok: true };
}

// Called once at unlock, where the passphrase is briefly in hand.
async function offerAtUnlock(passphrase) {
    if (!needsUpgrade()) return;
    if (config.data.kdfUpgradeDeclined) return;

    const dialog = dialogMod();
    const ok = await dialog.confirm(
        'This vault was created by an earlier version and still uses its weaker key-derivation setting.\n\n' +
        'Current:  ' + costLabel(S.vaultKey.params) + '\n' +
        'Available: ' + costLabel(crypto.CURRENT) + '\n\n' +
        'Upgrading re-encrypts your sessions under a stronger setting, which makes guessing your ' +
        'master passphrase about eight times more expensive for anyone who copies the file. Your ' +
        'passphrase does not change.\n\n' +
        'It takes a moment, and the file will no longer open in versions older than this one.',
        { okLabel: 'Upgrade now', cancelLabel: 'Not now', title: 'Strengthen vault encryption' }
    );

    if (!ok) {
        // Asking again on every launch would train the user to dismiss it. The
        // File menu keeps the option available.
        config.data.kdfUpgradeDeclined = true;
        config.save();
        return;
    }

    const r = await upgrade(passphrase);
    if (r.ok) {
        config.data.kdfUpgradeDeclined = false;
        config.save();
        await dialog.notify('Your vault is now encrypted at the stronger setting.', { kind: 'success', title: 'Upgraded' });
    } else {
        await dialog.notify(r.reason, { kind: 'error', title: 'Upgrade failed' });
    }
}

// File ▸ Upgrade Vault Encryption… for anyone who said "not now".
async function upgradeInteractive() {
    const dialog = dialogMod();
    if (!needsUpgrade()) {
        return dialog.notify('This vault already uses the current encryption settings.', { kind: 'info', title: 'Nothing to do' });
    }
    const r = await require('./modal').askInput({
        title: 'Strengthen vault encryption',
        message: 'Re-encrypts your sessions at a stronger key-derivation cost.\n\n' +
            'Current:  ' + costLabel(S.vaultKey.params) + '\n' +
            'Available: ' + costLabel(crypto.CURRENT) + '\n\n' +
            'Your master passphrase does not change — it is needed to derive the new key.',
        okLabel: 'Upgrade',
        fields: [{ key: 'p', label: 'Master passphrase', type: 'password' }]
    });
    if (!r) return;

    const out = await upgrade(r.p);
    if (out.ok) {
        config.data.kdfUpgradeDeclined = false;
        config.save();
        await dialog.notify('Your vault is now encrypted at the stronger setting.', { kind: 'success', title: 'Upgraded' });
    } else {
        await dialog.notify(out.reason, { kind: 'error', title: 'Upgrade failed' });
    }
}

module.exports = { needsUpgrade, upgrade, offerAtUnlock, upgradeInteractive, costLabel };
