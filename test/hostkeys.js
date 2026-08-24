const __ROOT__ = require('path').join(__dirname, '..');
const Module = require('module');
const fs = require('fs'), path = require('path'), os = require('os');
const crypto = require('crypto');

const dir = path.join(os.tmpdir(), 'sshell-hk-' + Date.now());
fs.mkdirSync(dir, { recursive: true });

let answer = true;           // what the confirm dialog returns
let prompts = [];            // messages shown

const R = (__ROOT__ + '/src/');
const orig = Module._load;
Module._load = function (req, parent) {
  if (parent && parent.filename && parent.filename.includes('hostkeys')) {
    if (req === './paths') return { getDataDir: () => dir };
    if (req === './dialog') return {
      confirm: async (m, o) => { prompts.push({ m, o }); return answer; }
    };
    if (req === './errors') return { record() {} };
  }
  return orig.apply(this, arguments);
};
const HK = require(R + 'hostkeys');

// Build a realistic host key blob: length-prefixed algorithm name + payload.
function blob(alg, payload) {
  const n = Buffer.from(alg, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(n.length, 0);
  return Buffer.concat([len, n, Buffer.from(payload || 'key-material')]);
}
const ed = blob('ssh-ed25519', 'AAAA');
const ed2 = blob('ssh-ed25519', 'BBBB');
const rsa = blob('ssh-rsa', 'CCCC');

let pass = 0, fail = 0;
const t = (n, c) => {
  try {
    const r = c();
    if (r === true) { pass++; console.log('  ok   ' + n); }
    else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
  } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};
const ta = async (n, c) => {
  try {
    const r = await c();
    if (r === true) { pass++; console.log('  ok   ' + n); }
    else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
  } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};
const verify = (h, p, k) => new Promise(res => HK.verify(h, p, k, res));
const reset = () => { prompts = []; try { fs.unlinkSync(path.join(dir, 'known_hosts.json')); } catch (e) {} HK.forget('h', 22); };

t('fingerprint matches the OpenSSH SHA256 format', () => {
  const fp = HK.fingerprint(ed);
  const want = 'SHA256:' + crypto.createHash('sha256').update(ed).digest('base64').replace(/=+$/, '');
  return fp === want && /^SHA256:[A-Za-z0-9+/]+$/.test(fp);
});
t('fingerprint has no base64 padding', () => HK.fingerprint(ed).indexOf('=') === -1);
t('different keys give different fingerprints', () => HK.fingerprint(ed) !== HK.fingerprint(ed2));
t('algorithm is parsed from the key blob', () => HK.algorithmOf(ed) === 'ssh-ed25519' && HK.algorithmOf(rsa) === 'ssh-rsa');
t('a malformed blob does not throw', () => HK.algorithmOf(Buffer.from([1, 2])) === 'unknown' && HK.algorithmOf(null) === 'unknown');
t('a blob with an absurd length prefix is rejected', () => {
  const b = Buffer.alloc(40); b.writeUInt32BE(999999, 0);
  return HK.algorithmOf(b) === 'unknown';
});
t('a blob with binary garbage in the name is rejected', () => {
  const name = Buffer.from([0x01, 0x02, 0x03]);
  const len = Buffer.alloc(4); len.writeUInt32BE(3, 0);
  return HK.algorithmOf(Buffer.concat([len, name])) === 'unknown';
});

(async () => {
  reset();
  await ta('an unknown host prompts before connecting', async () => {
    answer = true;
    const ok = await verify('h', 22, ed);
    return ok === true && prompts.length === 1 && /First connection/.test(prompts[0].m);
  });
  await ta('the prompt shows the fingerprint the user must check', () =>
    prompts[0].m.includes(HK.fingerprint(ed)));
  await ta('accepting records the key', () => HK.isKnown('h', 22) === true);

  await ta('a known host reconnects with no prompt', async () => {
    prompts = [];
    const ok = await verify('h', 22, ed);
    return ok === true && prompts.length === 0;
  });

  // Escape, the backdrop and Cancel all resolve false, so false MUST mean
  // refuse. The opposite wiring silently pinned an attacker's key.
  await ta('a CHANGED key is refused when the prompt is dismissed', async () => {
    prompts = []; answer = false;
    const ok = await verify('h', 22, ed2);
    return ok === false && /CHANGED/.test(prompts[0].m) && prompts[0].o.danger === true;
  });
  await ta('trusting a changed key is the explicit button, not the dismissal', () =>
    /trust/i.test(prompts[0].o.okLabel) && /refuse/i.test(prompts[0].o.cancelLabel));
  await ta('the mismatch warning shows both fingerprints', () =>
    prompts[0].m.includes(HK.fingerprint(ed)) && prompts[0].m.includes(HK.fingerprint(ed2)));
  await ta('refusing a changed key leaves the original trusted', () =>
    HK.get('h', 22).fingerprint === HK.fingerprint(ed));

  await ta('explicitly trusting a changed key replaces it', async () => {
    prompts = []; answer = true;   // ok button is "Trust the new key"
    const ok = await verify('h', 22, ed2);
    return ok === true && HK.get('h', 22).fingerprint === HK.fingerprint(ed2);
  });

  reset();
  await ta('declining an unknown host refuses the connection', async () => {
    prompts = []; answer = false;
    const ok = await verify('h', 22, ed);
    return ok === false && HK.isKnown('h', 22) === false;
  });

  await ta('host entries are keyed by port', async () => {
    reset(); answer = true;
    await verify('h', 22, ed);
    return HK.isKnown('h', 22) === true && HK.isKnown('h', 2222) === false;
  });
  await ta('hostnames are matched case-insensitively', async () => {
    reset(); answer = true;
    await verify('Example.COM', 22, ed);
    return HK.isKnown('example.com', 22) === true;
  });
  await ta('a second host on the same name+port does not collide', async () => {
    reset(); answer = true;
    await verify('a', 22, ed); await verify('b', 22, rsa);
    return HK.get('a', 22).fingerprint !== HK.get('b', 22).fingerprint;
  });

  await ta('the store survives a reload from disk', async () => {
    reset(); answer = true;
    await verify('persisted', 2200, ed);
    delete require.cache[require.resolve(R + 'hostkeys')];
    const HK2 = require(R + 'hostkeys');
    return HK2.isKnown('persisted', 2200) === true;
  });
  await ta('known_hosts.json is written 0600 where the OS supports it', () => {
    const f = path.join(dir, 'known_hosts.json');
    if (process.platform === 'win32') return true;   // POSIX modes not meaningful
    return (fs.statSync(f).mode & 0o077) === 0;
  });
  await ta('a corrupt known_hosts file does not break connecting', async () => {
    fs.writeFileSync(path.join(dir, 'known_hosts.json'), '{ not json');
    delete require.cache[require.resolve(R + 'hostkeys')];
    const HK3 = require(R + 'hostkeys');
    answer = true;
    const ok = await new Promise(res => HK3.verify('fresh', 22, ed, res));
    return ok === true;
  });
  await ta('forget removes a trusted host', async () => {
    reset(); answer = true;
    await verify('h', 22, ed);
    HK.forget('h', 22);
    return HK.isKnown('h', 22) === false;
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
