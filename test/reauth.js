// Covers src/reauth.js -- the "confirm master passphrase" gate that guards
// revealing a stored password and exporting the vault.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const nodeCrypto = require('crypto');
const src = fs.readFileSync(path.join(ROOT, 'src/reauth.js'), 'utf8');

// Run the module body against stubs so the suite needs no DOM.
const body = src
    .split('\n')
    .filter(l => !/^const .* = require\(/.test(l) && !/^module\.exports/.test(l))
    .join('\n');

let prompts = [], notices = [];
let answers = [];
const modal = {
    askInput: async opts => { prompts.push(opts); return answers.length ? answers.shift() : null; }
};
const dialog = { notify: (m, o) => notices.push({ m, o }) };

// The real crypto module, so verifyKey is genuinely exercised rather than
// stubbed. Legacy cost keeps the suite fast -- the code path is identical.
const crypto = require(path.join(ROOT, 'src/crypto'));
const LEGACY = { n: 16384, r: 8, p: 1 };
const keyFor = pass => {
    const salt = Buffer.alloc(16, 7);
    return { key: nodeCrypto.scryptSync(pass, salt, 32, { N: LEGACY.n, r: LEGACY.r, p: LEGACY.p, maxmem: 64 * 1024 * 1024 }), salt, params: LEGACY };
};

const S = { vaultKey: null, isUnlocked() { return !!(S.vaultKey && S.vaultKey.key); } };

const build = () => new Function('crypto', 'S', 'modal', 'dialog',
    body + ';return { confirm, matches, ATTEMPTS };')(crypto, S, modal, dialog);
const M = build();

const reset = pass => {
    prompts = []; notices = []; answers = [];
    S.vaultKey = pass == null ? null : keyFor(pass);
};

let pass = 0, fail = 0;
const t = async (n, c) => {
    try {
        const r = await c();
        if (r === true) { pass++; console.log('  ok   ' + n); }
        else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
    } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

(async () => {

    await t('correct passphrase opens the gate', async () => {
        reset('hunter2hunter2');
        answers = [{ p: 'hunter2hunter2' }];
        return await M.confirm({}) === true && prompts.length === 1;
    });

    await t('wrong passphrase is refused', async () => {
        reset('hunter2hunter2');
        answers = [{ p: 'wrong' }, { p: 'wrong' }, { p: 'wrong' }];
        return await M.confirm({}) === false;
    });

    await t('a typo does not end the attempt', async () => {
        reset('hunter2hunter2');
        answers = [{ p: 'hunter2hunter' }, { p: 'hunter2hunter2' }];
        return await M.confirm({}) === true && prompts.length === 2;
    });

    await t('stops after exactly 3 tries', async () => {
        reset('hunter2hunter2');
        answers = [{ p: 'a' }, { p: 'b' }, { p: 'c' }, { p: 'hunter2hunter2' }];
        const r = await M.confirm({});
        return r === false && prompts.length === 3;
    });

    await t('cancelling closes the gate immediately', async () => {
        reset('hunter2hunter2');
        answers = [];               // askInput resolves null == cancelled
        return await M.confirm({}) === false && prompts.length === 1;
    });

    await t('a refusal tells the user why', async () => {
        reset('hunter2hunter2');
        answers = [{ p: 'x' }, { p: 'y' }, { p: 'z' }];
        await M.confirm({});
        return notices.length === 1 && /incorrect/i.test(notices[0].m);
    });

    await t('retry prompt shows the tries left', async () => {
        reset('hunter2hunter2');
        answers = [{ p: 'x' }, { p: 'hunter2hunter2' }];
        await M.confirm({});
        return /2 tries left/.test(prompts[1].message) && !/tries left/.test(prompts[0].message);
    });

    await t('last retry says "try" not "tries"', async () => {
        reset('hunter2hunter2');
        answers = [{ p: 'x' }, { p: 'y' }, { p: 'hunter2hunter2' }];
        await M.confirm({});
        return /1 try left/.test(prompts[2].message);
    });

    // A locked vault holds no key and no decrypted data, so there is nothing to
    // gate. Demanding a passphrase here would prompt against nothing.
    await t('locked vault passes through without prompting', async () => {
        reset(null);
        return await M.confirm({}) === true && prompts.length === 0;
    });

    await t('a wiped key counts as locked', async () => {
        reset('hunter2hunter2');
        crypto.zeroKey(S.vaultKey);
        return await M.confirm({}) === true && prompts.length === 0;
    });

    // Both sides are 32-byte derived keys, so a guess of any length compares
    // safely rather than throwing inside timingSafeEqual.
    await t('a shorter guess does not throw', async () => {
        reset('a-long-master-passphrase');
        answers = [{ p: 'x' }, { p: 'x' }, { p: 'x' }];
        return await M.confirm({}) === false;
    });

    await t('a longer guess does not throw', async () => {
        reset('short');
        answers = [{ p: 'x'.repeat(500) }, { p: 'x' }, { p: 'x' }];
        return await M.confirm({}) === false;
    });

    await t('a missing answer field does not throw', async () => {
        reset('hunter2hunter2');
        answers = [{}, {}, {}];
        return await M.confirm({}) === false;
    });

    await t('unicode passphrases compare correctly', async () => {
        reset('paßwörd–ünicode✓');
        answers = [{ p: 'paßwörd–ünicode✓' }];
        return await M.confirm({}) === true;
    });

    await t('the prompt masks what is typed', async () => {
        reset('hunter2hunter2');
        answers = [{ p: 'hunter2hunter2' }];
        await M.confirm({});
        return prompts[0].fields.length === 1 && prompts[0].fields[0].type === 'password';
    });

    await t('caller can label the reason and the button', async () => {
        reset('hunter2hunter2');
        answers = [{ p: 'hunter2hunter2' }];
        await M.confirm({ message: 'Because reasons.', okLabel: 'Reveal' });
        return prompts[0].message === 'Because reasons.' && prompts[0].okLabel === 'Reveal';
    });

    await t('matches() is exact, not a prefix test', async () => {
        reset('hunter2hunter2');
        return M.matches('hunter2hunter2') === true
            && M.matches('hunter2hunter') === false
            && M.matches('hunter2hunter22') === false;
    });

    // --- the call sites actually use the gate ---

    const menu = fs.readFileSync(path.join(ROOT, 'src/menu.js'), 'utf8');
    const cfg = fs.readFileSync(path.join(ROOT, 'src/configpage.js'), 'utf8');
    const ed = fs.readFileSync(path.join(ROOT, 'src/editor.js'), 'utf8');

    const fnBody = (text, name) => {
        let i = text.indexOf('function ' + name + '(');
        if (i < 0) return '';
        let d = 0;
        for (let k = text.indexOf('{', i); k < text.length; k++) {
            if (text[k] === '{') d++;
            else if (text[k] === '}') { d--; if (!d) return text.slice(i, k + 1); }
        }
        return '';
    };

    await t('encrypted export asks before dumping the vault', () =>
        /reauth\.confirm/.test(fnBody(menu, 'exportEncrypted')));

    await t('plain-text export asks before writing secrets in the clear', () =>
        /reauth\.confirm/.test(fnBody(menu, 'exportPlain')));

    await t('plain export gates before it writes the file', () => {
        const b = fnBody(menu, 'exportPlain');
        return b.indexOf('reauth.confirm') < b.indexOf('downloadFile');
    });

    await t('encrypted export gates before it writes the file', () => {
        const b = fnBody(menu, 'exportEncrypted');
        return b.indexOf('reauth.confirm') < b.indexOf('downloadFile');
    });

    await t('config page reveal still asks', () =>
        /reauth\.confirm/.test(fnBody(cfg, 'reveal')));

    await t('editor reveal asks only for a stored secret', () => {
        const b = fnBody(ed, 'toggleReveal');
        return /reauth/.test(b) && /editingId/.test(b);
    });

    await t('editor re-masks when the dialog closes', () =>
        /maskSecrets\(\)/.test(fnBody(ed, 'closeEditor')));

    await t('editor drops its authorisation when the dialog closes', () =>
        /revealAuthorised = false/.test(fnBody(ed, 'closeEditor')));

    await t('editor drops its authorisation when a session is opened', () => {
        const b = fnBody(ed, 'openEditor');
        return /revealAuthorised = false/.test(b) && /maskSecrets\(\)/.test(b);
    });

    await t('every secret field in the editor has a reveal button', () => {
        const html = fs.readFileSync(path.join(ROOT, 'views/modals.html'), 'utf8');
        return /id="fPasswordEye"/.test(html) && /id="fPassphraseEye"/.test(html);
    });

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
