// Renders assets/logo.svg into the raster icons the app and installers need:
//   assets/icon.png  (512x512, used by the Linux build and the window icon)
//   assets/icon.ico  (multi-size, used by the Windows build and installer)
//
//   npm run make-icons
//
// Rendering is done by Electron itself (a hidden transparent window capturing
// the SVG), so there is no native image dependency to install.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const SVG = path.join(ASSETS, 'logo.svg');
const PNG_OUT = path.join(ASSETS, 'icon.png');
const ICO_OUT = path.join(ASSETS, 'icon.ico');

const PNG_SIZE = 512;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// Render once at a comfortably large size, then downscale for every target.
// Tiny (16px) BrowserWindows get clamped by the OS on Windows, so a single
// big render plus nativeImage downscales is both robust and higher quality.
const MASTER = 1024;

function renderMaster(svg) {
    return new Promise((resolve, reject) => {
        const win = new BrowserWindow({
            width: MASTER,
            height: MASTER,
            useContentSize: true,
            show: false,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            webPreferences: { offscreen: false }
        });
        const html = '<!doctype html><meta charset="utf-8">'
            + '<style>html,body{margin:0;padding:0;background:transparent}'
            + 'svg{display:block;width:' + MASTER + 'px;height:' + MASTER + 'px}</style>'
            + svg;
        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        win.webContents.once('did-finish-load', () => {
            setTimeout(() => {
                win.webContents.capturePage().then(img => {
                    win.destroy();
                    resolve(img);
                }).catch(err => { win.destroy(); reject(err); });
            }, 150);
        });
    });
}

const pngAt = (master, size) => master.resize({ width: size, height: size, quality: 'best' }).toPNG();

// Assemble a .ico from a set of PNG frames (Vista+ PNG-compressed icon format).
function buildIco(frames) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(frames.length, 4);

    const dir = Buffer.alloc(16 * frames.length);
    let offset = 6 + 16 * frames.length;
    const datas = [];
    frames.forEach((f, i) => {
        const e = i * 16;
        dir.writeUInt8(f.size >= 256 ? 0 : f.size, e + 0);
        dir.writeUInt8(f.size >= 256 ? 0 : f.size, e + 1);
        dir.writeUInt8(0, e + 2);
        dir.writeUInt8(0, e + 3);
        dir.writeUInt16LE(1, e + 4);
        dir.writeUInt16LE(32, e + 6);
        dir.writeUInt32LE(f.png.length, e + 8);
        dir.writeUInt32LE(offset, e + 12);
        offset += f.png.length;
        datas.push(f.png);
    });
    return Buffer.concat([header, dir, ...datas]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    try {
        const svg = fs.readFileSync(SVG, 'utf8');
        const master = await renderMaster(svg);
        if (master.isEmpty()) throw new Error('the SVG rendered to an empty image');

        fs.writeFileSync(PNG_OUT, pngAt(master, PNG_SIZE));
        console.log('wrote ' + path.relative(process.cwd(), PNG_OUT) + ' (' + PNG_SIZE + 'x' + PNG_SIZE + ')');

        const frames = ICO_SIZES.map(size => ({ size, png: pngAt(master, size) }));
        fs.writeFileSync(ICO_OUT, buildIco(frames));
        console.log('wrote ' + path.relative(process.cwd(), ICO_OUT) + ' (' + ICO_SIZES.join(', ') + ')');

        app.exit(0);
    } catch (err) {
        console.error('icon generation failed:', err);
        app.exit(1);
    }
});
