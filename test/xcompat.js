const __ROOT__ = require('path').join(__dirname, '..');
const crypto = require('crypto');
const NEW = require((__ROOT__ + '/src/crypto'));

// Verbatim reimplementation of the shipped pre-upgrade algorithm.
const legacyDerive = (p, s) => crypto.scryptSync(p, s, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const OLD = {
  encryptData(obj, pass) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = legacyDerive(pass, salt);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
    return { v: 1, kdf: 'scrypt', app: 'sshell', salt: salt.toString('base64'),
      iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64') };
  },
  decryptData(env, pass) {
    const key = legacyDerive(pass, Buffer.from(env.salt, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]).toString('utf8'));
  }
};

let pass = 0, fail = 0;
const t = (n, f) => {
  try { if (f() === true) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } }
  catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const store = { folders: [{ id: 'f', name: 'Prod', icon: 'rocket' }],
  sessions: [{ id: 's', host: '10.0.0.1', username: 'root', password: 'p@ss "q" \\ ünï 🔐', port: 2222 }] };

// --- the guarantee that matters: existing vaults keep working, both ways ---
t('an existing legacy vault opens with the new code', () =>
  eq(NEW.decryptData(OLD.encryptData(store, 'pw-legacy-1'), 'pw-legacy-1'), store));

t('unlocking a legacy vault yields a key carrying the legacy cost', () => {
  const o = NEW.openVault(OLD.encryptData(store, 'pw-legacy-k'), 'pw-legacy-k');
  return eq(o.data, store) && o.vaultKey.params.n === 16384 && o.vaultKey.key.length === 32;
});

// The real save path after unlocking: the header must keep describing the key
// that is actually held, or the next launch cannot open the file.
t('a legacy vault keeps its legacy cost when re-saved, so old builds still open it', () => {
  const o = NEW.openVault(OLD.encryptData(store, 'pw-legacy-2'), 'pw-legacy-2');
  const resaved = NEW.encryptWithKey(store, o.vaultKey);
  return resaved.n === 16384 && eq(OLD.decryptData(resaved, 'pw-legacy-2'), store);
});
t('a legacy vault survives many re-saves without silently upgrading', () => {
  const o = NEW.openVault(OLD.encryptData(store, 'pw-legacy-3'), 'pw-legacy-3');
  let e; for (let i = 0; i < 20; i++) e = NEW.encryptWithKey(store, o.vaultKey);
  return e.n === 16384 && eq(OLD.decryptData(e, 'pw-legacy-3'), store);
});
t('a re-saved legacy vault reopens with the new code too', () => {
  const o = NEW.openVault(OLD.encryptData(store, 'pw-legacy-4'), 'pw-legacy-4');
  const again = NEW.openVault(NEW.encryptWithKey(store, o.vaultKey), 'pw-legacy-4');
  return eq(again.data, store) && again.vaultKey.params.n === 16384;
});
t('verifyKey works against a legacy-cost held key', () => {
  const o = NEW.openVault(OLD.encryptData(store, 'pw-legacy-5'), 'pw-legacy-5');
  return NEW.verifyKey('pw-legacy-5', o.vaultKey) === true && NEW.verifyKey('nope', o.vaultKey) === false;
});

// --- new vaults use the stronger cost (intentionally not backward-readable) ---
t('a brand-new vault uses the raised scrypt cost', () =>
  NEW.encryptWithKey(store, NEW.newVaultKey('pw-fresh')).n === (1 << 17));
t('a brand-new vault round-trips with the new code', () =>
  eq(NEW.decryptData(NEW.encryptData(store, 'pw-fresh2'), 'pw-fresh2'), store));
t('changing the passphrase upgrades the cost and re-salts', () => {
  const old = NEW.openVault(OLD.encryptData(store, 'pw-old'), 'pw-old');
  const next = NEW.newVaultKey('pw-new');            // what changePassphrase does
  const e = NEW.encryptWithKey(store, next);
  return e.n === (1 << 17) && e.salt !== old.vaultKey.salt.toString('base64')
    && eq(NEW.decryptData(e, 'pw-new'), store);
});
t('after a passphrase change the old one no longer opens the file', () => {
  const e = NEW.encryptWithKey(store, NEW.newVaultKey('pw-new-only'));
  try { NEW.decryptData(e, 'pw-old-gone'); return false; } catch (x) { return true; }
});

// --- header integrity ---
t('the envelope records the parameters used', () => {
  const e = NEW.encryptData(store, 'pw-hdr');
  return e.n === (1 << 17) && e.r === 8 && e.p === 1 && e.kdf === 'scrypt' && e.v === 1;
});
t('envelope field sizes are unchanged', () => {
  const e = NEW.encryptData(store, 'pw-sz');
  return Buffer.from(e.salt, 'base64').length === 16 &&
         Buffer.from(e.iv, 'base64').length === 12 &&
         Buffer.from(e.tag, 'base64').length === 16;
});
t('a missing n/r/p header is read as the legacy cost', () => {
  const e = OLD.encryptData(store, 'pw-nohdr');
  return e.n === undefined && eq(NEW.decryptData(e, 'pw-nohdr'), store);
});

// --- hostile headers cannot be used to hang or OOM the app ---
t('an absurd scrypt cost in the header is rejected, not attempted', () => {
  const e = NEW.encryptData(store, 'pw-dos');
  e.n = 1 << 28;
  try { NEW.decryptData(e, 'pw-dos'); return false; }
  catch (err) { return /Unsupported key-derivation/.test(err.message); }
});
t('an absurd cost is rejected on the unlock path too', () => {
  const e = NEW.encryptData(store, 'pw-dos2');
  e.n = 1 << 28;
  try { NEW.openVault(e, 'pw-dos2'); return false; }
  catch (err) { return /Unsupported key-derivation/.test(err.message); }
});
t('a non-power-of-two cost is rejected', () => {
  const e = NEW.encryptData(store, 'pw-p2'); e.n = 12345;
  try { NEW.decryptData(e, 'pw-p2'); return false; } catch (err) { return true; }
});
t('out-of-range r/p are rejected', () => {
  const a = NEW.encryptData(store, 'pw-r'); a.r = 9999;
  const b = NEW.encryptData(store, 'pw-r'); b.p = 9999;
  let ra = false, rb = false;
  try { NEW.decryptData(a, 'pw-r'); } catch (e) { ra = true; }
  try { NEW.decryptData(b, 'pw-r'); } catch (e) { rb = true; }
  return ra && rb;
});
t('tampering with the ciphertext is still rejected', () => {
  const e = NEW.encryptData(store, 'pw-tamper');
  const b = Buffer.from(e.data, 'base64'); b[5] ^= 0xff; e.data = b.toString('base64');
  try { NEW.decryptData(e, 'pw-tamper'); return false; } catch (x) { return true; }
});
t('a wrong passphrase is still rejected at the raised cost', () => {
  const e = NEW.encryptData(store, 'pw-right');
  try { NEW.decryptData(e, 'pw-wrong'); return false; } catch (x) { return true; }
});

// --- passphrase policy ---
t('short passphrases are refused', () => !!NEW.passphraseProblem('abc') && !!NEW.passphraseProblem('1234567'));
t('an eight character passphrase is accepted', () => NEW.passphraseProblem('12345678') === null);
t('non-strings are refused', () => !!NEW.passphraseProblem(null) && !!NEW.passphraseProblem(undefined));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
