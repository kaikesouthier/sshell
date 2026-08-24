
const { $, escapeHtml } = require('./util');
const errors = require('./errors');

const EL = 'ctxMenu';
let closer = null;

function isOpen() { return !$(EL).classList.contains('hidden'); }

function close() {
    const el = $(EL);
    el.classList.add('hidden');
    el.innerHTML = '';
    if (closer) { const c = closer; closer = null; try { c(); } catch (e) {} }
}

// items: [{ label, sublabel, icon, danger, disabled, act }] or { sep: true }
function open(x, y, items, opts) {
    close();
    opts = opts || {};
    const el = $(EL);

    if (opts.title) {
        const h = document.createElement('div');
        h.className = 'px-3 py-1.5 border-b border-edge text-[10px] font-semibold tracking-widest text-faint uppercase truncate';
        h.textContent = opts.title;
        el.appendChild(h);
    }

    items.forEach(it => {
        if (it.sep) {
            const d = document.createElement('div');
            d.className = 'my-1 border-t border-edge';
            el.appendChild(d);
            return;
        }
        const b = document.createElement('button');
        b.disabled = !!it.disabled;
        b.className = 'w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2.5 transition-colors ' +
            (it.disabled ? 'text-faint cursor-default'
                : it.danger ? 'text-bad hover:bg-bad hover:text-white'
                    : 'text-txt/90 hover:bg-accent hover:text-white');
        b.innerHTML =
            `<span class="w-4 h-4 shrink-0 flex items-center justify-center opacity-80">${it.icon || ''}</span>` +
            `<span class="flex-grow truncate">${escapeHtml(it.label)}</span>` +
            (it.sublabel ? `<span class="shrink-0 text-[10px] opacity-60 font-mono">${escapeHtml(it.sublabel)}</span>` : '');
        if (!it.disabled) {
            b.addEventListener('click', () => {
                close();
                if (it.act) errors.attempt(it.act, 'ctxmenu:' + it.label);
            });
        }
        el.appendChild(b);
    });

    // Measure off-screen so the menu can be flipped instead of clipped when it
    // opens near the right or bottom edge.
    el.style.left = '-9999px';
    el.style.top = '0px';
    el.classList.remove('hidden');

    const r = el.getBoundingClientRect();
    const pad = 6;
    let left = x, top = y;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, x - r.width);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
    el.style.left = left + 'px';
    el.style.top = top + 'px';

    closer = opts.onClose || null;
}

const ICONS = {
    open: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5h5v5M19 5l-8 8M12 5H6a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-6"></path></svg>',
    edit: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.4-9.4a2 2 0 112.8 2.8L11.8 15.8 8 17l1.2-3.8 8.4-8.4z"></path></svg>',
    rename: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7V5h16v2M9 19h6M12 5v14"></path></svg>',
    trash: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-1.99-1.86L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3m-9 0h14"></path></svg>',
    folder: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"></path></svg>',
    plus: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 5v14M5 12h14"></path></svg>',
    palette: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343"></path></svg>',
    stack: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"></path></svg>',
    check: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>',
    x: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>',
    refresh: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.6M20 20v-5h-.6M5 9a7 7 0 0111.6-3M19 15a7 7 0 01-11.6 3"></path></svg>',
    upload: '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 9l5-5 5 5M12 4v12"></path></svg>'
};

function init() {
    document.addEventListener('mousedown', e => {
        if (isOpen() && !$(EL).contains(e.target)) close();
    }, true);
    document.addEventListener('contextmenu', e => {
        if (isOpen() && !$(EL).contains(e.target)) close();
    }, true);
    window.addEventListener('blur', () => { if (isOpen()) close(); });
    window.addEventListener('resize', () => { if (isOpen()) close(); });
    document.addEventListener('wheel', () => { if (isOpen()) close(); }, true);
}

module.exports = { open, close, isOpen, init, ICONS };
