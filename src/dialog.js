
const { $ } = require('./util');

let resolver = null;

const ICONS = {
    info: ['accent', 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'],
    error: ['bad', 'M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z'],
    warn: ['warn', 'M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z'],
    success: ['ok', 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'],
    confirm: ['accent', 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z']
};

const queue = [];

// Superseding a live dialog resolved the earlier one as "cancelled", so a background notify — a failed save, an SSH error, a caught exception —…
function open(opts) {
    if (resolver) return new Promise(res => queue.push({ opts, res }));
    return new Promise(res => { present(opts, res); });
}

function present(opts, res) {
    resolver = res;
    show(opts);
}

function drain() {
    const next = queue.shift();
    if (next) present(next.opts, next.res);
}

function show(opts) {
    const [color, pathD] = ICONS[opts.kind] || ICONS.info;
    $('msgIcon').innerHTML = `<svg class="w-6 h-6 text-${color}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="${pathD}"></path></svg>`;
    $('msgTitle').textContent = opts.title || 'Notice';
    $('msgBody').textContent = opts.message || '';
    const ok = $('msgOk'), cancel = $('msgCancel');
    ok.textContent = opts.okLabel || 'OK';
    cancel.classList.toggle('hidden', !opts.cancel);
    if (opts.cancel) cancel.textContent = opts.cancelLabel || 'Cancel';
    ok.className = (opts.danger
        ? 'bg-bad hover:bg-bad/80 text-white'
        : 'bg-accent hover:bg-accent-hover text-white') + ' text-xs font-semibold px-4 py-2 rounded-md transition-colors';
    $('msgModal').classList.remove('hidden');
    setTimeout(() => ok.focus(), 30);
}

function close(val) {
    const r = resolver; resolver = null;
    if (queue.length) {
        // Keep the modal up and swap its contents straight into the next one.
        if (r) r(val);
        drain();
        return;
    }
    $('msgModal').classList.add('hidden');
    if (r) r(val);
}

function notify(message, opts) {
    opts = opts || {};
    return open({ title: opts.title || (opts.kind === 'error' ? 'Error' : opts.kind === 'warn' ? 'Warning' : 'Notice'), message, kind: opts.kind || 'info', okLabel: opts.okLabel || 'OK', cancel: false }).then(() => true);
}
function confirm(message, opts) {
    opts = opts || {};
    return open({ title: opts.title || 'Please confirm', message, kind: opts.kind || 'confirm', okLabel: opts.okLabel || 'OK', cancelLabel: opts.cancelLabel || 'Cancel', danger: opts.danger, cancel: true }).then(v => v === true);
}

function init() {
    const m = $('msgModal');
    $('msgOk').addEventListener('click', () => close(true));
    $('msgCancel').addEventListener('click', () => close(false));
    m.addEventListener('mousedown', e => { if (e.target === m) close(false); });
    m.addEventListener('keydown', e => { if (e.key === 'Enter') close(true); if (e.key === 'Escape') close(false); });
}

module.exports = { notify, confirm, init };
