
const { ipcRenderer } = require('electron');
const { $, escapeHtml } = require('./util');
const RT = require('./runtime');
const config = require('./config');

function hexToRgb(hex) {
    let h = (hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function triplet(hex) { return hexToRgb(hex).join(' '); }
function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
function toHex(r, g, b) { return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join(''); }
function mixHex(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); }

const UI_KEYS = ['bg', 'panel', 'panel2', 'panel3', 'edge', 'edge2', 'txt', 'muted', 'faint', 'accent', 'accentHover', 'ok', 'warn', 'bad'];
const TERM_KEYS = ['termBg', 'termFg', 'termCursor', 'termSelection', 'ansiBlack', 'ansiRed', 'ansiGreen', 'ansiYellow', 'ansiBlue', 'ansiMagenta', 'ansiCyan', 'ansiWhite'];
const ALL_KEYS = UI_KEYS.concat(TERM_KEYS);

const DEFAULT_THEME = {
    bg: '#0b0e14', panel: '#0f131b', panel2: '#161b24', panel3: '#1c222d', edge: '#232a35', edge2: '#303a48',
    txt: '#e6edf3', muted: '#8b95a5', faint: '#5a6473',
    accent: '#5b9bff', accentHover: '#7fb3ff', ok: '#3fb950', warn: '#e3b341', bad: '#f85149',
    termBg: '#000000', termFg: '#e6edf3', termCursor: '#5b9bff', termSelection: '#5b9bff',
    ansiBlack: '#15161e', ansiRed: '#f7768e', ansiGreen: '#9ece6a', ansiYellow: '#e0af68',
    ansiBlue: '#7aa2f7', ansiMagenta: '#bb9af7', ansiCyan: '#7dcfff', ansiWhite: '#c0caf5'
};

const PRESETS = {
    'Tokyo Night': DEFAULT_THEME,
    'Dracula': {
        bg: '#191a21', panel: '#21222c', panel2: '#282a36', panel3: '#343746', edge: '#3a3d4c', edge2: '#4a4d5e',
        txt: '#f8f8f2', muted: '#a9adc1', faint: '#6272a4',
        accent: '#bd93f9', accentHover: '#d6b6ff', ok: '#50fa7b', warn: '#f1fa8c', bad: '#ff5555',
        termBg: '#282a36', termFg: '#f8f8f2', termCursor: '#bd93f9', termSelection: '#bd93f9',
        ansiBlack: '#21222c', ansiRed: '#ff5555', ansiGreen: '#50fa7b', ansiYellow: '#f1fa8c',
        ansiBlue: '#bd93f9', ansiMagenta: '#ff79c6', ansiCyan: '#8be9fd', ansiWhite: '#f8f8f2'
    },
    'Nord': {
        bg: '#242933', panel: '#2e3440', panel2: '#3b4252', panel3: '#434c5e', edge: '#434c5e', edge2: '#4c566a',
        txt: '#eceff4', muted: '#a7b0c0', faint: '#6c7689',
        accent: '#88c0d0', accentHover: '#a3d4e2', ok: '#a3be8c', warn: '#ebcb8b', bad: '#bf616a',
        termBg: '#2e3440', termFg: '#eceff4', termCursor: '#88c0d0', termSelection: '#88c0d0',
        ansiBlack: '#3b4252', ansiRed: '#bf616a', ansiGreen: '#a3be8c', ansiYellow: '#ebcb8b',
        ansiBlue: '#81a1c1', ansiMagenta: '#b48ead', ansiCyan: '#88c0d0', ansiWhite: '#e5e9f0'
    },
    'Solarized Dark': {
        bg: '#00212b', panel: '#002b36', panel2: '#073642', panel3: '#0a4453', edge: '#0a4453', edge2: '#0f5666',
        txt: '#eee8d5', muted: '#93a1a1', faint: '#586e75',
        accent: '#268bd2', accentHover: '#4ba6e6', ok: '#859900', warn: '#b58900', bad: '#dc322f',
        termBg: '#002b36', termFg: '#eee8d5', termCursor: '#268bd2', termSelection: '#268bd2',
        ansiBlack: '#073642', ansiRed: '#dc322f', ansiGreen: '#859900', ansiYellow: '#b58900',
        ansiBlue: '#268bd2', ansiMagenta: '#d33682', ansiCyan: '#2aa198', ansiWhite: '#eee8d5'
    },
    'Gruvbox Dark': {
        bg: '#1d2021', panel: '#282828', panel2: '#32302f', panel3: '#3c3836', edge: '#3c3836', edge2: '#504945',
        txt: '#ebdbb2', muted: '#bdae93', faint: '#7c6f64',
        accent: '#fabd2f', accentHover: '#ffd160', ok: '#b8bb26', warn: '#fe8019', bad: '#fb4934',
        termBg: '#282828', termFg: '#ebdbb2', termCursor: '#fabd2f', termSelection: '#fabd2f',
        ansiBlack: '#282828', ansiRed: '#fb4934', ansiGreen: '#b8bb26', ansiYellow: '#fabd2f',
        ansiBlue: '#83a598', ansiMagenta: '#d3869b', ansiCyan: '#8ec07c', ansiWhite: '#ebdbb2'
    },
    'One Light': {
        bg: '#eaeef2', panel: '#f4f6f9', panel2: '#ffffff', panel3: '#e7ebf0', edge: '#d3d9e0', edge2: '#c2cad4',
        txt: '#1c2430', muted: '#5a6472', faint: '#9aa4b2',
        accent: '#3b82f6', accentHover: '#2563eb', ok: '#16a34a', warn: '#d97706', bad: '#dc2626',
        termBg: '#fafafa', termFg: '#383a42', termCursor: '#3b82f6', termSelection: '#3b82f6',
        ansiBlack: '#383a42', ansiRed: '#e45649', ansiGreen: '#50a14f', ansiYellow: '#c18401',
        ansiBlue: '#4078f2', ansiMagenta: '#a626a4', ansiCyan: '#0184bc', ansiWhite: '#fafafa'
    },
    'One Dark': {
        bg: '#21252b', panel: '#282c34', panel2: '#2c313a', panel3: '#333842', edge: '#3b4048', edge2: '#4b5263',
        txt: '#abb2bf', muted: '#828997', faint: '#5c6370',
        accent: '#61afef', accentHover: '#82c0ff', ok: '#98c379', warn: '#e5c07b', bad: '#e06c75',
        termBg: '#282c34', termFg: '#abb2bf', termCursor: '#61afef', termSelection: '#61afef',
        ansiBlack: '#3f4451', ansiRed: '#e06c75', ansiGreen: '#98c379', ansiYellow: '#e5c07b',
        ansiBlue: '#61afef', ansiMagenta: '#c678dd', ansiCyan: '#56b6c2', ansiWhite: '#abb2bf'
    },
    'Monokai': {
        bg: '#1e1f1c', panel: '#272822', panel2: '#2f302a', panel3: '#3a3b34', edge: '#41423b', edge2: '#54554d',
        txt: '#f8f8f2', muted: '#bcbcae', faint: '#75715e',
        accent: '#66d9ef', accentHover: '#8ee6f5', ok: '#a6e22e', warn: '#e6db74', bad: '#f92672',
        termBg: '#272822', termFg: '#f8f8f2', termCursor: '#f8f8f0', termSelection: '#66d9ef',
        ansiBlack: '#272822', ansiRed: '#f92672', ansiGreen: '#a6e22e', ansiYellow: '#e6db74',
        ansiBlue: '#66d9ef', ansiMagenta: '#ae81ff', ansiCyan: '#a1efe4', ansiWhite: '#f8f8f2'
    },
    'Catppuccin Mocha': {
        bg: '#181825', panel: '#1e1e2e', panel2: '#282839', panel3: '#313244', edge: '#3b3b52', edge2: '#494963',
        txt: '#cdd6f4', muted: '#a6adc8', faint: '#6c7086',
        accent: '#89b4fa', accentHover: '#a6c8ff', ok: '#a6e3a1', warn: '#f9e2af', bad: '#f38ba8',
        termBg: '#1e1e2e', termFg: '#cdd6f4', termCursor: '#f5e0dc', termSelection: '#89b4fa',
        ansiBlack: '#45475a', ansiRed: '#f38ba8', ansiGreen: '#a6e3a1', ansiYellow: '#f9e2af',
        ansiBlue: '#89b4fa', ansiMagenta: '#cba6f7', ansiCyan: '#94e2d5', ansiWhite: '#bac2de'
    },
    'Catppuccin Latte': {
        bg: '#dce0e8', panel: '#eff1f5', panel2: '#ffffff', panel3: '#e6e9ef', edge: '#ccd0da', edge2: '#bcc0cc',
        txt: '#4c4f69', muted: '#6c6f85', faint: '#9ca0b0',
        accent: '#1e66f5', accentHover: '#3f7bff', ok: '#40a02b', warn: '#df8e1d', bad: '#d20f39',
        termBg: '#eff1f5', termFg: '#4c4f69', termCursor: '#dc8a78', termSelection: '#1e66f5',
        ansiBlack: '#5c5f77', ansiRed: '#d20f39', ansiGreen: '#40a02b', ansiYellow: '#df8e1d',
        ansiBlue: '#1e66f5', ansiMagenta: '#8839ef', ansiCyan: '#179299', ansiWhite: '#acb0be'
    },
    'Ayu Dark': {
        bg: '#0a0e14', panel: '#0d1017', panel2: '#131721', panel3: '#1b1f2b', edge: '#22262f', edge2: '#2d333f',
        txt: '#bfbdb6', muted: '#8b9199', faint: '#565b66',
        accent: '#39bae6', accentHover: '#5cccf0', ok: '#aad94c', warn: '#ffb454', bad: '#f26d78',
        termBg: '#0d1017', termFg: '#bfbdb6', termCursor: '#ffb454', termSelection: '#39bae6',
        ansiBlack: '#131721', ansiRed: '#f26d78', ansiGreen: '#aad94c', ansiYellow: '#ffb454',
        ansiBlue: '#39bae6', ansiMagenta: '#d2a6ff', ansiCyan: '#95e6cb', ansiWhite: '#bfbdb6'
    },
    'Ayu Mirage': {
        bg: '#1a1f29', panel: '#1f2430', panel2: '#242b38', panel3: '#2d3440', edge: '#343b48', edge2: '#434a58',
        txt: '#cccac2', muted: '#9a9490', faint: '#5c6773',
        accent: '#73d0ff', accentHover: '#94ddff', ok: '#d5ff80', warn: '#ffd173', bad: '#f28779',
        termBg: '#1f2430', termFg: '#cccac2', termCursor: '#ffcc66', termSelection: '#73d0ff',
        ansiBlack: '#242b38', ansiRed: '#f28779', ansiGreen: '#d5ff80', ansiYellow: '#ffd173',
        ansiBlue: '#73d0ff', ansiMagenta: '#dfbfff', ansiCyan: '#95e6cb', ansiWhite: '#cccac2'
    },
    'Night Owl': {
        bg: '#010e17', panel: '#011627', panel2: '#0b2942', panel3: '#0e3555', edge: '#0e3a5c', edge2: '#1d4b6e',
        txt: '#d6deeb', muted: '#8badc1', faint: '#5f7e97',
        accent: '#82aaff', accentHover: '#a3c0ff', ok: '#22da6e', warn: '#ecc48d', bad: '#ef5350',
        termBg: '#011627', termFg: '#d6deeb', termCursor: '#82aaff', termSelection: '#82aaff',
        ansiBlack: '#1d3b53', ansiRed: '#ef5350', ansiGreen: '#22da6e', ansiYellow: '#ecc48d',
        ansiBlue: '#82aaff', ansiMagenta: '#c792ea', ansiCyan: '#21c7a8', ansiWhite: '#d6deeb'
    },
    'Palenight': {
        bg: '#1b1e2b', panel: '#292d3e', panel2: '#31364a', panel3: '#3a3f58', edge: '#444a63', edge2: '#565c78',
        txt: '#a6accd', muted: '#8891b5', faint: '#676e95',
        accent: '#82aaff', accentHover: '#a3c0ff', ok: '#c3e88d', warn: '#ffcb6b', bad: '#f07178',
        termBg: '#292d3e', termFg: '#a6accd', termCursor: '#ffcc00', termSelection: '#82aaff',
        ansiBlack: '#292d3e', ansiRed: '#f07178', ansiGreen: '#c3e88d', ansiYellow: '#ffcb6b',
        ansiBlue: '#82aaff', ansiMagenta: '#c792ea', ansiCyan: '#89ddff', ansiWhite: '#a6accd'
    },
    'Cobalt2': {
        bg: '#122738', panel: '#193549', panel2: '#1e415e', panel3: '#274b6b', edge: '#2f5578', edge2: '#3b688f',
        txt: '#ffffff', muted: '#a2b5c4', faint: '#627d96',
        accent: '#ffc600', accentHover: '#ffd633', ok: '#3ad900', warn: '#ff9d00', bad: '#ff2600',
        termBg: '#193549', termFg: '#ffffff', termCursor: '#ffc600', termSelection: '#0050a4',
        ansiBlack: '#193549', ansiRed: '#ff2600', ansiGreen: '#3ad900', ansiYellow: '#ffc600',
        ansiBlue: '#0088ff', ansiMagenta: '#fb94ff', ansiCyan: '#80fcff', ansiWhite: '#ffffff'
    },
    'Everforest Dark': {
        bg: '#272e33', panel: '#2b3339', panel2: '#323c41', panel3: '#3a454a', edge: '#414d53', edge2: '#4f5b58',
        txt: '#d3c6aa', muted: '#a6b0a0', faint: '#7a8478',
        accent: '#7fbbb3', accentHover: '#9fd0c8', ok: '#a7c080', warn: '#dbbc7f', bad: '#e67e80',
        termBg: '#2b3339', termFg: '#d3c6aa', termCursor: '#d3c6aa', termSelection: '#7fbbb3',
        ansiBlack: '#414b50', ansiRed: '#e67e80', ansiGreen: '#a7c080', ansiYellow: '#dbbc7f',
        ansiBlue: '#7fbbb3', ansiMagenta: '#d699b6', ansiCyan: '#83c092', ansiWhite: '#d3c6aa'
    },
    'Rose Pine': {
        bg: '#191724', panel: '#1f1d2e', panel2: '#26233a', panel3: '#2f2b45', edge: '#3b3653', edge2: '#4a4463',
        txt: '#e0def4', muted: '#908caa', faint: '#6e6a86',
        accent: '#c4a7e7', accentHover: '#d7c2f2', ok: '#9ccfd8', warn: '#f6c177', bad: '#eb6f92',
        termBg: '#1f1d2e', termFg: '#e0def4', termCursor: '#e0def4', termSelection: '#c4a7e7',
        ansiBlack: '#26233a', ansiRed: '#eb6f92', ansiGreen: '#9ccfd8', ansiYellow: '#f6c177',
        ansiBlue: '#31748f', ansiMagenta: '#c4a7e7', ansiCyan: '#ebbcba', ansiWhite: '#e0def4'
    },
    'GitHub Dark': {
        bg: '#010409', panel: '#0d1117', panel2: '#161b22', panel3: '#21262d', edge: '#30363d', edge2: '#3d444d',
        txt: '#e6edf3', muted: '#8b949e', faint: '#6e7681',
        accent: '#58a6ff', accentHover: '#79c0ff', ok: '#3fb950', warn: '#d29922', bad: '#f85149',
        termBg: '#0d1117', termFg: '#e6edf3', termCursor: '#58a6ff', termSelection: '#58a6ff',
        ansiBlack: '#484f58', ansiRed: '#ff7b72', ansiGreen: '#3fb950', ansiYellow: '#d29922',
        ansiBlue: '#58a6ff', ansiMagenta: '#bc8cff', ansiCyan: '#39c5cf', ansiWhite: '#b1bac4'
    },
    'GitHub Light': {
        bg: '#eaeef2', panel: '#ffffff', panel2: '#f6f8fa', panel3: '#eff2f5', edge: '#d0d7de', edge2: '#afb8c1',
        txt: '#1f2328', muted: '#59636e', faint: '#818b98',
        accent: '#0969da', accentHover: '#0860c9', ok: '#1a7f37', warn: '#9a6700', bad: '#cf222e',
        termBg: '#ffffff', termFg: '#1f2328', termCursor: '#0969da', termSelection: '#0969da',
        ansiBlack: '#24292f', ansiRed: '#cf222e', ansiGreen: '#116329', ansiYellow: '#4d2d00',
        ansiBlue: '#0969da', ansiMagenta: '#8250df', ansiCyan: '#1b7c83', ansiWhite: '#6e7781'
    },
    'Solarized Light': {
        bg: '#e8e2cf', panel: '#fdf6e3', panel2: '#eee8d5', panel3: '#e3dcc4', edge: '#d7cfb3', edge2: '#c9c0a0',
        txt: '#586e75', muted: '#657b83', faint: '#93a1a1',
        accent: '#268bd2', accentHover: '#2076b8', ok: '#859900', warn: '#b58900', bad: '#dc322f',
        termBg: '#fdf6e3', termFg: '#586e75', termCursor: '#268bd2', termSelection: '#268bd2',
        ansiBlack: '#073642', ansiRed: '#dc322f', ansiGreen: '#859900', ansiYellow: '#b58900',
        ansiBlue: '#268bd2', ansiMagenta: '#d33682', ansiCyan: '#2aa198', ansiWhite: '#eee8d5'
    },
    'Horizon': {
        bg: '#1b1d26', panel: '#1c1e26', panel2: '#232530', panel3: '#2e303e', edge: '#363946', edge2: '#454857',
        txt: '#d5d8da', muted: '#a2a4a8', faint: '#6c6f93',
        accent: '#e95678', accentHover: '#f16a89', ok: '#29d398', warn: '#fab795', bad: '#e95678',
        termBg: '#1c1e26', termFg: '#d5d8da', termCursor: '#e95678', termSelection: '#e95678',
        ansiBlack: '#232530', ansiRed: '#e95678', ansiGreen: '#29d398', ansiYellow: '#fab795',
        ansiBlue: '#26bbd9', ansiMagenta: '#ee64ac', ansiCyan: '#59e1e3', ansiWhite: '#d5d8da'
    }
};

const GROUPS = [
    { title: 'Interface', keys: [['bg', 'App background'], ['panel', 'Panel'], ['panel2', 'Panel (raised)'], ['panel3', 'Panel (highest)'], ['edge', 'Border'], ['edge2', 'Border (strong)']] },
    { title: 'Text', keys: [['txt', 'Text'], ['muted', 'Muted text'], ['faint', 'Faint text']] },
    { title: 'Accent & Status', keys: [['accent', 'Accent'], ['accentHover', 'Accent (hover)'], ['ok', 'Success'], ['warn', 'Warning'], ['bad', 'Error']] },
    { title: 'Terminal', keys: [['termBg', 'Background'], ['termFg', 'Text'], ['termCursor', 'Cursor'], ['termSelection', 'Selection'], ['ansiBlack', 'Black'], ['ansiRed', 'Red'], ['ansiGreen', 'Green'], ['ansiYellow', 'Yellow'], ['ansiBlue', 'Blue'], ['ansiMagenta', 'Magenta'], ['ansiCyan', 'Cyan'], ['ansiWhite', 'White']] }
];

let current = Object.assign({}, DEFAULT_THEME);
let currentTermTheme = buildTermTheme(current);

function sanitize(t) {
    const out = Object.assign({}, DEFAULT_THEME);
    if (t && typeof t === 'object') ALL_KEYS.forEach(k => { if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t[k])) out[k] = t[k]; });
    return out;
}
function buildTermTheme(t) {
    return {
        background: t.termBg, foreground: t.termFg, cursor: t.termCursor, cursorAccent: t.termBg,
        selectionBackground: rgba(t.termSelection, 0.35),
        black: t.ansiBlack, red: t.ansiRed, green: t.ansiGreen, yellow: t.ansiYellow,
        blue: t.ansiBlue, magenta: t.ansiMagenta, cyan: t.ansiCyan, white: t.ansiWhite,
        brightBlack: mixHex(t.ansiBlack, '#ffffff', 0.25), brightRed: t.ansiRed, brightGreen: t.ansiGreen,
        brightYellow: t.ansiYellow, brightBlue: t.ansiBlue, brightMagenta: t.ansiMagenta, brightCyan: t.ansiCyan, brightWhite: '#ffffff'
    };
}
function getTermTheme() { return currentTermTheme; }

let lastOverlay = '';

function applyTheme(t) {
    const root = document.documentElement;
    const set = (name, hex) => { const tr = triplet(hex); root.style.setProperty('--' + name + '-rgb', tr); root.style.setProperty('--' + name, 'rgb(' + tr + ')'); };
    UI_KEYS.forEach(k => set(k, t[k]));
    set('accentDim', mixHex(t.accent, t.bg, 0.62));
    currentTermTheme = buildTermTheme(t);
    RT.tabs.forEach(tab => { if (tab.term) { try { tab.term.options.theme = currentTermTheme; } catch (e) {} } });

    // applyTheme runs on every input event while a colour slider is dragged.
    const overlay = t.bg + '|' + t.txt;
    if (overlay !== lastOverlay) {
        lastOverlay = overlay;
        try { ipcRenderer.invoke('set-titlebar-overlay', { color: t.bg, symbolColor: t.txt }).catch(() => {}); } catch (e) {}
    }
    current = Object.assign({}, t);
}
function applyFromConfig() { applyTheme(sanitize(config.data.theme)); }

let working = null, snapshot = null;

function openThemeBuilder() {
    snapshot = Object.assign({}, current);
    working = Object.assign({}, current);
    buildControls();
    renderPreview();
    $('themeModal').classList.remove('hidden');
}
function closeThemeBuilder(revert) {
    if (revert && snapshot) applyTheme(snapshot);
    $('themeModal').classList.add('hidden');
}
function buildControls() {
    const wrap = $('themeControls');

    let html = `<div class="mb-4"><div class="text-[11px] font-semibold tracking-widest text-faint uppercase mb-2">Preset</div>
        <select id="themePresetSelect" class="w-full bg-panel border border-edge rounded-md px-3 py-2 text-xs text-txt focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50">
            <option value="">— Start from a preset (${Object.keys(PRESETS).length}) —</option>
            ${Object.keys(PRESETS).map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')}
        </select></div>`;
    GROUPS.forEach(g => {
        html += `<div class="mb-4"><div class="text-[11px] font-semibold tracking-widest text-faint uppercase mb-2">${g.title}</div><div class="space-y-1.5">`;
        g.keys.forEach(([key, label]) => {
            html += `<div class="flex items-center gap-2.5">
                <input type="color" data-color="${key}" value="${working[key]}" class="swatch shrink-0">
                <input type="text" data-hex="${key}" value="${working[key]}" spellcheck="false" class="w-20 bg-panel border border-edge rounded px-2 py-1 text-[11px] font-mono text-txt focus:outline-none focus:border-accent">
                <span class="text-xs text-muted">${label}</span>
            </div>`;
        });
        html += `</div></div>`;
    });
    wrap.innerHTML = html;

    const presetSel = wrap.querySelector('#themePresetSelect');
    if (presetSel) presetSel.addEventListener('change', () => {
        if (!presetSel.value) return;
        working = mergePreset(PRESETS[presetSel.value]);
        syncInputs(); applyTheme(working); renderPreview();
    });
    wrap.querySelectorAll('input[data-color]').forEach(inp => inp.addEventListener('input', () => {
        const k = inp.dataset.color; working[k] = inp.value;
        const hx = wrap.querySelector(`input[data-hex="${k}"]`); if (hx) hx.value = inp.value;
        applyTheme(working); renderPreview();
    }));
    wrap.querySelectorAll('input[data-hex]').forEach(inp => inp.addEventListener('input', () => {
        let v = inp.value.trim(); if (!v.startsWith('#')) v = '#' + v;
        if (!/^#([0-9a-f]{6})$/i.test(v)) return;
        const k = inp.dataset.hex; working[k] = v;
        const sw = wrap.querySelector(`input[data-color="${k}"]`); if (sw) sw.value = v;
        applyTheme(working); renderPreview();
    }));
}
function mergePreset(p) { const out = Object.assign({}, DEFAULT_THEME); ALL_KEYS.forEach(k => { if (p[k]) out[k] = p[k]; }); return out; }
function syncInputs() {
    const wrap = $('themeControls');
    ALL_KEYS.forEach(k => {
        const sw = wrap.querySelector(`input[data-color="${k}"]`); if (sw) sw.value = working[k];
        const hx = wrap.querySelector(`input[data-hex="${k}"]`); if (hx) hx.value = working[k];
    });
}
// Coalesce to one rebuild per frame; a dragged slider fires input events far
// faster than the preview can usefully be repainted.
let previewQueued = false;
function renderPreview() {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => { previewQueued = false; paintPreview(); });
}

function paintPreview() {
    const t = working;
    const ansi = [['Black', t.ansiBlack], ['Red', t.ansiRed], ['Green', t.ansiGreen], ['Yellow', t.ansiYellow], ['Blue', t.ansiBlue], ['Magenta', t.ansiMagenta], ['Cyan', t.ansiCyan], ['White', t.ansiWhite]];
    $('themePreview').innerHTML = `
        <div class="rounded-lg overflow-hidden border" style="border-color:${t.edge}">
            <div class="flex items-center gap-2 px-3 h-9" style="background:${t.bg};border-bottom:1px solid ${t.edge}">
                <span class="w-5 h-5 rounded" style="background:linear-gradient(135deg,${t.accent},${t.accentHover})"></span>
                <span class="text-[12px] font-semibold" style="color:${t.txt}">SSH<span style="color:${t.accent}">ell</span></span>
                <span class="ml-3 text-[11px]" style="color:${t.muted}">File</span><span class="text-[11px]" style="color:${t.muted}">Edit</span>
                <span class="ml-auto text-[11px] px-2 py-0.5 rounded" style="background:${t.panel2};color:${t.txt}">server-01</span>
            </div>
            <div class="flex" style="height:150px">
                <div class="w-32 p-2 space-y-1" style="background:${t.panel};border-right:1px solid ${t.edge}">
                    <div class="text-[10px] font-semibold uppercase tracking-wider" style="color:${t.faint}">Sessions</div>
                    <div class="flex items-center gap-1.5 px-1.5 py-1 rounded" style="background:${t.panel2}">
                        <span class="w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center" style="background:${t.panel3};color:${t.accent}">PR</span>
                        <span class="text-[11px]" style="color:${t.txt}">prod-web</span></div>
                    <div class="flex items-center gap-1.5 px-1.5 py-1"><span class="w-2 h-2 rounded-full" style="background:${t.ok}"></span><span class="text-[11px]" style="color:${t.muted}">db-01</span></div>
                    <div class="flex items-center gap-1.5 px-1.5 py-1"><span class="w-2 h-2 rounded-full" style="background:${t.bad}"></span><span class="text-[11px]" style="color:${t.muted}">cache</span></div>
                </div>
                <div class="flex-grow p-2 font-mono text-[11px] leading-relaxed" style="background:${t.termBg}">
                    <div><span style="color:${t.ansiGreen}">user@host</span><span style="color:${t.termFg}">:</span><span style="color:${t.ansiBlue}">~/app</span><span style="color:${t.termFg}">$ ls</span></div>
                    <div>${ansi.map(a => `<span style="color:${a[1]}">${a[0].slice(0, 3)}</span>`).join(' ')}</div>
                    <div><span style="color:${t.ansiYellow}">warning:</span> <span style="color:${t.termFg}">build ok</span> <span style="background:${t.termCursor};color:${t.termBg}">&nbsp;</span></div>
                </div>
            </div>
            <div class="flex items-center gap-2 px-3 h-8" style="background:${t.panel};border-top:1px solid ${t.edge}">
                ${['accent', 'ok', 'warn', 'bad'].map(k => `<span class="text-[10px] px-2 py-0.5 rounded" style="background:${t[k]};color:${t.bg}">${k}</span>`).join('')}
                <span class="ml-auto text-[10px]" style="color:${t.muted}">CPU 4% · RAM 1.5/2.0 GB</span>
            </div>
        </div>`;
}

function init() {
    $('themeClose').addEventListener('click', () => closeThemeBuilder(true));
    $('themeCancel').addEventListener('click', () => closeThemeBuilder(true));
    $('themeModal').addEventListener('mousedown', e => { if (e.target === $('themeModal')) closeThemeBuilder(true); });
    $('themeReset').addEventListener('click', () => { working = Object.assign({}, DEFAULT_THEME); syncInputs(); applyTheme(working); renderPreview(); });
    $('themeSave').addEventListener('click', () => {
        config.data.theme = Object.assign({}, working);
        config.save();
        applyTheme(working);
        $('themeModal').classList.add('hidden');
    });
}

module.exports = { getTermTheme, applyTheme, applyFromConfig, openThemeBuilder, init, DEFAULT_THEME };
