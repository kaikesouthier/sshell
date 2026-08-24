const __ROOT__ = require('path').join(__dirname, '..');
// Core vault crypto: round-trips, tamper rejection, and the handling of key
// material now that nothing retains the passphrase.
const path = (__ROOT__ + '/src/crypto');
const c = require(path);
// A second instance stands in for "a different build / next launch".
const fresh = () => { delete require.cache[require.resolve(path)]; const m = require(path); delete require.cache[require.resolve(path)]; return m; };

let pass = 0, fail = 0;
const t = (n, f) => { try { if (f() === true) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); } };
const store = { folders: [{ id: 'f', name: 'Prod' }], sessions: [{ id: 's', host: 'h', password: 'p@ss "q" \\ ünï 🔐' }] };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- one-shot path (import / export) --------------------------------------

t('round-trips within one instance', () => eq(c.decryptData(c.encryptData(store, 'pw'), 'pw'), store));
t('a vault written now decrypts in a fresh instance (forward compatible)', () =>
    eq(fresh().decryptData(c.encryptData(store, 'pw'), 'pw'), store));
t('a vault written by another build decrypts here (backward compatible)', () =>
    eq(c.decryptData(fresh().encryptData(store, 'pw'), 'pw'), store));
t('envelope shape is unchanged', () => {
    const e = c.encryptData(store, 'pw');
    return e.v === 1 && e.kdf === 'scrypt' && e.app === 'sshell' &&
        Buffer.from(e.salt, 'base64').length === 16 && Buffer.from(e.iv, 'base64').length === 12 && Buffer.from(e.tag, 'base64').length === 16;
});
t('wrong passphrase throws', () => { try { c.decryptData(c.encryptData(store, 'pw'), 'nope'); return false; } catch (e) { return true; } });
t('wrong passphrase still throws after a successful unlock', () => {
    const e = c.encryptData(store, 'pw'); c.decryptData(e, 'pw');
    try { c.decryptData(e, 'nope'); return false; } catch (err) { return true; }
});
t('a failed attempt leaves the vault openable', () => {
    const e = c.encryptData(store, 'pw');
    try { c.decryptData(e, 'bad'); } catch (x) {}
    return eq(c.decryptData(e, 'pw'), store);
});
t('every export gets its own salt', () => {
    const a = c.encryptData(store, 'pw'), b = c.encryptData(store, 'pw');
    return a.salt !== b.salt;
});
t('tampering with the ciphertext is rejected', () => {
    const e = c.encryptData(store, 'pw');
    const b = Buffer.from(e.data, 'base64'); b[10] ^= 0xff; e.data = b.toString('base64');
    try { c.decryptData(e, 'pw'); return false; } catch (x) { return true; }
});
t('tampering with the auth tag is rejected', () => {
    const e = c.encryptData(store, 'pw');
    const b = Buffer.from(e.tag, 'base64'); b[0] ^= 0xff; e.tag = b.toString('base64');
    try { c.decryptData(e, 'pw'); return false; } catch (x) { return true; }
});
t('many passphrases each decrypt correctly', () => {
    const envs = []; for (let i = 0; i < 6; i++) envs.push([c.encryptData(store, 'k' + i), 'k' + i]);
    return envs.every(([e, k]) => eq(c.decryptData(e, k), store));
});

// --- held key (the unlocked vault) ----------------------------------------

t('unlocking returns both the contents and a key to hold', () => {
    const env = c.encryptData(store, 'pw-hold');
    const o = c.openVault(env, 'pw-hold');
    return eq(o.data, store) && Buffer.isBuffer(o.vaultKey.key) && o.vaultKey.key.length === 32;
});
t('a held key saves without the passphrase', () => {
    const o = c.openVault(c.encryptData(store, 'pw-save'), 'pw-save');
    const again = c.encryptWithKey({ folders: [], sessions: [{ id: 'x' }] }, o.vaultKey);
    return eq(c.decryptData(again, 'pw-save').sessions[0].id, 'x');
});
t('saves with a held key reuse the salt but never the IV', () => {
    const o = c.openVault(c.encryptData(store, 'pw-iv'), 'pw-iv');
    const ivs = new Set(); let salt = null;
    for (let i = 0; i < 40; i++) { const e = c.encryptWithKey(store, o.vaultKey); ivs.add(e.iv); salt = salt === null ? e.salt : (salt === e.salt ? salt : 'DIFFERED'); }
    return ivs.size === 40 && salt !== 'DIFFERED';
});
t('a new vault key uses the raised cost and a fresh salt', () => {
    const a = c.newVaultKey('pw-new'), b = c.newVaultKey('pw-new');
    return a.params.n === (1 << 17) && !a.salt.equals(b.salt);
});
t('unlocking with the wrong passphrase throws and yields no key', () => {
    const env = c.encryptData(store, 'right');
    try { c.openVault(env, 'wrong'); return false; } catch (e) { return true; }
});

// --- verification without the passphrase ----------------------------------

t('verifyKey accepts the real passphrase', () => {
    const vk = c.newVaultKey('correct-horse');
    return c.verifyKey('correct-horse', vk) === true;
});
t('verifyKey rejects a wrong passphrase', () => {
    const vk = c.newVaultKey('correct-horse');
    return c.verifyKey('correct-hors', vk) === false && c.verifyKey('correct-horsee', vk) === false;
});
t('verifyKey handles null and non-strings without throwing', () => {
    const vk = c.newVaultKey('correct-horse');
    return c.verifyKey(null, vk) === false && c.verifyKey(undefined, vk) === false && c.verifyKey(12345, vk) === false;
});
t('verifyKey against a locked vault is false, not a crash', () => {
    const vk = c.newVaultKey('correct-horse');
    c.zeroKey(vk);
    return c.verifyKey('correct-horse', vk) === false && c.verifyKey('x', null) === false;
});
t('verifyKey works on a key that came from unlocking, not creating', () => {
    const o = c.openVault(c.encryptData(store, 'opened-pw'), 'opened-pw');
    return c.verifyKey('opened-pw', o.vaultKey) === true && c.verifyKey('other', o.vaultKey) === false;
});
t('a re-saved vault still opens with the same passphrase', () => {
    const o = c.openVault(c.encryptData(store, 'resave-pw'), 'resave-pw');
    const re = c.openVault(c.encryptWithKey(store, o.vaultKey), 'resave-pw');
    return eq(re.data, store) && re.vaultKey.params.n === o.vaultKey.params.n;
});

// --- wiping ---------------------------------------------------------------

t('zeroKey overwrites the bytes, not just the reference', () => {
    const vk = c.newVaultKey('to-be-wiped');
    const buf = vk.key;
    const hadContent = buf.some(b => b !== 0);
    c.zeroKey(vk);
    return hadContent && buf.every(b => b === 0) && vk.key === null;
});
t('zeroKey is safe to call twice, and on nothing', () => {
    const vk = c.newVaultKey('to-be-wiped');
    c.zeroKey(vk); c.zeroKey(vk); c.zeroKey(null); c.zeroKey(undefined);
    return true;
});
t('a wiped key cannot encrypt', () => {
    const vk = c.newVaultKey('to-be-wiped');
    c.zeroKey(vk);
    try { c.encryptWithKey(store, vk); return false; } catch (e) { return /locked/i.test(e.message); }
});
t('encryptWithKey refuses a missing key outright', () => {
    try { c.encryptWithKey(store, null); return false; } catch (e) { return true; }
});
t('wipe tolerates non-buffers', () => { c.wipe(null); c.wipe('str'); c.wipe(undefined); return true; });

// The point of the whole exercise: no API hands back, stores, or requires the
// passphrase once the vault is open.
t('nothing in the module surface retains a passphrase', () => {
    const vk = c.newVaultKey('super-secret-passphrase');
    const seen = JSON.stringify({ salt: vk.salt.toString('hex'), params: vk.params, key: vk.key.toString('hex') });
    return !seen.includes('super-secret-passphrase') && !('masterPass' in c) && typeof c.forget !== 'function';
});

const bench = c.newVaultKey('bench');
let t0 = process.hrtime.bigint(); c.newVaultKey('bench'); const cold = Number(process.hrtime.bigint() - t0) / 1e6;
t0 = process.hrtime.bigint(); for (let i = 0; i < 20; i++) c.encryptWithKey(store, bench);
const warm = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
console.log('\n  unlock (derives key): ' + cold.toFixed(1) + ' ms');
console.log('  save with held key:   ' + warm.toFixed(2) + ' ms   (' + Math.round(cold / warm) + 'x faster)');

console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
