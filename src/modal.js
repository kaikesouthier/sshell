
const { $, escapeHtml } = require('./util');

let inputResolver = null;

function askInput(opts) {
    const inputModal = $('inputModal');

    if (inputResolver) { const prev = inputResolver; inputResolver = null; try { prev(null); } catch (e) {} }
    return new Promise(resolve => {
        inputResolver = resolve;
        $('inputTitle').textContent = opts.title || 'Input';
        const msg = $('inputMsg');
        if (opts.message) { msg.textContent = opts.message; msg.classList.remove('hidden'); }
        else msg.classList.add('hidden');
        $('inputOk').textContent = opts.okLabel || 'OK';
        $('inputError').classList.add('hidden');

        const wrap = $('inputFields');
        wrap.innerHTML = '';
        (opts.fields || []).forEach(f => {
            const label = document.createElement('label');
            label.className = 'block';
            label.innerHTML = `<span class="block text-[11px] font-semibold text-muted mb-1">${escapeHtml(f.label || '')}</span>`;
            const inp = document.createElement('input');
            inp.type = f.type || 'text';
            inp.placeholder = f.placeholder || '';
            inp.value = f.value || '';
            inp.dataset.key = f.key;
            inp.className = 'inp-field w-full bg-panel border border-edge rounded-md px-3 py-2 text-sm text-txt placeholder-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50';
            label.appendChild(inp);
            wrap.appendChild(label);
        });
        inputModal.classList.remove('hidden');
        setTimeout(() => { const first = wrap.querySelector('.inp-field'); first && first.focus(); }, 30);
    });
}

function collectInput() {
    const out = {};
    $('inputModal').querySelectorAll('.inp-field').forEach(i => out[i.dataset.key] = i.value);
    return out;
}
function closeInput(result) {
    $('inputModal').classList.add('hidden');
    // Values were only replaced when the NEXT dialog opened, so the last thing
    // typed — every master passphrase in the app passes through here — stayed
    // live in the DOM indefinitely.
    const wrap = $('inputFields');
    wrap.querySelectorAll('.inp-field').forEach(i => { try { i.value = ''; i.defaultValue = ''; } catch (e) {} });
    wrap.innerHTML = '';
    const r = inputResolver; inputResolver = null;
    if (r) r(result);
}

function init() {
    const inputModal = $('inputModal');
    $('inputOk').addEventListener('click', () => closeInput(collectInput()));
    $('inputCancel').addEventListener('click', () => closeInput(null));
    inputModal.addEventListener('mousedown', e => { if (e.target === inputModal) closeInput(null); });
    inputModal.addEventListener('keydown', e => {
        // This listener runs before the document-level one, which then sees the
        // dialog already hidden and moves on to close whatever is underneath —
        // one Escape used to shut the re-auth prompt AND the session editor,
        // discarding unsaved edits.
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        e.stopPropagation();
        if (e.key === 'Enter') closeInput(collectInput());
        else closeInput(null);
    });
}

function cancel() { if (!$('inputModal').classList.contains('hidden') || inputResolver) closeInput(null); }

module.exports = { askInput, init, cancel };
