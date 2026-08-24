const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

app.setName('SSHell');
if (process.platform === 'win32') app.setAppUserModelId('com.sshell.app');

process.on('uncaughtException', err => console.error('[main] uncaughtException', err));
process.on('unhandledRejection', err => console.error('[main] unhandledRejection', err));

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const appIcon = nativeImage.createFromPath(ICON_PATH);
const isWin = process.platform === 'win32';

ipcMain.on('get-default-data-dir', (e) => {
    // Always the per-user application-data folder (…/AppData/Roaming/SSHell on
    // Windows), so the vault lives outside the install directory and a dev run
    // never writes session files into the source tree.
    try { e.returnValue = app.getPath('userData'); }
    catch (err) { e.returnValue = __dirname; }
});

// Never reject: an unhandled rejection in the renderer is a crash, and several
// callers await these without a catch.
ipcMain.handle('save-dialog', async (e, opts) => {
    try { return await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), opts || {}); }
    catch (err) { return { canceled: true, filePath: undefined, error: err.message }; }
});
ipcMain.handle('open-dialog', async (e, opts) => {
    try { return await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), opts || {}); }
    catch (err) { return { canceled: true, filePaths: [], error: err.message }; }
});

ipcMain.handle('set-titlebar-overlay', (e, opts) => {
    const w = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getFocusedWindow();
    if (w && typeof w.setTitleBarOverlay === 'function') {
        try { w.setTitleBarOverlay(opts); } catch (err) {}
    }
});

function createWindow() {
    const opts = {
        width: 1600,
        height: 900,
        minWidth: 940,
        minHeight: 560,
        icon: appIcon,
        backgroundColor: '#0b0e14',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            spellcheck: false,
            // The renderer can read the vault key directly, so a console in a
            // shipped build hands every credential to anyone at the keyboard.
            devTools: !app.isPackaged
        }
    };
    if (isWin) {
        opts.titleBarStyle = 'hidden';
        opts.titleBarOverlay = { color: '#0b0e14', symbolColor: '#e6edf3', height: 44 };
    }
    const win = new BrowserWindow(opts);
    win.removeMenu();

    win.webContents.on('render-process-gone', async (e, details) => {
        if (details.reason === 'clean-exit') return;
        const r = await dialog.showMessageBox(win, {
            type: 'error', buttons: ['Reload', 'Quit'], defaultId: 0, cancelId: 1,
            title: 'SSHell stopped responding',
            message: 'The window crashed (' + details.reason + ').',
            detail: 'Your saved sessions on disk are unaffected. Open tabs will be lost.'
        }).catch(() => ({ response: 0 }));
        if (r.response === 0) win.reload(); else win.destroy();
    });
    win.webContents.on('unresponsive', () => console.error('[main] renderer unresponsive'));

    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Allowing any file:// URL meant dropping a downloaded .html onto the window navigated this renderer to it — and the new page inherits…
    const appEntry = pathToFileURL(path.join(__dirname, 'index.html')).href;
    const allowNavigation = url => {
        try { return new URL(url).href === appEntry; } catch (e) { return false; }
    };
    win.webContents.on('will-navigate', (e, url) => {
        if (!allowNavigation(url)) { e.preventDefault(); console.error('[main] blocked navigation to', url); }
    });
    win.webContents.on('will-frame-navigate', e => {
        if (!allowNavigation(e.url)) e.preventDefault();
    });
    win.webContents.on('will-attach-webview', e => e.preventDefault());

    win.loadFile('index.html').catch(err => {
        console.error('[main] loadFile failed', err);
        dialog.showErrorBox('SSHell failed to start', String(err && err.message || err));
    });
}

// Each instance holds the whole store in memory and rewrites the entire vault on every save, so a second window silently overwrites the first one's…
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    });

    app.whenReady().then(() => {
        if (process.platform === 'darwin' && !appIcon.isEmpty()) {
            try { app.dock.setIcon(appIcon); } catch (e) {}
        }
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
