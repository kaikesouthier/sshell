
const { $, escapeHtml } = require('./util');
const RT = require('./runtime');
const S = require('./store');

function simple(dotClass, text) {
    $('statusLeft').innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${dotClass} shrink-0"></span><span class="truncate">${escapeHtml(text)}</span>`;
}

const IC = {
    host: 'M5 4h14a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM5 13h14a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1v-5a1 1 0 011-1zM8 7h.01M8 16h.01',
    cpu: 'M9 3v2m6-2v2M9 19v2m6-2v2M3 9h2m-2 6h2m14-6h2m-2 6h2M6 6h12v12H6z',
    ram: 'M4 8h16v8H4zM7 16v2m4-2v2m4-2v2M8 8V6m4 2V6m4 2V6',
    net: 'M12 19V5m0 0l-4 4m4-4l4 4M6 19h12',
    up: 'M5 15l7-7 7 7',
    clock: 'M12 6v6l4 2M12 22a10 10 0 100-20 10 10 0 000 20z',
    users: 'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z',
    disk: 'M4 6h16v12H4zM4 10h16M7 14h.01'
};
function icon(name, cls) {
    return `<svg class="w-3.5 h-3.5 shrink-0 ${cls || 'text-faint'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="${IC[name]}"></path></svg>`;
}
function metric(iconName, iconCls, valueHtml) {
    return `<span class="flex items-center gap-1.5 shrink-0">${icon(iconName, iconCls)}<span class="font-mono">${valueHtml}</span></span>`;
}
const DIV = '<span class="w-px h-3.5 bg-edge2 shrink-0"></span>';

function renderMonitor(m) {
    const cpu = m.cpu != null ? m.cpu.toFixed(0) + '%' : '—';
    const cpuCls = m.cpu > 80 ? 'text-bad font-bold' : m.cpu > 50 ? 'text-warn' : 'text-txt/90';
    const ram = (m.memUsed != null && m.memTotal != null) ? `${m.memUsed.toFixed(2)} / ${m.memTotal.toFixed(2)} GB` : '—';
    const up = m.up != null ? m.up.toFixed(1) : '0.0';
    const down = m.down != null ? m.down.toFixed(1) : '0.0';
    const disk = m.disk != null ? m.disk + '%' : '—';
    const diskCls = m.disk > 90 ? 'text-bad font-bold' : m.disk > 75 ? 'text-warn' : 'text-txt/90';
    $('statusLeft').innerHTML =
        `<span class="flex items-center gap-1.5 shrink-0">${icon('host', 'text-ok')}<span class="font-semibold text-txt">${escapeHtml(m.host)}</span></span>` + DIV +
        metric('cpu', 'text-faint', `<span class="${cpuCls}">${cpu}</span>`) + DIV +
        metric('ram', 'text-faint', `<span class="text-txt/90">${ram}</span>`) + DIV +
        metric('net', 'text-faint', `<span class="text-accent">↑${up}</span> <span class="text-ok">↓${down}</span> <span class="text-faint">Mb/s</span>`) + DIV +
        metric('clock', 'text-faint', `<span class="text-txt/90">${escapeHtml(m.uptime || '—')}</span>`) + DIV +
        metric('users', 'text-faint', `<span class="text-txt/90">${m.userCount != null ? m.userCount : '—'}</span>${m.users ? ` <span class="text-muted">(${escapeHtml(m.users)})</span>` : ''}`) + DIV +
        metric('disk', 'text-faint', `<span class="${diskCls}">${disk}</span>`);
}

function loadingMonitor(host) {
    $('statusLeft').innerHTML =
        `<div class="spinner sm shrink-0"></div><span class="text-muted shrink-0">Reading metrics${host ? ' — ' + escapeHtml(host) : ''}…</span>`;
}

function updateStatusBar() {
    const active = RT.tabs.find(t => t.id === RT.activeTabId);
    if (!active) simple('bg-faint', 'Ready');
    else if (active.type === 'tool') simple('bg-accent', active.title);
    else if (active.type === 'grid') {
        const open = RT.tabs.filter(t => t.type === 'terminal').length;
        const conn = RT.tabs.filter(t => t.type === 'terminal' && t.connected).length;
        simple('bg-accent', `Grid — ${open} open tab(s), ${conn} connected`);
    } else {
        const cfg = S.getSession(active.configId) || {};
        if (active.error) simple('bg-bad', 'Error: ' + active.error);
        else if (active.connected && active.monitor && active.monitor.cpu != null) renderMonitor(active.monitor);
        else if (active.connected && active.monitorUnavailable) simple('bg-ok', `Connected — ${cfg.host || ''} (live metrics unavailable on this host)`);
        else if (active.connected) loadingMonitor(cfg.host);
        else simple('bg-warn', `Connecting — ${cfg.host || ''}`);
    }
    const open = RT.tabs.filter(t => t.type === 'terminal').length;
    $('statusRight').innerHTML = `<span>${open} tab${open === 1 ? '' : 's'}</span><span class="text-edge2">|</span><span id="clock2">${new Date().toLocaleTimeString()}</span>`;
}

function initClock() {
    setInterval(() => {
        const c = $('clock'); if (c) c.textContent = new Date().toLocaleTimeString();
        const c2 = $('clock2'); if (c2) c2.textContent = new Date().toLocaleTimeString();
    }, 1000);
}

// --- resizable height ------------------------------------------------------
// One row fits the metrics on a wide window, but not on a narrow one, where
// they scroll out of reach. Dragging the top edge gives them room to wrap.
const STATUS_MIN = 24, STATUS_MAX = 260, STATUS_DEFAULT = 32;
// Leave room for the title bar, the toolbar and a few rows of terminal on a
// window that can be as short as 560px.
const CHROME_MIN = 260;
function maxStatus() {
    const h = (typeof window !== 'undefined' && window.innerHeight) || 900;
    return Math.max(STATUS_MIN, Math.min(STATUS_MAX, h - CHROME_MIN));
}
// Below this there is no room for a second row, so wrapping would only clip.
const TALL_AT = 46;

function statusHeight() {
    const config = require('./config');
    const saved = Number(config.data.statusBarHeight);
    if (isFinite(saved) && saved >= STATUS_MIN && saved <= STATUS_MAX) return Math.round(saved);
    return STATUS_DEFAULT;
}

function applyStatusHeight(px) {
    const h = Math.round(Math.min(maxStatus(), Math.max(STATUS_MIN, px)));
    document.documentElement.style.setProperty('--status-h', h + 'px');
    document.documentElement.classList.toggle('status-tall', h >= TALL_AT);
    return h;
}

let heightSaveTimer = null;
function rememberStatusHeight(px) {
    const config = require('./config');
    config.data.statusBarHeight = px;
    clearTimeout(heightSaveTimer);
    heightSaveTimer = setTimeout(() => require('./errors').attempt(() => config.save(), 'status bar height'), 400);
}

// The terminal and the canvas share the space this bar takes, so both have to
// re-measure once it settles.
function refitActive() {
    require('./errors').attempt(() => {
        const a = RT.tabs.find(t => t.id === RT.activeTabId);
        if (a && a.type === 'terminal') require('./tabs').fitTerminalTab(a);
        else if (a && a.type === 'grid' && a.grid) a.grid.refit();
    }, 'status resize refit');
}

function installStatusResizer() {
    const bar = $('statusBar');
    if (!bar || bar.querySelector('.status-grip')) return;

    const grip = document.createElement('div');
    grip.className = 'status-grip';
    grip.title = 'Drag to resize — double-click to reset';
    bar.appendChild(grip);

    let dragging = false, startY = 0, startH = 0;

    const move = e => {
        if (!dragging) return;
        // The bar grows upward, so a drag toward the top is a bigger bar.
        applyStatusHeight(startH - (e.clientY - startY));
    };
    const stop = () => {
        if (!dragging) return;
        dragging = false;
        grip.classList.remove('grip-active');
        document.documentElement.classList.remove('resizing-status');
        rememberStatusHeight(applyStatusHeight(bar.getBoundingClientRect().height));
        refitActive();
    };

    grip.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        dragging = true;
        startY = e.clientY;
        startH = bar.getBoundingClientRect().height;
        grip.classList.add('grip-active');
        document.documentElement.classList.add('resizing-status');
        e.preventDefault();
    });
    grip.addEventListener('dblclick', e => {
        e.preventDefault();
        rememberStatusHeight(applyStatusHeight(STATUS_DEFAULT));
        refitActive();
    });

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
}

function initStatusBar() {
    applyStatusHeight(statusHeight());
    installStatusResizer();
    // Shrinking the window must not leave a status bar taller than the space
    // there is for it. The stored preference is untouched, so growing the
    // window back restores it.
    window.addEventListener('resize', () => applyStatusHeight(statusHeight()));
}

module.exports = { updateStatusBar, initClock, initStatusBar, applyStatusHeight, statusHeight, maxStatus, STATUS_MIN, STATUS_MAX, STATUS_DEFAULT, TALL_AT };
