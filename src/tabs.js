
const { clipboard } = require('electron');
const { Client } = require('ssh2');
const { $, escapeHtml, genId } = require('./util');
const RT = require('./runtime');
const S = require('./store');
const terminal = require('./terminal');
const statusbar = require('./statusbar');
const grid = require('./grid');
const sftp = require('./sftp');
const monitor = require('./monitor');
const errors = require('./errors');

function makeTabId() { return genId('tab'); }
function activeGrid() {
    const t = RT.tabs.find(t => t.id === RT.activeTabId && t.type === 'grid');
    return t ? t.grid : null;
}

function openTerminalTab(configId) {
    const cfg = S.getSession(configId);
    if (!cfg) return;
    const tab = {
        id: makeTabId(), type: 'terminal', configId,
        title: cfg.label || cfg.host, el: null, term: null, fitAddon: null,
        client: null, stream: null, connected: false, error: null,
        lastStats: { cpu: '--%', mem: '--', net: '↓-- ↑--' }
    };
    RT.tabs.push(tab);
    buildTerminalView(tab);
    renderTabBar();
    setActiveTab(tab.id);
    refreshSidebarBadges();
    connectTerminalTab(tab);
}

// Set while a batch of tabs is being closed, so the per-close grid remount and repaint happen once at the end instead of per tab.
let bulkClosing = false;

// Opening a folder of sessions fires one of these per tab, 120ms apart, and a full sidebar rebuild is not cheap on a large tree.
let badgeQueued = false;
function refreshSidebarBadges() {
    if (badgeQueued) return;
    badgeQueued = true;
    requestAnimationFrame(() => {
        badgeQueued = false;
        errors.attempt(() => require('./sidebar').renderSidebar(), 'sidebar refresh');
    });
}

function openGridTab() {
    const existing = RT.tabs.find(t => t.type === 'grid');
    if (existing) { setActiveTab(existing.id); return; }
    const tab = { id: makeTabId(), type: 'grid', title: 'Grid Dashboard', el: null };
    RT.tabs.push(tab);
    grid.buildGridView(tab);
    renderTabBar();
    setActiveTab(tab.id);
}

function openToolTab(toolType, title) {
    const tab = { id: makeTabId(), type: 'tool', toolType, title, el: null };
    RT.tabs.push(tab);
    require('./tools').buildToolView(tab);
    renderTabBar();
    setActiveTab(tab.id);
}

function setActiveTab(tabId) {
    RT.tabs.filter(t => t.type === 'grid' && t.grid).forEach(g => g.grid.unmount());

    RT.activeTabId = tabId;
    RT.tabs.forEach(t => { if (t.el) t.el.style.display = (t.id === tabId) ? 'block' : 'none'; });

    const active = RT.tabs.find(t => t.id === tabId);
    $('emptyState').style.display = RT.tabs.length ? 'none' : 'flex';
    const isGrid = !!(active && active.type === 'grid');
    $('gridToolbar').classList.toggle('hidden', !isGrid);
    $('gridToolbar').classList.toggle('flex', isGrid);

    renderTabBar();
    statusbar.updateStatusBar();

    if (active && active.type === 'terminal') {
        requestAnimationFrame(() => { fitTerminalTab(active); active.term && active.term.focus(); });
    } else if (isGrid && active.grid) {
        active.grid.mount();
    }
    monitor.setActive(RT.activeTabId);
    if (RT.sftpMode) sftp.sftpOnActiveChange();
}

function closeTab(tabId) {
    const idx = RT.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    const tab = RT.tabs[idx];
    tab.closed = true;

    if (tab.type === 'terminal') {
        grid.gridStopStats(tab);
        monitor.stop(tab);
        try { tab._ro && tab._ro.disconnect(); } catch (e) {}
        try { tab._shellDisp && tab._shellDisp.dispose(); } catch (e) {}
        try { tab._errDisp && tab._errDisp.dispose(); } catch (e) {}
        sftp.onTabClosed(tab);
        try { tab.sftp && tab.sftp.end(); } catch (e) {}
        killStream(tab.stream);
        try { tab.client && tab.client.end(); } catch (e) {}
        try { tab.term && tab.term.dispose(); } catch (e) {}
        tab.stream = null; tab.client = null; tab.sftp = null;
    } else if (tab.type === 'grid' && tab.grid) {
        try { tab.grid.destroy(); } catch (e) { errors.record('grid.destroy', e); }
    } else if (tab.type === 'tool' && tab.tool) {
        try { tab.tool.destroy(); } catch (e) { errors.record('tool.destroy', e); }
    }
    if (tab.el && tab.el.parentNode) tab.el.parentNode.removeChild(tab.el);
    RT.tabs.splice(idx, 1);

    if (RT.activeTabId === tabId) {
        const next = RT.tabs[idx] || RT.tabs[idx - 1] || null;
        RT.activeTabId = null;
        if (next) setActiveTab(next.id);
        else { $('emptyState').style.display = 'flex'; $('gridToolbar').classList.add('hidden'); statusbar.updateStatusBar(); if (RT.sftpMode) sftp.sftpOnActiveChange(); }
    } else if (!bulkClosing) {
        const activeGridTab = RT.tabs.find(t => t.id === RT.activeTabId && t.type === 'grid');
        if (activeGridTab && activeGridTab.grid) activeGridTab.grid.remount();
    }
    if (bulkClosing) return;
    renderTabBar();
    statusbar.updateStatusBar();
    if (tab.type === 'terminal') refreshSidebarBadges();
}

function renderTabBar() {
    const tabStrip = $('tabStrip');
    tabStrip.innerHTML = '';
    RT.tabs.forEach(tab => {
        const el = document.createElement('div');
        const isActive = tab.id === RT.activeTabId;
        el.className = 'tab group flex items-center gap-2 pl-3 pr-2 h-full border-r border-edge cursor-pointer select-none max-w-[220px] min-w-[130px] ' +
            (isActive ? 'active bg-panel2 text-txt' : 'bg-bg text-muted hover:bg-panel/70 hover:text-txt');
        let dot;
        if (tab.type === 'grid') {
            dot = `<svg class="w-3.5 h-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z"></path></svg>`;
        } else if (tab.type === 'tool') {
            dot = `<svg class="w-3.5 h-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4.5a2.5 2.5 0 013.5 3.5L6 16.5l-3 .5.5-3L11 4.5z"></path></svg>`;
        } else {
            const color = tab.error ? 'bg-bad' : (tab.connected ? 'bg-ok' : 'bg-warn animate-pulse');
            dot = `<span class="w-2 h-2 rounded-full shrink-0 ${color}"></span>`;
        }
        el.innerHTML = `${dot}
            <span class="truncate flex-grow text-xs font-medium">${escapeHtml(tab.title)}</span>
            <button class="tab-close shrink-0 w-5 h-5 rounded flex items-center justify-center text-faint hover:text-txt hover:bg-edge2 transition-colors">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>`;
        el.addEventListener('mousedown', e => {
            if (e.button === 1) { e.preventDefault(); closeTab(tab.id); return; }
            if (e.target.closest('.tab-close')) return;
            setActiveTab(tab.id);
        });
        el.querySelector('.tab-close').addEventListener('click', e => { e.stopPropagation(); closeTab(tab.id); });
        el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); showTabContextMenu(e, tab); });

        el.draggable = true;
        el.addEventListener('dragstart', e => { RT.dragTabId = tab.id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', tab.id); } catch (_) {} });
        el.addEventListener('dragend', () => { RT.dragTabId = null; el.classList.remove('dragging'); clearTabMarks(); });
        el.addEventListener('dragover', e => { if (!RT.dragTabId || RT.dragTabId === tab.id) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; clearTabMarks(); el.classList.add('tab-drop'); });
        el.addEventListener('dragleave', () => el.classList.remove('tab-drop'));
        el.addEventListener('drop', e => { if (!RT.dragTabId) return; e.preventDefault(); e.stopPropagation(); el.classList.remove('tab-drop'); moveTab(RT.dragTabId, tab.id); });

        tabStrip.appendChild(el);
    });
    // Connection state just changed for at least one tab; the grid draws the
    // same dots and has no other trigger to repaint them.
    errors.attempt(() => grid.refreshActiveGridStatus(), 'grid status');
}
function showTabContextMenu(e, tab) {
    const ctxmenu = require('./ctxmenu');
    const I = ctxmenu.ICONS;
    const idx = RT.tabs.findIndex(t => t.id === tab.id);
    const others = RT.tabs.length - 1;
    const toRight = Math.max(0, RT.tabs.length - idx - 1);
    const items = [];

    if (tab.type === 'terminal') {
        const cfg = S.getSession(tab.configId);
        items.push({
            label: tab.connected ? 'Reconnect' : 'Connect',
            sublabel: tab.connected ? 'drops session' : '',
            icon: I.refresh,
            act: () => reconnectTab(tab)
        });
        items.push({ label: 'Edit session…', icon: I.edit, disabled: !cfg, act: () => editAndReconnect(tab) });
        items.push({ label: 'Duplicate tab', icon: I.plus, disabled: !cfg, act: () => openTerminalTab(tab.configId) });
        items.push({ label: 'Reset terminal', sublabel: 'Ctrl+Shift+R', icon: I.refresh, disabled: !tab.term, act: () => resetTerminal(tab) });
        items.push({ sep: true });
    }

    items.push({ label: 'Close', sublabel: 'Ctrl+W', icon: I.x, act: () => closeTab(tab.id) });
    items.push({ label: 'Close others', sublabel: others ? String(others) : '', icon: I.x, disabled: !others, act: () => closeOthers(tab.id) });
    items.push({ label: 'Close to the right', sublabel: toRight ? String(toRight) : '', icon: I.x, disabled: !toRight, act: () => closeToRight(tab.id) });

    ctxmenu.open(e.clientX, e.clientY, items, { title: tab.title });
}

// Dumping a binary to the terminal (a stray `cat` of an image, say) can switch
// the emulator into the DEC line-drawing charset or leave stray SGR state, so
// every following line renders as garbage. A full reset restores it without
// dropping the SSH connection. A trailing Ctrl-L nudges most shells to redraw
// their prompt so the screen is not left blank.
function resetTerminal(tab) {
    if (!tab || !tab.term) return;
    errors.attempt(() => {
        tab.term.reset();
        tab.term.write('\x1b[!p\x1b(B\x0f');
        if (tab.stream && tab.connected) writeInput(tab, '\x0c');
        fitTerminalTab(tab);
    }, 'reset terminal');
}

// Reconnect from the menu has to work on a live session too, which the r-key
// retry prompt never had to handle — that only appears once a session is dead.
// Ctrl+PageUp/PageDown and Ctrl+1..9 both walk the visible tab order.
function openTabs() { return RT.tabs.filter(t => !t.closed); }

function tabByOffset(step) {
    const list = openTabs();
    if (list.length < 2) return null;
    const i = list.findIndex(t => t.id === RT.activeTabId);
    const from = i < 0 ? 0 : i;
    return list[((from + step) % list.length + list.length) % list.length];
}

// 9 means "the last one" however many there are, as browsers and terminals do.
function tabByNumber(n) {
    const list = openTabs();
    if (!list.length || !(n >= 1 && n <= 9)) return null;
    return n === 9 ? list[list.length - 1] : (list[n - 1] || null);
}

// More unsent keystrokes than a person could plausibly have typed on purpose.
const INPUT_STALL_BYTES = 4096;

// Node buffers writes indefinitely when a socket stops draining. A stalled
// session therefore swallowed everything typed during the hang and replayed it
// the instant it recovered — commands aimed at a prompt that no longer existed,
// run in whatever directory the shell had moved to. Dropping is the safe
// failure: the user sees nothing happen and retypes.
function writeInput(tab, data) {
    const s = tab.stream;
    if (!s || s.destroyed || s.writableEnded) return;

    if (s.writableLength > INPUT_STALL_BYTES) {
        if (!tab._inputStalled) {
            tab._inputStalled = true;
            s.once('drain', () => {
                tab._inputStalled = false;
                if (!tab._inputWarned) return;
                tab._inputWarned = false;
                errors.attempt(() => tab.term.writeln(
                    '\r\n\x1b[38;5;244m  Input is being accepted again.\x1b[0m'), 'input resumed');
            });
        }
        if (!tab._inputWarned) {
            tab._inputWarned = true;
            errors.attempt(() => tab.term.writeln(
                '\r\n\x1b[38;5;214m  This session has stopped accepting input. Keystrokes are being ' +
                'discarded rather than queued, so nothing you type now will run later.\x1b[0m'), 'input stalled');
        }
        return;
    }
    errors.safeWrite(s, data);
}

// end() flushes what is still queued before closing, which is exactly the
// replay above. Anything being torn down should discard instead.
function killStream(s) {
    if (!s) return;
    try { s.removeAllListeners('drain'); } catch (e) {}
    try { s.destroy(); } catch (e) {}
}

function reconnectTab(tab) {
    if (tab.closed) return;
    clearErrorPrompt(tab);
    killStream(tab.stream);
    try { tab.client && tab.client.end(); } catch (e) {}
    tab.stream = null; tab.client = null; tab.sftp = null;
    tab.connected = false; tab._connecting = false;
    monitor.stop(tab);
    grid.gridStopStats(tab);
    renderTabBar(); statusbar.updateStatusBar();
    errors.attempt(() => tab.term.writeln('\r\n\x1b[38;5;244mReconnecting…\x1b[0m'), 'reconnect');
    connectTerminalTab(tab);
}

// Closing tabs one by one remounts the grid after each, and every remount synchronously fires a stats exec for each surviving tab — closing 19 tabs…
function closeMany(ids) {
    if (!ids.length) return;
    bulkClosing = true;
    try { ids.forEach(closeTab); }
    finally { bulkClosing = false; }

    const activeGridTab = RT.tabs.find(t => t.id === RT.activeTabId && t.type === 'grid');
    if (activeGridTab && activeGridTab.grid) errors.attempt(() => activeGridTab.grid.remount(), 'grid remount');
    renderTabBar();
    statusbar.updateStatusBar();
    refreshSidebarBadges();
}

function closeOthers(keepId) {
    closeMany(RT.tabs.filter(t => t.id !== keepId).map(t => t.id));
}
function closeToRight(fromId) {
    const idx = RT.tabs.findIndex(t => t.id === fromId);
    if (idx < 0) return;
    closeMany(RT.tabs.slice(idx + 1).map(t => t.id));
}

function clearTabMarks() { document.querySelectorAll('.tab-drop').forEach(x => x.classList.remove('tab-drop')); }
function moveTab(dragId, beforeId) {
    if (dragId === beforeId) return;
    const arr = RT.tabs;
    const from = arr.findIndex(t => t.id === dragId);
    if (from < 0) return;
    const [t] = arr.splice(from, 1);
    const to = arr.findIndex(x => x.id === beforeId);
    arr.splice(to < 0 ? arr.length : to, 0, t);
    renderTabBar();
}

const FONT_MIN = 8, FONT_MAX = 40, FONT_DEFAULT = 13;

function termFontSize() {
    const n = Number(require('./config').data.termFontSize);
    return n >= FONT_MIN && n <= FONT_MAX ? Math.round(n) : FONT_DEFAULT;
}

let fontSaveTimer = null;
// Resizes one terminal only — the one under the cursor — so a grid can mix
// sizes. The size it lands on becomes the default for terminals opened later,
// and survives restarts.
function setTermFontSize(tab, px) {
    if (!tab || !tab.term) return termFontSize();
    const cur = Number(tab.term.options.fontSize) || termFontSize();
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(px)));
    if (next === cur) return next;
    errors.attempt(() => { tab.term.options.fontSize = next; }, 'font size');
    // xterm re-measures the glyphs on the option change; fit after that lands.
    // A pane inside a grid is fit by the grid itself (see its wheel handler).
    requestAnimationFrame(() => { if (tab.id === RT.activeTabId) fitTerminalTab(tab); });
    const config = require('./config');
    config.data.termFontSize = next;
    clearTimeout(fontSaveTimer);
    fontSaveTimer = setTimeout(() => { fontSaveTimer = null; errors.attempt(() => config.save(), 'font size save'); }, 500);
    return next;
}

function buildTerminalView(tab) {
    const el = document.createElement('div');
    el.className = 'term-view'; el.style.display = 'none';
    $('views').appendChild(el);
    tab.el = el;

    const term = terminal.newTerminal(termFontSize());
    const fitAddon = new terminal.FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    tab.term = term; tab.fitAddon = fitAddon;

    // Ctrl+wheel (and a trackpad pinch, which Chromium reports the same way)
    // resizes the text. Capture phase, so xterm's own wheel handler never also
    // scrolls the buffer, and preventDefault keeps Chromium from zooming the
    // whole window instead.
    el.addEventListener('wheel', e => {
        if (!e.ctrlKey || e.altKey) return;
        e.preventDefault(); e.stopPropagation();
        if (!e.deltaY) return;
        setTermFontSize(tab, (Number(term.options.fontSize) || termFontSize()) + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false, capture: true });

    term.element.addEventListener('contextmenu', e => {
        e.preventDefault();
        const t = clipboard.readText();
        if (t && tab.stream) tab.stream.write(t);
    });

    const ro = new ResizeObserver(() => { if (tab.id === RT.activeTabId) requestAnimationFrame(() => fitTerminalTab(tab)); });
    ro.observe(el);
    tab._ro = ro;
}

function fitTerminalTab(tab) {
    if (!tab.fitAddon || !tab.term || !tab.el || !tab.el.clientWidth) return;
    try {
        tab.fitAddon.fit();
        if (tab.stream && typeof tab.stream.setWindow === 'function') tab.stream.setWindow(tab.term.rows, tab.term.cols, 0, 0);
    } catch (e) {}
}

function clearErrorPrompt(tab) {
    if (tab._errDisp) { try { tab._errDisp.dispose(); } catch (e) {} tab._errDisp = null; }
}
function showErrorPrompt(tab) {
    if (tab._errDisp) return;
    const term = tab.term;
    term.writeln('');
    term.writeln('\x1b[38;5;250m  \x1b[1;36mr\x1b[0;38;5;250m retry   \x1b[1;36me\x1b[0;38;5;250m edit session   \x1b[1;36mEnter\x1b[0;38;5;250m close tab\x1b[0m');
    tab._errDisp = term.onData(d => {
        if (d === 'r' || d === 'R') retryTab(tab);
        else if (d === 'e' || d === 'E') editAndReconnect(tab);
        else if (d === '\r' || d === '\n') closeTab(tab.id);
    });
}
function retryTab(tab) {
    if (tab.closed) return;
    clearErrorPrompt(tab);
    killStream(tab.stream);
    try { tab.client && tab.client.end(); } catch (e) {}
    tab.stream = null; tab.client = null; tab.sftp = null;
    tab._connecting = false;
    tab.term.writeln('\r\n\x1b[38;5;244mRetrying…\x1b[0m');
    connectTerminalTab(tab);
}
function editAndReconnect(tab) {

    require('./editor').openEditor(tab.configId, null, () => retryTab(tab));
}

const OS_CMD = "if command -v pveversion >/dev/null 2>&1; then echo PVE; pveversion 2>/dev/null | head -n1; elif command -v proxmox-backup-manager >/dev/null 2>&1; then echo 'Proxmox Backup Server'; elif [ -r /etc/os-release ]; then . /etc/os-release 2>/dev/null; echo \"$PRETTY_NAME\"; else uname -sr 2>/dev/null || echo Unknown; fi";
function formatOS(raw) {
    const lines = (raw || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    if (lines[0] === 'PVE') { const m = (lines[1] || '').match(/pve-manager\/([\d.]+)/); return 'Proxmox VE' + (m ? ' ' + m[1] : ''); }
    return lines[0].slice(0, 48);
}
function detectSessionOS(tab, conn) {
    try {
        conn.exec(OS_CMD, (err, stream) => {
            if (err) return;
            errors.guardStream(stream, 'detectSessionOS');
            let buf = '';
            stream.on('data', d => { buf += d.toString(); });
            stream.stderr.on('data', () => {});
            stream.on('close', () => {
                try {
                    const os = formatOS(buf);
                    const cfg = S.getSession(tab.configId);
                    if (os && cfg && cfg.os !== os) { cfg.os = os; S.persist(); require('./sidebar').renderSidebar(); }
                } catch (e) { errors.record('detectSessionOS', e); }
            });
        });
    } catch (e) { errors.record('detectSessionOS', e); }
}

function connectTerminalTab(tab) {
    if (tab.closed || tab._connecting) return;
    const cfg = S.getSession(tab.configId);
    const term = tab.term;
    clearErrorPrompt(tab);
    if (!cfg) { term.writeln('\r\n\x1b[31mThis session no longer exists.\x1b[0m'); return; }
    tab.error = null;
    tab._connecting = true;
    term.writeln('\x1b[38;5;244mConnecting to ' + (cfg.host || '?') + '…\x1b[0m');

    let config;
    try {
        config = terminal.buildConnectConfig(cfg);
    } catch (e) {
        tab._connecting = false;
        tab.error = e.message;
        term.writeln('\r\n\x1b[31m' + e.message + '\x1b[0m');
        showErrorPrompt(tab);
        renderTabBar(); statusbar.updateStatusBar();
        return;
    }

    const conn = new Client();
    tab.client = conn;

    // A tab can be closed or retried while an old connection is still settling;
    // late events from a superseded client must not touch the live tab.
    const isCurrent = () => !tab.closed && tab.client === conn;

    conn.on('ready', () => {
        if (!isCurrent()) { try { conn.end(); } catch (e) {} return; }
        tab._connecting = false;
        tab.connected = true; tab.error = null;
        clearErrorPrompt(tab);
        renderTabBar(); statusbar.updateStatusBar();
        conn.shell({ term: 'xterm-256color' }, (err, stream) => {
            if (!isCurrent()) { killStream(stream); return; }
            if (err) {
                tab.error = err.message;
                term.writeln('\r\n\x1b[31mShell error: ' + err.message + '\x1b[0m');
                showErrorPrompt(tab); renderTabBar(); statusbar.updateStatusBar();
                return;
            }
            tab.stream = stream;
            fitTerminalTab(tab);

            stream.on('error', e => {
                errors.record('shell', e, cfg.host);
                if (!isCurrent()) return;
                tab.error = e.message;
                term.writeln('\r\n\x1b[31mShell stream error: ' + e.message + '\x1b[0m');
                renderTabBar(); statusbar.updateStatusBar();
            });
            if (stream.stderr) {
                stream.stderr.on('error', e => errors.record('shell.stderr', e, cfg.host));
                stream.stderr.on('data', d => errors.attempt(() => term.write(d), 'shell stderr'));
            }
            stream.on('data', d => {
                try { stream.pause(); term.write(d, () => errors.attempt(() => stream.resume(), 'resume')); }
                catch (e) { errors.record('term.write', e); }
            });
            stream.on('close', () => {
                if (!isCurrent()) return;
                tab.connected = false; tab.stream = null;
                term.writeln('\r\n\x1b[38;5;244m[session closed]\x1b[0m');
                showErrorPrompt(tab);
                renderTabBar(); statusbar.updateStatusBar();
                try { conn.end(); } catch (e) {}
            });

            if (tab._shellDisp) { try { tab._shellDisp.dispose(); } catch (e) {} }
            // A fresh channel starts unstalled, whatever the previous one did.
            tab._inputStalled = false;
            tab._inputWarned = false;
            tab._shellDisp = term.onData(d => writeInput(tab, d));
        });
        const g = activeGrid();
        if (g && g.isMounted()) g.startStatsFor(tab.id);
        if (tab.id === RT.activeTabId) monitor.setActive(RT.activeTabId);
        if (RT.sftpMode && tab.id === RT.activeTabId) sftp.sftpOnActiveChange();
        detectSessionOS(tab, conn);
    });

    conn.on('error', err => {
        errors.record('ssh', err, cfg.host);
        if (!isCurrent()) return;
        tab._connecting = false;
        tab.connected = false; tab.error = err.message; tab.sftp = null;
        monitor.stop(tab);
        term.writeln('\r\n\x1b[31mConnection error: ' + errors.describe(err).replace(/\n/g, '\r\n') + '\x1b[0m');
        showErrorPrompt(tab);
        renderTabBar(); statusbar.updateStatusBar();
        if (RT.sftpMode && sftp.targetsTab(tab.id)) sftp.sftpOnActiveChange();
    });

    conn.on('timeout', () => {
        if (!isCurrent()) return;
        errors.record('ssh', new Error('timeout'), cfg.host);
        try { conn.end(); } catch (e) {}
    });

    conn.on('close', () => {
        if (!isCurrent()) return;
        tab._connecting = false;
        tab.sftp = null;
        monitor.stop(tab);
        if (!tab.connected) return;
        tab.connected = false; renderTabBar(); statusbar.updateStatusBar();
        if (RT.sftpMode && sftp.targetsTab(tab.id)) sftp.sftpOnActiveChange();
    });

    try { conn.connect(config); }
    catch (e) {
        tab._connecting = false;
        tab.error = e.message;
        term.writeln('\r\n\x1b[31mConfig error: ' + e.message + '\x1b[0m');
        showErrorPrompt(tab);
        renderTabBar(); statusbar.updateStatusBar();
    }
}

function init() {
    window.addEventListener('resize', () => {
        const active = RT.tabs.find(t => t.id === RT.activeTabId);
        if (active && active.type === 'terminal') fitTerminalTab(active);
        else if (active && active.type === 'grid' && active.grid) active.grid.refit();
    });

    const strip = $('tabStrip');
    strip.addEventListener('wheel', e => {
        if (!e.deltaY) return;
        strip.scrollLeft += e.deltaY;
        e.preventDefault();
    }, { passive: false });
}

module.exports = {
    openTerminalTab, openGridTab, openToolTab, setActiveTab, closeTab, renderTabBar,
    buildTerminalView, fitTerminalTab, connectTerminalTab, reconnectTab, resetTerminal, activeGrid, tabByOffset, tabByNumber, openTabs, init,
    termFontSize, setTermFontSize
};
