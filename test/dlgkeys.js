// The keyboard must never be able to accept a destructive dialog by accident.
// The host key prompt is a danger confirm whose OK button reads "Trust the new
// key", and dialogs queue — so a held Enter used to walk from a backlog of
// notices straight into trusting an attacker's key.
const __ROOT__ = require('path').join(__dirname, '..');
const Module = require('module');

const focused = [];
const mk = id => ({
    _id: id, _cls: new Set(), _listeners: {},
    classList: { add() {}, remove() {}, toggle() {} },
    set innerHTML(v) {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; },
    set className(v) { this._c = v; }, get className() { return this._c || ''; },
    focus() { focused.push(id); },
    addEventListener(n, f) { (this._listeners[n] = this._listeners[n] || []).push(f); }
});
const els = {};
global.document = { getElementById: id => els[id] || (els[id] = mk(id)), addEventListener() {} };
const orig = Module._load;
Module._load = function (r) {
    if (r === './util') return { $: id => global.document.getElementById(id), escapeHtml: s => s };
    return orig.apply(this, arguments);
};
const d = require((__ROOT__ + '/src/dialog'));
d.init();

const fire = (id, name, ev) => (els[id]._listeners[name] || []).forEach(f => f(ev || {}));
const key = k => fire('msgModal', 'keydown', { key: k });
const wait = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = (n, c) => {
    if (c === true) { pass++; console.log('  ok   ' + n); }
    else { fail++; console.log('  FAIL ' + n + (typeof c === 'string' ? ' -> ' + c : '')); }
};

(async () => {
    // --- a destructive confirm ---
    let trusted = null;
    const hostKey = d.confirm('The host key changed.', {
        danger: true, okLabel: 'Trust the new key', cancelLabel: 'Refuse (safe)', title: 'Host key changed'
    }).then(v => { trusted = v; });

    focused.length = 0;
    await wait(60);
    t('the safe button takes focus on a danger dialog, not the destructive one',
        focused.includes('msgCancel') && !focused.includes('msgOk'));

    key('Enter');
    await wait(5);
    t('Enter does not trust a changed host key', trusted === null);

    await wait(450);
    key('Enter');
    await wait(5);
    t('Enter still does nothing once the dialog has been up a while', trusted === null);

    key('Escape');
    await wait(5);
    t('Escape refuses, because the safe direction is always available', trusted === false);
    await hostKey;

    // --- an ordinary confirm keeps working ---
    let ok1 = null;
    const plain = d.confirm('Upload 3 files?', { okLabel: 'Upload' }).then(v => { ok1 = v; });
    await wait(450);
    key('Enter');
    await wait(5);
    t('a normal confirm is still accepted with Enter', ok1 === true);
    await plain;

    // --- the keystroke already in flight when a dialog appears ---
    let ok2 = null;
    const racing = d.confirm('Delete 12 files?', { okLabel: 'Delete' }).then(v => { ok2 = v; });
    key('Enter');
    await wait(5);
    t('a dialog cannot be accepted by a keystroke that arrived as it opened', ok2 === null);
    await wait(450);
    key('Enter');
    await wait(5);
    t('the same key works once the guard has passed', ok2 === true);
    await racing;

    // --- a queue must not carry acceptance from one dialog to the next ---
    let first = null, second = null;
    const a = d.notify('A save failed').then(() => { first = true; });
    const b = d.confirm('Delete the folder and everything in it?', { danger: true, okLabel: 'Delete' }).then(v => { second = v; });
    await wait(450);
    key('Enter');            // clears the notify
    await wait(5);
    t('the first notice is dismissed', first === true);
    focused.length = 0;
    await wait(60);
    t('the queued danger dialog focuses its safe button when it takes over',
        focused.includes('msgCancel') && !focused.includes('msgOk'));
    key('Enter');
    await wait(5);
    t('and a second Enter does not accept it', second === null);
    fire('msgCancel', 'click');
    await wait(5);
    t('clicking the safe button refuses it', second === false);
    await a; await b;

    // --- clicking is still how you accept a dangerous thing ---
    let third = null;
    const c = d.confirm('Trust it?', { danger: true, okLabel: 'Trust' }).then(v => { third = v; });
    await wait(60);
    fire('msgOk', 'click');
    await wait(5);
    t('a deliberate click on the destructive button still works', third === true);
    await c;

    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
})();
