
const crypto = require('./crypto');
const S = require('./store');
const modal = require('./modal');
const dialog = require('./dialog');

const ATTEMPTS = 3;

// Re-derives the key from what was typed and compares it to the one already
// held. Nothing needs the original passphrase to still be in memory, and the
// KDF cost makes repeated guessing expensive on its own.
function matches(input) {
    return crypto.verifyKey(input, S.vaultKey);
}

// Confirms the person at the keyboard knows the master passphrase before a
// stored secret is shown or leaves the app. An unencrypted vault has no
// passphrase to check, so the gate opens rather than locking the owner out.
async function confirm(opts) {
    opts = opts || {};
    if (!S.isUnlocked()) return true;

    for (let left = ATTEMPTS; left > 0; left--) {
        const r = await modal.askInput({
            title: opts.title || 'Confirm master passphrase',
            message: (opts.message || 'Re-enter your master passphrase to continue.')
                + (left < ATTEMPTS ? `\n\nIncorrect passphrase. ${left} ${left === 1 ? 'try' : 'tries'} left.` : ''),
            okLabel: opts.okLabel || 'Confirm',
            fields: [{ key: 'p', label: 'Master passphrase', type: 'password' }]
        });
        if (!r) return false;
        if (matches(r.p)) return true;
    }
    dialog.notify('Incorrect passphrase.', { kind: 'error' });
    return false;
}

module.exports = { confirm };
