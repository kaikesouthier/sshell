// Covers the resizable status bar in src/statusbar.js, plus the title-bar drag
// regions in views/topbar.html.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src/statusbar.js'), 'utf8');

const grab = n => {
    let i = src.indexOf('function ' + n + '(');
    if (i < 0) return '';
    let d = 0;
    for (let k = src.indexOf('{', i); k < src.length; k++) {
        if (src[k] === '{') d++;
        else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
    }
    return '';
};

const consts = 'const STATUS_MIN = 24, STATUS_MAX = 260, STATUS_DEFAULT = 32;\nconst CHROME_MIN = 260;\nconst TALL_AT = 46;\nlet heightSaveTimer = null;\n';
const body = consts + ['maxStatus', 'statusHeight', 'applyStatusHeight', 'rememberStatusHeight'].map(grab).join('\n');

// Minimal stand-ins for the two DOM surfaces the resizer touches.
let cssVars = {}, classes = new Set(), saved = 0;
const config = { data: {}, save: () => { saved++; return true; } };
const documentStub = {
    documentElement: {
        style: { setProperty: (k, v) => { cssVars[k] = v; } },
        classList: {
            toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); },
            contains: c => classes.has(c)
        }
    }
};
const req = m => (m === './config' ? config : m === './errors' ? { attempt: f => f() } : {});

const windowStub = { innerHeight: 900 };
const H = new Function('document', 'window', 'require', 'setTimeout', 'clearTimeout',
    body + ';return { maxStatus, statusHeight, applyStatusHeight, rememberStatusHeight };')(
    documentStub, windowStub, req, f => { f(); return 0; }, () => {});

const reset = () => { cssVars = {}; classes = new Set(); saved = 0; config.data = {}; windowStub.innerHeight = 900; };
const px = () => parseInt(cssVars['--status-h'], 10);
const tall = () => classes.has('status-tall');

let pass = 0, fail = 0;
const t = (n, c) => {
    try {
        const r = c();
        if (r === true) { pass++; console.log('  ok   ' + n); }
        else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
    } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

// --- stored height ---

t('an unset height falls back to the default', () => { reset(); return H.statusHeight() === 32; });
t('a stored height is used', () => { reset(); config.data.statusBarHeight = 120; return H.statusHeight() === 120; });
t('a height below the minimum is ignored', () => { reset(); config.data.statusBarHeight = 4; return H.statusHeight() === 32; });
t('a height above the maximum is ignored', () => { reset(); config.data.statusBarHeight = 5000; return H.statusHeight() === 32; });
t('a corrupt height is ignored', () => {
    reset();
    const bad = [null, undefined, 'tall', NaN, Infinity, -1, {}, []];
    return bad.every(v => { config.data.statusBarHeight = v; return H.statusHeight() === 32; });
});
t('a fractional stored height is rounded', () => { reset(); config.data.statusBarHeight = 99.6; return H.statusHeight() === 100; });

// --- clamping ---

t('applying sets the CSS variable in pixels', () => { reset(); H.applyStatusHeight(80); return cssVars['--status-h'] === '80px'; });
t('dragging past the top clamps to the maximum', () => { reset(); H.applyStatusHeight(9999); return px() === 260; });
t('dragging past the bottom clamps to the minimum', () => { reset(); H.applyStatusHeight(-500); return px() === 24; });
t('applying returns the clamped value it used', () => {
    reset();
    return H.applyStatusHeight(9999) === 260 && H.applyStatusHeight(0) === 24 && H.applyStatusHeight(64) === 64;
});
t('a fractional drag position is rounded', () => { reset(); H.applyStatusHeight(77.4); return px() === 77; });

// --- wrapping threshold ---
// Below the threshold a second row cannot fit, so wrapping would only clip.

t('a one-row bar does not wrap', () => { reset(); H.applyStatusHeight(32); return tall() === false; });
t('a tall bar wraps', () => { reset(); H.applyStatusHeight(120); return tall() === true; });
t('the threshold is inclusive', () => { reset(); H.applyStatusHeight(46); return tall() === true; });
t('one pixel under the threshold does not wrap', () => { reset(); H.applyStatusHeight(45); return tall() === false; });
t('shrinking back turns wrapping off again', () => {
    reset();
    H.applyStatusHeight(200);
    if (!tall()) return 'did not become tall';
    H.applyStatusHeight(30);
    return tall() === false;
});
t('the minimum height never wraps', () => { reset(); H.applyStatusHeight(-500); return tall() === false; });

// --- persistence ---

t('a resize is written to config', () => { reset(); H.rememberStatusHeight(140); return config.data.statusBarHeight === 140 && saved === 1; });
t('a stored height survives a round trip', () => {
    reset();
    H.rememberStatusHeight(H.applyStatusHeight(180));
    return H.statusHeight() === 180;
});
t('a clamped resize stores the clamped value, not the raw drag', () => {
    reset();
    H.rememberStatusHeight(H.applyStatusHeight(9999));
    return config.data.statusBarHeight === 260 && H.statusHeight() === 260;
});
t('resetting stores the default', () => {
    reset();
    H.rememberStatusHeight(H.applyStatusHeight(200));
    H.rememberStatusHeight(H.applyStatusHeight(32));
    return config.data.statusBarHeight === 32 && H.statusHeight() === 32;
});

// --- fitting the window ---
// The window can be as short as 560px. A bar sized on a tall window must not
// come back and eat a short one.

t('a tall window allows the full range', () => { reset(); return H.maxStatus() === 260; });
t('the shortest allowed window still allows the full range', () => {
    reset(); windowStub.innerHeight = 560;   // main.js minHeight
    return H.maxStatus() === 260;
});
t('a window shorter than the app allows still caps sensibly', () => {
    reset(); windowStub.innerHeight = 400;   // 400 - 260 of chrome
    return H.maxStatus() === 140;
});
t('the cap never drops below the minimum height', () => {
    reset(); windowStub.innerHeight = 100;
    return H.maxStatus() === 24;
});
t('dragging cannot exceed what the window allows', () => {
    reset(); windowStub.innerHeight = 400;
    return H.applyStatusHeight(9999) === 140 && px() === 140;
});
t('a stored height too tall for this window is clamped on apply', () => {
    reset();
    config.data.statusBarHeight = 240;
    windowStub.innerHeight = 400;               // only 140px to spare
    return H.applyStatusHeight(H.statusHeight()) === 140;
});
t('the stored preference is not rewritten by the clamp', () => {
    reset();
    config.data.statusBarHeight = 240;
    windowStub.innerHeight = 400;
    H.applyStatusHeight(H.statusHeight());
    return config.data.statusBarHeight === 240;
});
t('growing the window restores the stored height', () => {
    reset();
    config.data.statusBarHeight = 240;
    windowStub.innerHeight = 400;
    H.applyStatusHeight(H.statusHeight());
    if (px() !== 140) return 'not clamped first';
    windowStub.innerHeight = 900;
    H.applyStatusHeight(H.statusHeight());
    return px() === 240;
});

// --- wiring ---

t('the status bar is initialised at boot', () => {
    const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    return /statusbar\.initStatusBar\(\)/.test(app);
});
t('the bar carries the id and positioning the grip needs', () => {
    const html = fs.readFileSync(path.join(ROOT, 'views/content.html'), 'utf8');
    const m = /<div id="statusBar"([^>]*)>/.exec(html);
    return !!m && /\brelative\b/.test(m[1]) && /\bshrink-0\b/.test(m[1]) && !/\bh-8\b/.test(m[1]);
});
t('the height comes from the variable, not a fixed class', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    return /#statusBar\s*\{[^}]*height:\s*var\(--status-h/.test(css) && /\.status-grip\s*\{/.test(css);
});
t('resizing the bar refits the terminal underneath it', () =>
    /function refitActive/.test(src) && /fitTerminalTab/.test(src) && /refit\(\)/.test(src));

// --- sidebar width against the window ---
// The window can be as narrow as 940px while the sidebar maximum is 900, which
// left about forty pixels of terminal.

const sbSrc = fs.readFileSync(path.join(ROOT, 'src/sidebar.js'), 'utf8');
const sbGrab = n => {
    let i = sbSrc.indexOf('function ' + n + '(');
    if (i < 0) return '';
    let d = 0;
    for (let k = sbSrc.indexOf('{', i); k < sbSrc.length; k++) {
        if (sbSrc[k] === '{') d++;
        else if (sbSrc[k] === '}') { d--; if (!d) return sbSrc.slice(i, k + 1); }
    }
    return '';
};
const sbBody = 'const SIDEBAR_MIN = 190, SIDEBAR_MAX = 900;\nconst CONTENT_MIN = 420;\nconst DEFAULT_W = { sessions: 256, sftp: 460 };\n'
    + ['maxSidebar', 'sidebarWidthFor', 'applySidebarWidth'].map(sbGrab).join('\n');

const sbWindow = { innerWidth: 1600 };
const SB = new Function('document', 'window', 'require',
    sbBody + ';return { maxSidebar, sidebarWidthFor, applySidebarWidth };')(documentStub, sbWindow, req);

const sbPx = () => parseInt(cssVars['--sidebar-w'], 10);

t('a wide window allows the full sidebar range', () => { reset(); sbWindow.innerWidth = 1600; return SB.maxSidebar() === 900; });
t('the narrowest allowed window leaves room for the terminal', () => {
    reset(); sbWindow.innerWidth = 940;      // main.js minWidth
    return SB.maxSidebar() === 520;
});
t('the sidebar cap never drops below its minimum', () => {
    reset(); sbWindow.innerWidth = 300;
    return SB.maxSidebar() === 190;
});
t('a width saved on a wide monitor is clamped on a narrow window', () => {
    reset();
    config.data.sidebarWidth = { sessions: 900 };
    sbWindow.innerWidth = 940;
    SB.applySidebarWidth('sessions');
    return sbPx() === 520;
});
t('the saved sidebar width is not rewritten by the clamp', () => {
    reset();
    config.data.sidebarWidth = { sessions: 900 };
    sbWindow.innerWidth = 940;
    SB.applySidebarWidth('sessions');
    return config.data.sidebarWidth.sessions === 900;
});
t('widening the window restores the saved sidebar width', () => {
    reset();
    config.data.sidebarWidth = { sessions: 900 };
    sbWindow.innerWidth = 940;
    SB.applySidebarWidth('sessions');
    sbWindow.innerWidth = 1600;
    SB.applySidebarWidth('sessions');
    return sbPx() === 900;
});
t('each view keeps its own width', () => {
    reset();
    config.data.sidebarWidth = { sessions: 300, sftp: 700 };
    SB.applySidebarWidth('sessions');
    const a = sbPx();
    SB.applySidebarWidth('sftp');
    return a === 300 && sbPx() === 700;
});
t('an unset width falls back to the per-view default', () => {
    reset();
    SB.applySidebarWidth('sessions');
    const a = sbPx();
    SB.applySidebarWidth('sftp');
    return a === 256 && sbPx() === 460;
});
t('the sidebar re-clamps when the window is resized', () =>
    /addEventListener\('resize', \(\) => applySidebarWidth/.test(sbSrc));

// --- title-bar drag regions ---
// tabStrip was no-drag AND flex-grow, so it owned every spare pixel of the
// title bar and the window could only be moved by the menu area.

const topbar = fs.readFileSync(path.join(ROOT, 'views/topbar.html'), 'utf8');

t('the tab strip no longer claims the whole title bar', () => {
    const m = /<div id="tabStrip"([^>]*)>/.exec(topbar);
    return !!m && !/\bflex-grow\b/.test(m[1]);
});
t('the tab strip is still interactive', () => {
    const m = /<div id="tabStrip"([^>]*)>/.exec(topbar);
    return !!m && /\bno-drag\b/.test(m[1]);
});
t('the tab strip can still shrink and scroll when tabs overflow', () => {
    const m = /<div id="tabStrip"([^>]*)>/.exec(topbar);
    return !!m && /\bmin-w-0\b/.test(m[1]) && /\boverflow-x-auto\b/.test(m[1]);
});
t('a draggable filler takes the space beside the tabs', () => {
    const after = topbar.slice(topbar.indexOf('id="tabStrip"'));
    return /<div class="drag flex-grow[^"]*"><\/div>/.test(after);
});
t('tabs themselves stay clickable inside a drag region', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    return /\.tab\s*\{\s*-webkit-app-region:\s*no-drag/.test(css);
});
t('non-Windows builds still neutralise the drag regions', () => {
    const css = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');
    return /html\.is-other \.drag\s*\{\s*-webkit-app-region:\s*no-drag/.test(css);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
