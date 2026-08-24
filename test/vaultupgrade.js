// Covers src/vaultupgrade.js -- re-encrypting a legacy vault at the current
// scrypt cost. Everything runs against a real file in a temp dir with the real
// crypto module; only the DOM-facing bits are stubbed.
//
// paths is stubbed deliberately: the real one resolves to the project folder,
// where the developer's own sessions.json lives.
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const nodeCrypto = require('crypto');
const crypto = require(path.join(ROOT, 'src/crypto'));
const safefile = require(path.join(ROOT, 'src/safefile'));

const src = fs.readFileSync(path.join(ROOT, 'src/vaultupgrade.js'), 'utf8');
const body = src.split('\n')
    .filter(l => !/^const .* = require\(/.test(l) && !/^module\.exports/.test(l))
    .join('\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshell-upg-'));
const VAULT = path.join(dir, 'sessions.json');

let notices = [], confirms = [], answerConfirm = true, inputAnswer = null;
const dialog = {
    confirm: async (m, o) => { confirms.push({ m, o }); return answerConfirm; },
    notify: async (m, o) => { notices.push({ m, o }); return true; }
};
const modal = { askInput: async () => inputAnswer };
const paths = { sessionsPath: () => VAULT };
const config = { data: {}, save: () => true };

let persistOk = true;
const S = {
    store: null,
    vaultKey: null,
    isUnlocked() { return !!(S.vaultKey && S.vaultKey.key); },
    persist() {
        if (!persistOk) return false;
        if (!S.isUnlocked()) return false;
        safefile.writeAtomic(VAULT, JSON.stringify(crypto.encryptWithKey(S.store, S.vaultKey), null, 2));
        return true;
    }
};

const req = m => (m === './dialog' ? dialog : m === './modal' ? modal : m === './errors' ? { record() {} } : {});
const V = new Function('fs', 'crypto', 'S', 'paths', 'config', 'require',
    body + ';return { needsUpgrade, upgrade, offerAtUnlock, upgradeInteractive, costLabel };')(
    fs, crypto, S, paths, config, req);

let pass = 0, fail = 0;
const t = async (n, c) => {
    try {
        const r = await c();
        if (r === true) { pass++; console.log('  ok   ' + n); }
        else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
    } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

const STORE = () => ({
    folders: [{ id: 'f1', name: 'Prod', parentId: null }],
    sessions: [{ id: 's1', folderId: 'f1', label: 'web', host: '10.0.0.1', port: 22, username: 'root', password: 'p@ss "q" \\ ünï 🔐' }]
});

// Build a genuine old-format vault: legacy cost, no n/r/p recorded.
const legacyDerive = (p, s) => nodeCrypto.scryptSync(p, s, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
function writeLegacyVault(passphrase, store) {
    const salt = nodeCrypto.randomBytes(16), iv = nodeCrypto.randomBytes(12);
    const key = legacyDerive(passphrase, salt);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(store), 'utf8')), c.final()]);
    const env = {
        v: 1, kdf: 'scrypt', app: 'sshell', salt: salt.toString('base64'),
        iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64')
    };
    fs.writeFileSync(VAULT, JSON.stringify(env, null, 2));
    return env;
}

// Unlock it the way the app does.
function openLegacy(passphrase) {
    const env = JSON.parse(fs.readFileSync(VAULT, 'utf8'));
    const o = crypto.openVault(env, passphrase);
    S.vaultKey = o.vaultKey;
    S.store = o.data;
    return o;
}

const setup = (passphrase, store) => {
    try { fs.unlinkSync(VAULT); } catch (e) {}
    try { fs.unlinkSync(VAULT + '.bak'); } catch (e) {}
    notices = []; confirms = []; answerConfirm = true; inputAnswer = null;
    persistOk = true; config.data = {};
    writeLegacyVault(passphrase, store || STORE());
    openLegacy(passphrase);
};

const readVault = () => JSON.parse(fs.readFileSync(VAULT, 'utf8'));

(async () => {

    await t('a legacy vault is flagged for upgrade', () => {
        setup('master-pass-1');
        return V.needsUpgrade() === true && S.vaultKey.params.n === 16384;
    });

    await t('a current-cost vault is not flagged', () => {
        setup('master-pass-1');
        S.vaultKey = crypto.newVaultKey('master-pass-1');
        return V.needsUpgrade() === false;
    });

    await t('a locked vault is not flagged', () => {
        setup('master-pass-1');
        crypto.zeroKey(S.vaultKey);
        return V.needsUpgrade() === false;
    });

    await t('upgrading raises the recorded cost on disk', async () => {
        setup('master-pass-1');
        const r = await V.upgrade('master-pass-1');
        return r.ok === true && readVault().n === (1 << 17);
    });

    await t('upgrading re-salts, so the old ciphertext cannot be re-derived', async () => {
        setup('master-pass-1');
        const before = readVault().salt;
        await V.upgrade('master-pass-1');
        return readVault().salt !== before;
    });

    await t('the passphrase still opens the upgraded vault', async () => {
        setup('master-pass-1');
        await V.upgrade('master-pass-1');
        const o = crypto.openVault(readVault(), 'master-pass-1');
        crypto.zeroKey(o.vaultKey);
        return JSON.stringify(o.data) === JSON.stringify(STORE());
    });

    await t('every session survives the re-encryption byte for byte', async () => {
        const big = { folders: [], sessions: [] };
        for (let i = 0; i < 25; i++) big.sessions.push({ id: 's' + i, label: 'srv' + i, host: '10.0.0.' + i, username: 'u' + i, password: 'pw-' + i + '-🔐"\\', port: 22 + i });
        setup('master-pass-1', big);
        await V.upgrade('master-pass-1');
        const o = crypto.openVault(readVault(), 'master-pass-1');
        crypto.zeroKey(o.vaultKey);
        return JSON.stringify(o.data) === JSON.stringify(big);
    });

    await t('the in-memory key is swapped to the new cost', async () => {
        setup('master-pass-1');
        await V.upgrade('master-pass-1');
        return S.vaultKey.params.n === (1 << 17) && V.needsUpgrade() === false;
    });

    await t('the superseded key is wiped, not just dropped', async () => {
        setup('master-pass-1');
        const oldKey = S.vaultKey.key;
        const hadContent = oldKey.some(b => b !== 0);
        await V.upgrade('master-pass-1');
        return hadContent && oldKey.every(b => b === 0);
    });

    // The .bak still holds the whole vault at the weaker cost.
    await t('the old-cost backup is removed', async () => {
        setup('master-pass-1');
        S.persist();                                   // creates a .bak at legacy cost
        if (!fs.existsSync(VAULT + '.bak')) return 'precondition: no .bak was created';
        await V.upgrade('master-pass-1');
        return !fs.existsSync(VAULT + '.bak');
    });

    await t('a wrong passphrase changes nothing', async () => {
        setup('master-pass-1');
        const before = fs.readFileSync(VAULT, 'utf8');
        const r = await V.upgrade('not-the-passphrase');
        return r.ok === false && /not the current master passphrase/i.test(r.reason)
            && fs.readFileSync(VAULT, 'utf8') === before && S.vaultKey.params.n === 16384;
    });

    await t('a locked vault is refused', async () => {
        setup('master-pass-1');
        crypto.zeroKey(S.vaultKey);
        const r = await V.upgrade('master-pass-1');
        return r.ok === false && /locked/i.test(r.reason);
    });

    await t('an already-current vault reports nothing to do', async () => {
        setup('master-pass-1');
        S.vaultKey = crypto.newVaultKey('master-pass-1');
        const r = await V.upgrade('master-pass-1');
        return r.ok === true && r.already === true;
    });

    // If the disk write fails the app must keep the key that matches the file
    // that is actually there, or the next save is unreadable.
    await t('a failed write rolls the key back', async () => {
        setup('master-pass-1');
        const original = S.vaultKey;
        persistOk = false;
        const r = await V.upgrade('master-pass-1');
        return r.ok === false && S.vaultKey === original && S.vaultKey.key !== null
            && S.vaultKey.params.n === 16384 && readVault().n === undefined;
    });

    await t('the vault still opens after a failed upgrade', async () => {
        setup('master-pass-1');
        persistOk = false;
        await V.upgrade('master-pass-1');
        const o = crypto.openVault(readVault(), 'master-pass-1');
        crypto.zeroKey(o.vaultKey);
        return JSON.stringify(o.data) === JSON.stringify(STORE());
    });

    // --- the unlock-time offer ---

    await t('unlock offers the upgrade on a legacy vault', async () => {
        setup('master-pass-1');
        await V.offerAtUnlock('master-pass-1');
        return confirms.length === 1 && /weaker key-derivation/i.test(confirms[0].m)
            && /N=16384/.test(confirms[0].m) && readVault().n === (1 << 17);
    });

    await t('unlock does not offer on a current vault', async () => {
        setup('master-pass-1');
        S.vaultKey = crypto.newVaultKey('master-pass-1');
        await V.offerAtUnlock('master-pass-1');
        return confirms.length === 0;
    });

    await t('declining leaves the vault untouched', async () => {
        setup('master-pass-1');
        answerConfirm = false;
        const before = fs.readFileSync(VAULT, 'utf8');
        await V.offerAtUnlock('master-pass-1');
        return fs.readFileSync(VAULT, 'utf8') === before && S.vaultKey.params.n === 16384;
    });

    await t('declining is remembered, so it does not nag', async () => {
        setup('master-pass-1');
        answerConfirm = false;
        await V.offerAtUnlock('master-pass-1');
        if (config.data.kdfUpgradeDeclined !== true) return 'flag not recorded';
        confirms = [];
        await V.offerAtUnlock('master-pass-1');
        return confirms.length === 0;
    });

    await t('accepting clears the declined flag', async () => {
        setup('master-pass-1');
        config.data.kdfUpgradeDeclined = false;
        await V.offerAtUnlock('master-pass-1');
        return config.data.kdfUpgradeDeclined === false && notices.some(n => n.o && n.o.kind === 'success');
    });

    await t('a failed upgrade at unlock is reported, not swallowed', async () => {
        setup('master-pass-1');
        persistOk = false;
        await V.offerAtUnlock('master-pass-1');
        return notices.some(n => n.o && n.o.kind === 'error');
    });

    // --- the manual menu path ---

    await t('the manual path upgrades with the right passphrase', async () => {
        setup('master-pass-1');
        inputAnswer = { p: 'master-pass-1' };
        await V.upgradeInteractive();
        return readVault().n === (1 << 17) && notices.some(n => n.o && n.o.kind === 'success');
    });

    await t('the manual path rejects a wrong passphrase', async () => {
        setup('master-pass-1');
        inputAnswer = { p: 'wrong' };
        await V.upgradeInteractive();
        return readVault().n === undefined && notices.some(n => n.o && n.o.kind === 'error');
    });

    await t('cancelling the manual prompt does nothing', async () => {
        setup('master-pass-1');
        inputAnswer = null;
        await V.upgradeInteractive();
        return notices.length === 0 && readVault().n === undefined;
    });

    await t('the manual path says so when there is nothing to do', async () => {
        setup('master-pass-1');
        S.vaultKey = crypto.newVaultKey('master-pass-1');
        await V.upgradeInteractive();
        return notices.length === 1 && /already/i.test(notices[0].m);
    });

    await t('the cost label is human readable', () =>
        /N=16384/.test(V.costLabel({ n: 16384, r: 8 })) && /128 MiB/.test(V.costLabel(crypto.CURRENT)));

    for (let i = 0; i < 5; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); break; }
        catch (e) { if (i === 4) console.log('  note: temp dir not removed (' + e.code + ')'); }
    }

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})();
