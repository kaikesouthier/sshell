
const { $ } = require('./util');
const icons = require('./icons');

let resolver = null;
let working = { icon: null, color: 'txt' };

function open(current) {
    if (resolver) { const prev = resolver; resolver = null; try { prev(null); } catch (e) {} }
    return new Promise(res => {
        resolver = res;
        working = { icon: (current && current.icon) || null, color: (current && current.color) || 'txt' };
        renderColors();
        renderGrid();
        $('iconPicker').classList.remove('hidden');
    });
}
function close(val) {
    $('iconPicker').classList.add('hidden');
    const r = resolver; resolver = null;
    if (r) r(val);
}

function renderColors() {
    const wrap = $('ipColors');
    const swatches = icons.COLOR_TOKENS.concat(icons.COLOR_HEX);
    wrap.innerHTML = swatches.map(c => {
        const sel = working.color === c ? 'ring-2 ring-offset-2 ring-offset-panel2 ring-txt' : 'hover:scale-110';
        return `<button data-color="${c}" class="ip-color w-6 h-6 rounded-full transition-transform ${sel}" style="background:${icons.resolveColor(c)}"></button>`;
    }).join('');
    wrap.querySelectorAll('.ip-color').forEach(b => b.addEventListener('click', () => { working.color = b.dataset.color; renderColors(); renderGrid(); }));
}
function renderGrid() {
    const grid = $('ipGrid');
    grid.innerHTML = icons.ICON_KEYS.map(k => {
        const sel = working.icon === k ? 'bg-accent/20 ring-1 ring-accent' : 'hover:bg-panel3';
        return `<button data-icon="${k}" title="${k}" class="ip-icon aspect-square rounded-md flex items-center justify-center transition-colors ${sel}">${icons.iconSvg(k, working.color, 'w-5 h-5')}</button>`;
    }).join('');
    grid.querySelectorAll('.ip-icon').forEach(b => b.addEventListener('click', () => { working.icon = b.dataset.icon; renderGrid(); }));
}

function isOpen() { return !$('iconPicker').classList.contains('hidden'); }
function cancel() { if (isOpen() || resolver) close(null); }

function init() {
    $('ipClose').addEventListener('click', () => close(null));
    $('ipCancel').addEventListener('click', () => close(null));
    $('ipClear').addEventListener('click', () => close({ icon: null, color: working.color }));
    $('ipOk').addEventListener('click', () => close({ icon: working.icon, color: working.color }));
    $('iconPicker').addEventListener('mousedown', e => { if (e.target === $('iconPicker')) close(null); });
}

module.exports = { open, init, isOpen, cancel };
