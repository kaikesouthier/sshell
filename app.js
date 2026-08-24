
const errors = require('./src/errors');
errors.install();

const RT = require('./src/runtime');
const config = require('./src/config');
const modal = require('./src/modal');
const dialog = require('./src/dialog');
const theme = require('./src/theme');
const statusbar = require('./src/statusbar');
const tabs = require('./src/tabs');
const grid = require('./src/grid');
const sidebar = require('./src/sidebar');
const editor = require('./src/editor');
const bulk = require('./src/bulk');
const sftp = require('./src/sftp');
const configpage = require('./src/configpage');
const iconpicker = require('./src/iconpicker');
const menu = require('./src/menu');
const lock = require('./src/lock');
const ctxmenu = require('./src/ctxmenu');
const shortcuts = require('./src/shortcuts');

function renderAll() {
    theme.applyFromConfig();
    config.save();
    sidebar.renderSidebar();
    menu.renderTabMenu();
    statusbar.updateStatusBar();
}

config.load();
theme.applyFromConfig();

modal.init();
dialog.init();
theme.init();
statusbar.initClock();
statusbar.initStatusBar();
tabs.init();
grid.init();
sidebar.init();
editor.init();
bulk.init();
sftp.init();
configpage.init();
iconpicker.init();
menu.init();
ctxmenu.init();
shortcuts.init();

const hidden = id => { const el = document.getElementById(id); return !el || el.classList.contains('hidden'); };

// A shortcut must not reach the app past a dialog, and lockScreen covers the
// window until the vault is open.
const OVERLAYS = ['lockScreen', 'msgModal', 'inputModal', 'themeModal', 'configModal', 'sessionModal', 'bulkModal', 'shortcutsModal'];
const activeTerminal = () => {
    const t = RT.tabs.find(x => x.id === RT.activeTabId);
    return t && t.type === 'terminal' && !t.closed ? t : null;
};

document.addEventListener('keydown', e => {
    if (!e.key) return;
    if (e.key === 'Escape') {
        if (!hidden('msgModal')) return;
        if (ctxmenu.isOpen()) { ctxmenu.close(); return; }
        if (iconpicker.isOpen()) { iconpicker.cancel(); return; }
        if (!hidden('inputModal')) { modal.cancel(); return; }
        if (!hidden('themeModal')) { document.getElementById('themeCancel').click(); return; }
        // Hiding the element directly skipped closeConfig(), leaving every
        // revealed password sitting in the DOM.
        if (!hidden('configModal')) { configpage.closeConfig(); return; }
        if (!hidden('sessionModal')) { editor.closeEditor(); return; }
        if (!hidden('bulkModal')) { bulk.closeBulk(); return; }
        if (shortcuts.isOpen()) { shortcuts.close(); return; }
        if (menu.isMenuOpen()) { menu.closeMenu(); return; }
        if (sidebar.hasSelection()) { sidebar.clearSelection(); return; }
        if (RT.sftpMode && sftp.clearFileSelection()) return;
    }
});

// Typing into a real form field should stay typing. The terminal's own textarea
// looks like a field but is not one for this purpose — it is the thing these
// shortcuts are meant to act on.
function typingInField() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.classList && el.classList.contains('xterm-helper-textarea')) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

// Capture, not bubble. xterm maps Ctrl+R, Ctrl+E, Ctrl+W and Ctrl+T to terminal
// input and calls stopPropagation() on them, so a listener on document never
// ran while a terminal had focus — the keystroke went to the shell instead.
document.addEventListener('keydown', e => {
    if (!e.key || !e.ctrlKey || e.altKey) return;
    if (OVERLAYS.some(id => !hidden(id))) return;
    if (typingInField()) return;

    // Claim the key outright so the terminal never also receives it.
    const take = () => { e.preventDefault(); e.stopPropagation(); };
    const k = e.key.toLowerCase();
    const plain = !e.shiftKey;

    if (plain && k === 'w' && RT.activeTabId) { take(); return tabs.closeTab(RT.activeTabId); }
    if (plain && k === 't') {
        take();
        const tm = document.getElementById('tabMenu');
        if (tm.classList.contains('hidden')) menu.showTabMenu(); else menu.hideTabMenu();
        return;
    }
    // Reconnect works on a healthy session too — it tears the connection down
    // and dials again, which is the quickest way out of a wedged shell.
    if (plain && k === 'r') {
        const t = activeTerminal();
        if (t) { take(); tabs.reconnectTab(t); }
        return;
    }
    if (plain && k === 'e') {
        const t = activeTerminal();
        if (t && t.configId) { take(); editor.openEditor(t.configId); }
        return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp') {
        const next = tabs.tabByOffset(e.key === 'PageDown' ? 1 : -1);
        if (next) { take(); tabs.setActiveTab(next.id); }
        return;
    }
    if (plain && e.key >= '1' && e.key <= '9') {
        const target = tabs.tabByNumber(Number(e.key));
        if (target) { take(); tabs.setActiveTab(target.id); }
    }
}, true);

sidebar.setSidebarView('sessions');
lock.bootWithGate(renderAll).catch(e => errors.reportFatal(e, 'startup'));
