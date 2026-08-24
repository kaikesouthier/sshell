
const crypto = require('crypto');

// Vaults written before parameters were recorded used these. Anything without
// explicit n/r/p in its envelope must still be read with them.
const LEGACY = { n: 16384, r: 8, p: 1 };
// Current cost for newly created vaults: ~128 MiB, a few hundred ms once at
// unlock. Saves reuse the held key, so this is not paid per write.
const CURRENT = { n: 1 << 17, r: 8, p: 1 };

// A passphrase short enough to brute-force offline makes the KDF irrelevant —
// sessions.json is readable to anyone with the file, plus its .bak copies.
const MIN_PASSPHRASE = 8;
// Comfortably above CURRENT (128 * 2^17 * 8 = 128 MiB), far below a hang.
const MAX_KDF_BYTES = 512 * 1024 * 1024;
function passphraseProblem(p) {
    if (typeof p !== 'string' || p.length < MIN_PASSPHRASE) {
        return 'Use at least ' + MIN_PASSPHRASE + ' characters.\n\n' +
            'This passphrase is the only thing protecting your saved passwords and keys. ' +
            'Anyone who copies sessions.json can attack it offline at full speed, so a short ' +
            'one is broken in seconds regardless of how the file is encrypted.';
    }
    return null;
}

// Envelope-supplied parameters are attacker-controlled if someone can write the
// file, and scrypt allocates roughly 128 * N * r bytes — an absurd N would abort
// the process before anything got a chance to reject it.
function readParams(env) {
    const n = Number(env && env.n), r = Number(env && env.r), p = Number(env && env.p);
    if (!isFinite(n) || !isFinite(r) || !isFinite(p)) return LEGACY;
    if (n < 1024 || n > (1 << 20) || (n & (n - 1)) !== 0) throw malformed('Unsupported key-derivation cost in vault header.');
    if (r < 1 || r > 16 || p < 1 || p > 4) throw malformed('Unsupported key-derivation parameters in vault header.');
    // n and r are bounded individually, but scrypt allocates 128 * n * r — the
    // permitted extremes multiply out to 2 GiB, which an imported file could
    // use to freeze the renderer on a synchronous derive.
    if (128 * n * r > MAX_KDF_BYTES) throw malformed('Unsupported key-derivation cost in vault header.');
    return { n, r, p };
}

function deriveKey(passphrase, salt, params) {
    const q = params || LEGACY;
    return crypto.scryptSync(passphrase, salt, 32, {
        N: q.n, r: q.r, p: q.p,
        // Must exceed 128 * N * r or scrypt refuses outright.
        maxmem: 256 * q.n * q.r + 32 * 1024 * 1024
    });
}

// Overwrite key material instead of waiting for the collector. A Buffer can be
// wiped in place; the JS string a passphrase arrives as cannot, which is the
// whole reason nothing here holds on to one.
function wipe(buf) {
    if (Buffer.isBuffer(buf)) { try { buf.fill(0); } catch (e) {} }
}

// A file problem, as opposed to a passphrase problem. The unlock screen uses
// this to offer the backup instead of insisting the user typed it wrong.
function malformed(msg) {
    const e = new Error(msg);
    e.vaultCode = 'MALFORMED';
    return e;
}

// --- held vault key -------------------------------------------------------
// Unlocking derives the key once and keeps only this: the bytes, plus the salt
// and cost that produced them so saves can re-encrypt without the passphrase.

function makeVaultKey(key, salt, params) {
    return { key, salt, params: params || LEGACY };
}

function newVaultKey(passphrase) {
    const salt = crypto.randomBytes(16);
    return makeVaultKey(deriveKey(passphrase, salt, CURRENT), salt, CURRENT);
}

function zeroKey(vk) {
    if (!vk) return;
    wipe(vk.key);
    vk.key = null;
}

// Confirms a passphrase against the key already in memory. Deriving and
// comparing beats keeping the passphrase around to string-compare, and the KDF
// cost rate-limits guessing for free.
function verifyKey(passphrase, vk) {
    if (!vk || !vk.key) return false;
    let candidate = null;
    try {
        candidate = deriveKey(String(passphrase == null ? '' : passphrase), vk.salt, vk.params);
        return candidate.length === vk.key.length && crypto.timingSafeEqual(candidate, vk.key);
    } catch (e) {
        return false;
    } finally {
        wipe(candidate);
    }
}

function encryptWithKey(obj, vk) {
    if (!vk || !vk.key) throw new Error('The vault is locked.');
    const q = vk.params || LEGACY;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', vk.key, iv);
    const plain = Buffer.from(JSON.stringify(obj), 'utf8');
    let enc;
    try {
        enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    } finally {
        wipe(plain);
    }
    return {
        v: 1, kdf: 'scrypt', app: 'sshell',
        n: q.n, r: q.r, p: q.p,
        // Reusing the vault's own salt and cost keeps an existing file readable
        // by the version that wrote it; only the IV must be fresh per save.
        salt: vk.salt.toString('base64'), iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), data: enc.toString('base64')
    };
}

function decryptWithKey(env, key) {
    const iv = Buffer.from(env.iv, 'base64');
    const tag = Buffer.from(env.tag, 'base64');
    // GCM accepts several tag lengths, and a short one is much cheaper to
    // forge; this app only ever writes 12/16.
    if (iv.length !== 12) throw malformed('Malformed vault: bad IV length.');
    if (tag.length !== 16) throw malformed('Malformed vault: bad authentication tag.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let dec;
    try {
        // final() throws if the tag does not verify, so nothing below runs — and
        // a wrong passphrase never yields a key anyone keeps.
        dec = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]);
    } catch (e) {
        // Authentication failed. Overwhelmingly a wrong passphrase, but a
        // damaged file lands here too; the caller cannot tell them apart and
        // must not claim certainty.
        e.vaultCode = 'BAD_PASSPHRASE';
        throw e;
    }
    try {
        return JSON.parse(dec.toString('utf8'));
    } catch (e) {
        // The tag verified, so the passphrase was right and the plaintext is
        // genuinely corrupt.
        e.vaultCode = 'MALFORMED';
        throw e;
    } finally {
        wipe(dec);
    }
}

// Unlock: hand back both the contents and the key to hold for later saves.
function openVault(env, passphrase) {
    const salt = Buffer.from(env.salt, 'base64');
    const params = readParams(env);
    const key = deriveKey(passphrase, salt, params);
    try {
        const data = decryptWithKey(env, key);
        return { data, vaultKey: makeVaultKey(key, salt, params) };
    } catch (e) {
        wipe(key);
        throw e;
    }
}

// --- one-shot, for import and export --------------------------------------
// These take a passphrase the user typed for that one file. The key is derived,
// used, and wiped; nothing is retained.

function encryptData(obj, passphrase) {
    const vk = newVaultKey(passphrase);
    try { return encryptWithKey(obj, vk); }
    finally { zeroKey(vk); }
}

function decryptData(env, passphrase) {
    const key = deriveKey(passphrase, Buffer.from(env.salt, 'base64'), readParams(env));
    try { return decryptWithKey(env, key); }
    finally { wipe(key); }
}

function isEnvelope(o) {
    return o && typeof o === 'object' && !Array.isArray(o) && o.data && o.tag && o.salt && o.iv;
}

module.exports = {
    encryptData, decryptData, isEnvelope, passphraseProblem,
    newVaultKey, openVault, encryptWithKey, verifyKey, zeroKey, wipe,
    LEGACY, CURRENT, MIN_PASSPHRASE
};
