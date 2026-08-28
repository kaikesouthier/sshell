
const { clipboard } = require('electron');
const { $, escapeHtml, humanBytes } = require('./util');
const RT = require('./runtime');

const GRID_SAMPLE_CMD = "echo K_MEM; grep -E 'MemTotal|MemAvailable' /proc/meminfo; echo K_CPU; grep '^cpu ' /proc/stat; echo K_NET; cat /proc/net/dev";

function tabsMod() { return require('./tabs'); }

const WRAP_BASE = 'bg-black h-full border-2 border-transparent transition-colors';
// The extra top padding is a grab strip for starting a Ctrl-drag selection —
// otherwise the panes reach the top edge and there is nowhere to begin one.
const WRAP_COLUMNS = ' overflow-y-auto overflow-x-hidden px-1 pb-1 pt-6';
// A pane narrower than this is unusable, so the fixed view never packs more
// columns than the window can give this much width to.
const MIN_CELL_W = 300;
const WRAP_FREE = ' grid-canvas relative overflow-auto';

const MIN_W = 260, MIN_H = 150, SNAP = 8;
// Supported fixed-view column counts, and the row height for a given count —
// tuned so 2 cols ≈ 440px and 4 cols ≈ 240px, extended smoothly to 1 and 5.
const COL_CHOICES = [1, 2, 3, 4, 5];
function colRowHeight(cols) { return Math.max(MIN_H, Math.round(800 / Math.max(1, cols) + 40)); }
const CANVAS_HEADROOM = 1200, CANVAS_STEP = 400;
// Panes are laid out around this point rather than at 0,0.
const CANVAS_ORIGIN = 2000;
const ZOOM_MIN = 0.25, ZOOM_MAX = 2, ZOOM_STEP = 1.12;

function buildGridView(tab) {
    const root = document.createElement('div');
    root.className = 'term-view'; root.style.display = 'none';
    $('views').appendChild(root); tab.el = root;

    const wrap = document.createElement('div');
    // Transforms do not affect layout, so a scaled canvas needs a plain sizer
    // element to give the scroll container something to scroll over.
    const spacer = document.createElement('div');
    spacer.className = 'canvas-spacer';
    const layer = document.createElement('div');
    // Empty-state host that is not inside the zero-size transformed layer.
    const empty = document.createElement('div');
    empty.className = 'canvas-empty hidden';
    wrap.appendChild(spacer);
    wrap.appendChild(layer);
    wrap.appendChild(empty);
    root.appendChild(wrap);

    const config = require('./config');
    const savedZoom = Number(config.data.gridZoom);
    const state = {
        wrap, layer, spacer, empty, cols: 4, mounted: false, cells: new Map(), selected: new Set(), upload: null,
        // 'columns' keeps the original auto-flowing CSS grid; 'free' turns the
        // black area into an endless canvas of draggable, resizable panes.
        mode: config.data.gridMode === 'free' ? 'free' : 'columns',
        rects: new Map(),
        zoom: (isFinite(savedZoom) && savedZoom >= ZOOM_MIN && savedZoom <= ZOOM_MAX) ? savedZoom : 1
    };
    applyMode(state);

    tab.grid = {
        state,
        isMounted: () => state.mounted,
        mount: () => gridMount(state),
        unmount: () => gridUnmount(state),
        remount: () => { if (state.mounted) { gridUnmount(state); gridMount(state); } },
        setCols: cols => {
            state.cols = cols;
            // In free mode this only sets the width Tidy will use.
            if (state.mode === 'free') { updateGridToolbar(); return; }
            applyMode(state);
            gridRefit(state);
        },
        getMode: () => state.mode,
        setMode: m => setGridMode(state, m),
        toggleMode: () => setGridMode(state, state.mode === 'free' ? 'columns' : 'free'),
        arrange: () => arrangeColumns(state),
        getZoom: () => state.zoom,
        zoomBy: f => zoomAt(state, f),
        resetZoom: () => setZoom(state, 1),
        refit: () => gridRefit(state),
        broadcast: data => {
            const errs = require('./errors');
            const targets = interactiveTargets(state);
            targets.forEach(t => { if (t.stream) errs.safeWrite(t.stream, data); });
            return targets.length;
        },
        interactiveTargets: () => interactiveTargets(state),
        connectedCount: () => connectedTabs().length,
        startStatsFor: tabId => { const c = state.cells.get(tabId); const t = RT.tabs.find(x => x.id === tabId); if (c && t) gridStartStats(t, c); },
        uploadTargets: () => uploadTargets(state),
        selectAll: () => { connectedTabs().forEach(t => state.selected.add(t.id)); refreshSelection(state); },
        clearSelection: () => { state.selected.clear(); refreshSelection(state); },
        startUpload: () => require('./gridupload').start(state),
        cancelUpload: () => {
            if (!state.upload) return;
            state.upload.cancelled = true;
            // Abort the files already in flight, not just the ones not started.
            if (state.upload.active) state.upload.active.forEach(h => { try { h.cancel(); } catch (e) {} });
        },
        isUploading: () => !!state.upload,
        destroy: () => { if (state.upload) state.upload.cancelled = true; gridUnmount(state); }
    };
}

// Give every visible pane a rect: reuse what is already on screen, then the
// remembered layout for that session, then a free slot.
function seedRects(state, tabs) {
    migrateSavedLayout();
    const saved = savedLayout();
    const placed = [];
    const usedConfigs = new Set();

    tabs.forEach(t => {
        let r = state.rects.get(t.id);
        if (!r && saved && t.configId && !usedConfigs.has(t.configId)) {
            r = sanitizeRect(saved[t.configId]);
            if (r) usedConfigs.add(t.configId);
        }
        if (r) { state.rects.set(t.id, r); placed.push(r); }
    });
    tabs.forEach(t => {
        if (state.rects.has(t.id)) return;
        const r = autoPlace(state, placed);
        state.rects.set(t.id, r);
        placed.push(r);
    });

    // Drop rects for tabs that no longer exist so the canvas can shrink back.
    const live = new Set(tabs.map(t => t.id));
    state.rects.forEach((_, id) => { if (!live.has(id)) state.rects.delete(id); });
}

function applyMode(state) {
    const w = state.wrap, l = state.layer, sp = state.spacer;
    if (state.mode === 'free') {
        w.className = WRAP_BASE + WRAP_FREE;
        l.className = 'canvas-layer';
        l.style.gridTemplateColumns = '';
        l.style.gridAutoRows = '';
        sp.style.display = 'block';
        applyZoom(state);
    } else {
        w.className = WRAP_BASE + WRAP_COLUMNS;
        l.className = 'grid gap-1 content-start';
        l.style.transform = '';
        l.style.width = '';
        l.style.height = '';
        applyColumns(state);
        sp.style.display = 'none';
        w.scrollLeft = 0;
    }
}

// Choose how many columns actually fit: the user's pick, but never so many that
// a pane would fall below MIN_CELL_W on a narrow window. minmax(0,1fr) lets the
// cells shrink to share the width instead of overflowing and being clipped.
function applyColumns(state) {
    if (state.mode !== 'columns') return;
    const width = state.wrap.clientWidth || 1200;
    const eff = Math.max(1, Math.min(state.cols, Math.floor(width / MIN_CELL_W) || 1));
    state.layer.style.gridTemplateColumns = 'repeat(' + eff + ',minmax(0,1fr))';
    state.layer.style.gridAutoRows = colRowHeight(eff) + 'px';
}

const clampZoom = z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

function applyZoom(state) {
    if (state.mode !== 'free') return;
    state.layer.style.transformOrigin = '0 0';
    state.layer.style.transform = 'scale(' + state.zoom + ')';
    growCanvas(state);
    updateZoomReadout(state);
}

// Zoom about a screen point — without this the canvas slides away from whatever
// you were pointing at.
function zoomAt(state, factor, clientX, clientY) {
    if (state.mode !== 'free') return;
    const next = clampZoom(state.zoom * factor);
    if (next === state.zoom) return;

    const w = state.wrap;
    const box = w.getBoundingClientRect();
    const px = (clientX === undefined) ? w.clientWidth / 2 : clientX - box.left;
    const py = (clientY === undefined) ? w.clientHeight / 2 : clientY - box.top;

    // Canvas-space point under the cursor stays put across the scale change.
    const cx = (w.scrollLeft + px) / state.zoom;
    const cy = (w.scrollTop + py) / state.zoom;
    const wantX = Math.max(0, cx * next - px);
    const wantY = Math.max(0, cy * next - py);

    state.zoom = next;
    state.layer.style.transformOrigin = '0 0';
    state.layer.style.transform = 'scale(' + next + ')';

    // Extend the scroll area to cover the target offset BEFORE assigning it.
    ensureExtent(state, wantX + w.clientWidth, wantY + w.clientHeight);
    growCanvas(state);

    w.scrollLeft = wantX;
    w.scrollTop = wantY;
    updateZoomReadout(state);
    saveZoomSoon(state);
}

function ensureExtent(state, needW, needH) {
    if (state.mode !== 'free') return;
    const curW = parseInt(state.spacer.style.width, 10) || 0;
    const curH = parseInt(state.spacer.style.height, 10) || 0;
    if (needW > curW) state.spacer.style.width = Math.ceil(needW / CANVAS_STEP) * CANVAS_STEP + 'px';
    if (needH > curH) state.spacer.style.height = Math.ceil(needH / CANVAS_STEP) * CANVAS_STEP + 'px';
}

function setZoom(state, z) {
    if (state.mode !== 'free') return;
    const next = clampZoom(z);
    if (next === state.zoom) return;
    zoomAt(state, next / state.zoom);
}

let zoomTimer = null;
function saveZoomSoon(state) {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
        zoomTimer = null;
        const config = require('./config');
        config.data.gridZoom = state.zoom;
        require('./errors').attempt(() => config.save(), 'grid zoom save');
    }, 500);
}

function updateZoomReadout(state) {
    const el = $('gridZoomLabel');
    if (el) el.textContent = Math.round(state.zoom * 100) + '%';
}

function setGridMode(state, mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    const config = require('./config');
    config.data.gridMode = mode;
    saveLayoutSoon();

    if (state.mounted) {
        // Switching layout re-parents nothing, so the cheapest correct path is a remount: cells are rebuilt with the right positioning and the xterm…
        gridUnmount(state);
        gridMount(state);
    } else {
        applyMode(state);
    }
    updateGridToolbar();
}

const snap = n => Math.round(n / SNAP) * SNAP;

function savedLayout() {
    const config = require('./config');
    const l = config.data.gridLayout;
    return (l && typeof l === 'object' && !Array.isArray(l)) ? l : null;
}

function sanitizeRect(r) {
    if (!r || typeof r !== 'object') return null;
    const n = v => (typeof v === 'number' && isFinite(v)) ? v : null;
    const x = n(r.x), y = n(r.y), w = n(r.w), h = n(r.h);
    if (x === null || y === null || w === null || h === null) return null;
    return { x: Math.max(0, x), y: Math.max(0, y), w: Math.max(MIN_W, w), h: Math.max(MIN_H, h) };
}

// Layout is remembered per saved session, so reopening a server puts its pane
// back where you left it. Debounced because it writes config.json.
let layoutTimer = null;
function saveLayoutSoon() {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
        layoutTimer = null;
        require('./errors').attempt(() => require('./config').save(), 'grid layout save');
    }, 400);
}

function rememberRect(tabId, rect) {
    const t = RT.tabs.find(x => x.id === tabId);
    if (!t || !t.configId) return;
    const config = require('./config');
    if (!config.data.gridLayout || typeof config.data.gridLayout !== 'object') config.data.gridLayout = {};
    config.data.gridLayout[t.configId] = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    saveLayoutSoon();
}

function getRect(state, tabId) {
    return state.rects.get(tabId) || { x: 0, y: 0, w: MIN_W, h: MIN_H };
}

function setRect(state, tabId, rect) {
    state.rects.set(tabId, rect);
}

function applyRect(state, tabId) {
    const els = state.cells.get(tabId);
    if (!els || !els.cell || state.mode !== 'free') return;
    const r = getRect(state, tabId);
    els.cell.style.left = r.x + 'px';
    els.cell.style.top = r.y + 'px';
    els.cell.style.width = r.w + 'px';
    els.cell.style.height = r.h + 'px';
}

// The canvas is effectively endless: it always extends a full screen beyond the furthest pane and beyond wherever you have scrolled, so there is…
function growCanvas(state) {
    if (state.mode !== 'free') return;
    const w = state.wrap, z = state.zoom;
    let maxX = 0, maxY = 0;
    state.rects.forEach(r => { maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h); });

    const viewW = w.clientWidth || 900, viewH = w.clientHeight || 600;
    // Scroll extent lives in screen pixels, so scale the content bounds.
    const wantW = Math.max(maxX * z + CANVAS_HEADROOM, w.scrollLeft + viewW + CANVAS_HEADROOM, viewW);
    const wantH = Math.max(maxY * z + CANVAS_HEADROOM, w.scrollTop + viewH + CANVAS_HEADROOM, viewH);

    // Grow in chunks: recomputing an exact size on every pointermove makes the
    // scrollbar jitter under the cursor.
    const curW = parseInt(state.spacer.style.width, 10) || 0;
    const curH = parseInt(state.spacer.style.height, 10) || 0;
    if (wantW > curW) state.spacer.style.width = Math.ceil(wantW / CANVAS_STEP) * CANVAS_STEP + 'px';
    if (wantH > curH) state.spacer.style.height = Math.ceil(wantH / CANVAS_STEP) * CANVAS_STEP + 'px';
}

// Reset the extent to just past the content — after Tidy the scroll range
// should not stay stretched by wherever you had wandered.
function shrinkCanvas(state) {
    if (state.mode !== 'free') return;
    state.spacer.style.width = '';
    state.spacer.style.height = '';
    growCanvas(state);
}

// Drag the empty canvas (or middle-drag anywhere) to pan, like any map view.
let activePan = null;
// Space temporarily restores left-drag panning now that left-drag selects.
let spaceHeld = false;
window.addEventListener('keydown', e => { if (e.code === 'Space') spaceHeld = true; });
window.addEventListener('keyup', e => { if (e.code === 'Space') spaceHeld = false; });
window.addEventListener('blur', () => { spaceHeld = false; });

function beginPan(state, e) {
    if (state.mode !== 'free') return;
    // A middle-click while already dragging a pane used to arm both gestures off
    // the same pointermove, doubling the pane's travel.
    if (activeDrag || activePan) return;
    // Clicking the canvas takes focus off any terminal, so the +/-/0 shortcuts
    // start working again instead of staying dead for the rest of the session.
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (err) {}
    activePan = {
        state,
        startX: e.clientX, startY: e.clientY,
        scrollX: state.wrap.scrollLeft, scrollY: state.wrap.scrollTop
    };
    state.wrap.classList.add('canvas-panning');
    e.preventDefault();
}

function onPanMove(e) {
    if (!activePan) return;
    const { state, startX, startY, scrollX, scrollY } = activePan;
    state.wrap.scrollLeft = Math.max(0, scrollX - (e.clientX - startX));
    state.wrap.scrollTop = Math.max(0, scrollY - (e.clientY - startY));
    growCanvas(state);
}

function endPan() {
    if (!activePan) return;
    activePan.state.wrap.classList.remove('canvas-panning');
    activePan = null;
}

function attachCanvasNavigation(state) {
    if (state._navBound) return;
    state._navBound = true;
    const w = state.wrap;

    const marquee = require('./marquee');
    marquee.install();

    w.addEventListener('pointerdown', e => {
        const onEmpty = e.target === w || e.target === state.layer || e.target === state.spacer;
        // Middle-drag pans; left-drag on empty space rubber-band selects panes.
        // Panning also stays available on the left button while Space is held.
        if (e.button === 1) { if (state.mode === 'free') beginPan(state, e); return; }
        if (e.button !== 0 || !onEmpty) return;
        if (spaceHeld && state.mode === 'free') return beginPan(state, e);

        // Moving around is the common action on a canvas, so a plain drag pans.
        // Ctrl (Cmd) turns the same drag into a rubber band, and holding Shift
        // as well adds to the selection instead of replacing it.
        if (!e.ctrlKey && !e.metaKey) {
            if (state.mode === 'free') beginPan(state, e);
            return;
        }
        const additive = e.shiftKey;
        if (!additive) { state.selected.clear(); refreshSelection(state); }
        marquee.begin(e, {
            root: state.layer,
            clip: w,
            additive,
            itemsSelector: '.grid-cell',
            onSelect: (hits, add) => {
                if (!add) state.selected.clear();
                hits.forEach(cell => { if (cell.dataset.tabId) state.selected.add(cell.dataset.tabId); });
                refreshSelection(state);
            }
        });
    });

    // Wheel zooms about the cursor. Shift/middle-drag remain for panning, and
    // the scrollbars still work for anyone who prefers them.
    w.addEventListener('wheel', e => {
        if (state.mode !== 'free') return;
        // Zooming mid-drag rewrites scrollLeft and the zoom factor underneath a gesture whose origin was captured at the old values, which flung the pane…
        if (activeDrag || activePan) { e.preventDefault(); return; }

        if (e.shiftKey) {
            e.preventDefault();
            w.scrollLeft += (e.deltaY || e.deltaX);
            growCanvas(state);
            return;
        }
        // Over a terminal, the wheel belongs to that pane's scrollback — there
        // is otherwise no way to reach it in free mode. Ctrl+wheel still zooms.
        if (!e.ctrlKey && e.target && e.target.closest && e.target.closest('.xterm')) return;

        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        zoomAt(state, dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX, e.clientY);
    }, { passive: false });

    // Middle-click paste would otherwise fire on Linux when panning.
    w.addEventListener('auxclick', e => { if (e.button === 1 && state.mode === 'free') e.preventDefault(); });
    // scroll fires continuously and growCanvas reads layout; one check per frame
    // is plenty to keep the endless canvas extending ahead of you.
    let scrollFrame = null;
    w.addEventListener('scroll', () => {
        if (scrollFrame) return;
        scrollFrame = requestAnimationFrame(() => { scrollFrame = null; growCanvas(state); });
    });
}

function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Place a pane that has no remembered position: scan left-to-right, top-to-
// bottom for the first free slot, falling back to a cascade.
function autoPlace(state, taken) {
    // Work in canvas units: at 50% zoom the viewport shows twice as much canvas.
    const width = Math.max(visibleCanvasWidth(state), MIN_W + 40);
    const w = Math.max(MIN_W, snap(Math.floor((width - 16) / state.cols) - 8));
    const h = colRowHeight(state.cols);
    for (let y = CANVAS_ORIGIN; y < CANVAS_ORIGIN + 8000; y += SNAP * 4) {
        for (let x = CANVAS_ORIGIN; x + w <= CANVAS_ORIGIN + width; x += SNAP * 4) {
            const cand = { x, y, w, h };
            if (!taken.some(r => overlaps(cand, r))) return cand;
        }
    }
    const n = taken.length;
    return { x: CANVAS_ORIGIN + snap(24 * (n % 10)), y: CANVAS_ORIGIN + snap(24 * (n % 10)), w, h };
}

function contentBounds(state) {
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    state.rects.forEach(r => {
        minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    });
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

// Put the viewport over the middle of the panes rather than the canvas corner.
function centerOnContent(state) {
    if (state.mode !== 'free') return;
    const b = contentBounds(state);
    if (!b) return;
    const z = state.zoom || 1, w = state.wrap;
    growCanvas(state);
    w.scrollLeft = Math.max(0, ((b.minX + b.maxX) / 2) * z - (w.clientWidth || 900) / 2);
    w.scrollTop = Math.max(0, ((b.minY + b.maxY) / 2) * z - (w.clientHeight || 600) / 2);
    growCanvas(state);
}

// One-time repair of layouts saved before panes were centred.
function migrateSavedLayout() {
    const config = require('./config');
    if (config.data.gridLayoutCentred) return;

    const saved = savedLayout();
    if (saved) {
        const ids = Object.keys(saved);
        let minX = Infinity, minY = Infinity;
        ids.forEach(id => {
            const r = sanitizeRect(saved[id]);
            if (!r) return;
            minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
        });
        if (minX !== Infinity && (minX < CANVAS_ORIGIN / 2 || minY < CANVAS_ORIGIN / 2)) {
            const dx = Math.max(0, CANVAS_ORIGIN - minX), dy = Math.max(0, CANVAS_ORIGIN - minY);
            ids.forEach(id => {
                const r = sanitizeRect(saved[id]);
                if (!r) { delete saved[id]; return; }
                saved[id] = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
            });
        }
    }
    config.data.gridLayoutCentred = true;
    saveLayoutSoon();
}

function visibleCanvasWidth(state) {
    const z = state.zoom || 1;
    return (state.wrap.clientWidth || 900) / z;
}

function arrangeColumns(state) {
    const tabs = RT.tabs.filter(t => t.type === 'terminal' && !t.closed);
    if (!tabs.length) return;
    const z = state.zoom || 1;
    const width = Math.max(visibleCanvasWidth(state), MIN_W + 40);
    const cols = Math.max(1, state.cols);
    const w = Math.max(MIN_W, Math.floor((width - 16) / cols) - 8);
    // Height has to scale by the same 1/zoom factor as the width, or the panes
    // come out stretched: at 25% zoom the old fixed height made them five times
    // wider than they were tall.
    const h = Math.max(MIN_H, Math.round(colRowHeight(cols) / z) - 8);
    tabs.forEach((t, i) => {
        const rect = {
            x: CANVAS_ORIGIN + (i % cols) * (w + 8),
            y: CANVAS_ORIGIN + Math.floor(i / cols) * (h + 8),
            w, h
        };
        setRect(state, t.id, rect);
        applyRect(state, t.id);
        rememberRect(t.id, rect);
    });
    // Tidy also brings the viewport back over the panes — otherwise they move but the view stays wherever you had panned to, and it looks like nothing…
    shrinkCanvas(state);
    centerOnContent(state);
    gridRefit(state);
}

let activeDrag = null;
let zTop = 10;
// pointerup is followed by a click on the header; this suppresses the selection toggle for the click that ends a drag.
let suppressClickFor = null, suppressAt = 0;
const SUPPRESS_WINDOW = 500;
function shouldSuppressClick(tabId) {
    if (suppressClickFor !== tabId) return false;
    const fresh = (Date.now() - suppressAt) < SUPPRESS_WINDOW;
    suppressClickFor = null;
    return fresh;
}

function bringToFront(els) {
    if (els && els.cell) els.cell.style.zIndex = String(++zTop);
}

function beginDrag(state, tabId, kind, e) {
    if (state.mode !== 'free' || e.button !== 0) return;
    const els = state.cells.get(tabId);
    if (!els) return;
    suppressClickFor = null;
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (err) {}
    activeDrag = {
        state, tabId, kind, moved: false,
        startX: e.clientX, startY: e.clientY,
        orig: Object.assign({}, getRect(state, tabId)),
        // Cached once: reading these mid-drag forces a synchronous reflow, and
        // the viewport cannot change while the pointer is down anyway.
        scrollX: state.wrap.scrollLeft, scrollY: state.wrap.scrollTop,
        viewW: state.wrap.clientWidth || 900, viewH: state.wrap.clientHeight || 600,
        pending: null, lastFit: 0
    };
    bringToFront(els);
    els.cell.classList.add('cell-active');
    e.preventDefault();
    e.stopPropagation();
}

// pointermove fires faster than the screen refreshes; collapse to one visual
// update per frame and read the pointer position from the newest event only.
let dragFrame = null, dragPointer = null;

function onDragMove(e) {
    if (!activeDrag) return;
    dragPointer = { x: e.clientX, y: e.clientY };
    if (dragFrame) return;
    dragFrame = requestAnimationFrame(() => { dragFrame = null; applyDragFrame(); });
}

function applyDragFrame() {
    const d = activeDrag, p = dragPointer;
    if (!d || !p) return;
    const { state, tabId, kind, orig } = d;
    const els = state.cells.get(tabId);
    if (!els || !els.cell) return;

    const sx = (p.x - d.startX) + (state.wrap.scrollLeft - d.scrollX);
    const sy = (p.y - d.startY) + (state.wrap.scrollTop - d.scrollY);
    if (!d.moved && Math.abs(sx) + Math.abs(sy) < 4) return;
    d.moved = true;

    const z = state.zoom || 1;
    const dx = sx / z, dy = sy / z;
    const r = Object.assign({}, orig);

    if (kind === 'move') {
        r.x = Math.max(0, snap(orig.x + dx));
        r.y = Math.max(0, snap(orig.y + dy));
        d.pending = r;
        // Compositor-only: no layout, no paint of the terminal underneath. The
        // real left/top is written once, on release.
        els.cell.style.transform = 'translate3d(' + (r.x - orig.x) + 'px,' + (r.y - orig.y) + 'px,0)';
        growCanvasFast(state, r, d);
        return;
    }

    if (kind.indexOf('r') >= 0) r.w = Math.max(MIN_W, snap(orig.w + dx));
    if (kind.indexOf('b') >= 0) r.h = Math.max(MIN_H, snap(orig.h + dy));
    setRect(state, tabId, r);
    applyRect(state, tabId);
    growCanvasFast(state, r, d);

    // Reflowing the terminal buffer is the expensive part of a resize; a few
    // times a second is enough to feel live.
    const now = Date.now();
    if (now - d.lastFit > 90) { d.lastFit = now; fitTab(state, tabId, false); }
}

// Grow purely from cached numbers — no DOM reads, so this cannot trigger a
// forced reflow in the middle of a drag.
function growCanvasFast(state, r, d) {
    if (state.mode !== 'free') return;
    const z = state.zoom || 1;
    const wantW = Math.max((r.x + r.w) * z + CANVAS_HEADROOM, d.scrollX + d.viewW + CANVAS_HEADROOM);
    const wantH = Math.max((r.y + r.h) * z + CANVAS_HEADROOM, d.scrollY + d.viewH + CANVAS_HEADROOM);
    const curW = parseInt(state.spacer.style.width, 10) || 0;
    const curH = parseInt(state.spacer.style.height, 10) || 0;
    if (wantW > curW) state.spacer.style.width = Math.ceil(wantW / CANVAS_STEP) * CANVAS_STEP + 'px';
    if (wantH > curH) state.spacer.style.height = Math.ceil(wantH / CANVAS_STEP) * CANVAS_STEP + 'px';
}

function onDragEnd() {
    const d = activeDrag;
    activeDrag = null;
    dragPointer = null;
    if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = null; }
    if (!d) return;

    const els = d.state.cells.get(d.tabId);
    if (els && els.cell) {
        els.cell.classList.remove('cell-active');
        // Swap the temporary transform for the real geometry in one write, so
        // the pane does not jump between the two representations.
        if (d.kind === 'move' && d.pending) {
            els.cell.style.transform = '';
            setRect(d.state, d.tabId, d.pending);
            applyRect(d.state, d.tabId);
        }
    }
    if (!d.moved) return;
    if (d.kind === 'move') { suppressClickFor = d.tabId; suppressAt = Date.now(); }
    // Only tell the remote its window changed once, on release — doing it per
    // pointermove would flood the connection with SIGWINCH traffic.
    fitTab(d.state, d.tabId, true);
    rememberRect(d.tabId, getRect(d.state, d.tabId));
    growCanvas(d.state);
}

function fitTab(state, tabId, notifyRemote) {
    const t = RT.tabs.find(x => x.id === tabId);
    if (!t || !t.fitAddon || !t.term) return;
    try {
        t.fitAddon.fit();
        if (notifyRemote && t.stream && t.stream.setWindow) t.stream.setWindow(t.term.rows, t.term.cols, 0, 0);
    } catch (e) { require('./errors').record('grid.fit', e); }
}

function installDragListeners() {
    if (installDragListeners.done) return;
    installDragListeners.done = true;
    window.addEventListener('pointermove', e => { onDragMove(e); onPanMove(e); });
    window.addEventListener('pointerup', () => { onDragEnd(); endPan(); });
    window.addEventListener('pointercancel', () => { onDragEnd(); endPan(); });
    window.addEventListener('blur', () => { onDragEnd(); endPan(); });
}

// Any modal or popover that should own the keyboard while it is up.
const OVERLAY_IDS = ['msgModal', 'inputModal', 'sessionModal', 'bulkModal', 'themeModal',
    'configModal', 'iconPicker', 'lockScreen', 'ctxMenu', 'tabMenu', 'menuDropdown', 'fileMenu'];
function anyOverlayOpen() {
    return OVERLAY_IDS.some(id => {
        const el = $(id);
        return el && !el.classList.contains('hidden');
    });
}

function connectedTabs() {
    return RT.tabs.filter(t => t.type === 'terminal' && !t.closed && t.connected);
}

// Upload goes to exactly the servers you picked, same as broadcast.
function uploadTargets(state) {
    return connectedTabs().filter(t => state.selected.has(t.id));
}

// Ids of tabs that have since closed would otherwise linger in state.selected: uploadTargets intersects with the live tabs and returns nothing, so…
function pruneSelection(state) {
    if (!state.selected.size) return;
    const live = new Set(RT.tabs.filter(t => t.type === 'terminal' && !t.closed).map(t => t.id));
    state.selected.forEach(id => { if (!live.has(id)) state.selected.delete(id); });
}

// Broadcast targets are exactly the servers you picked.
function interactiveTargets(state) {
    return connectedTabs().filter(t => state.selected.has(t.id));
}

function refreshSelection(state) {
    pruneSelection(state);
    state.cells.forEach((els, tabId) => {
        const on = state.selected.has(tabId);
        if (els.cell) els.cell.classList.toggle('cell-selected', on);
        if (els.check) els.check.classList.toggle('opacity-100', on);
        if (els.check) els.check.classList.toggle('opacity-25', !on);
        if (els.check) els.check.classList.toggle('text-accent', on);
        // Armed = selected while Broadcast is live; the pulsing outline makes it
        // unmistakable which servers are about to receive your keystrokes.
        if (els.cell) els.cell.classList.toggle('cell-armed', on && RT.isInteractiveMode);
    });
    updateGridToolbar();
    updateInteractiveUi(state);
}

function updateInteractiveUi(state) {
    const label = $('interactiveLabel');
    const hint = $('interactiveHint');
    const n = state ? interactiveTargets(state).length : 0;
    if (label) label.textContent = RT.isInteractiveMode ? (n ? 'Broadcasting to ' + n : 'Pick targets') : 'Interactive';
    if (hint) hint.classList.toggle('hidden', !(RT.isInteractiveMode && n === 0));
}

// The dot colour was baked in at mount and never touched again, so a server that
// dropped (or reconnected) kept its old colour until the grid was remounted.
function refreshCellStatus(state) {
    if (!state.mounted) return;
    state.cells.forEach((els, tabId) => {
        const t = RT.tabs.find(x => x.id === tabId);
        if (!t || !els.dot) return;
        const color = t.error ? 'bg-bad' : (t.connected ? 'bg-ok' : 'bg-warn');
        els.dot.className = 'w-2 h-2 rounded-full shrink-0 ' + color;
    });
}

function updateGridToolbar() {
    const { $ } = require('./util');
    const btn = $('btnGridUpload');
    const label = $('gridUploadLabel');
    const cancel = $('btnGridUploadCancel');
    if (!btn || !label || !cancel) return;

    // Never assign textContent to the button itself: #gridUploadLabel and the icon are its children, and doing so deleted them permanently, so the next…
    const g = tabsMod().activeGrid();
    if (!g) {
        btn.disabled = true;
        btn.classList.add('opacity-40');
        label.textContent = 'Upload…';
        cancel.classList.add('hidden');
        return;
    }
    const targets = g.uploadTargets();
    const uploading = g.isUploading();
    btn.disabled = !targets.length || uploading;
    btn.classList.toggle('opacity-40', btn.disabled);
    btn.title = targets.length ? '' : 'Click server headers in the grid to choose upload targets';
    label.textContent = targets.length ? `Upload to ${targets.length}` : 'Upload…';
    cancel.classList.toggle('hidden', !uploading);
    updateLayoutToolbar(g);
}

function updateLayoutToolbar(g) {
    const { $ } = require('./util');
    const label = $('gridLayoutLabel');
    const arrange = $('btnGridArrange');
    if (!label || !arrange) return;
    const free = !!g && g.getMode() === 'free';
    // The button names where it takes you, not where you are.
    label.textContent = free ? 'Columns' : 'Free Layout';
    arrange.classList.toggle('hidden', !free);
    const zoomBox = $('gridZoomBox');
    if (zoomBox) { zoomBox.classList.toggle('hidden', !free); zoomBox.classList.toggle('flex', free); }
    const zl = $('gridZoomLabel');
    if (zl && g) zl.textContent = Math.round((free ? g.getZoom() : 1) * 100) + '%';

    const cols = g ? g.state.cols : 4;
    COL_CHOICES.forEach(c => {
        const b = $('btnCols' + c);
        if (b) b.classList.toggle('is-active', cols === c);
    });
}

function gridMount(state) {
    if (state.mounted) return;
    state.layer.innerHTML = '';
    state.cells.clear();
    pruneSelection(state);
    applyMode(state);
    installDragListeners();
    attachCanvasNavigation(state);
    const termTabs = RT.tabs.filter(t => t.type === 'terminal');
    if (state.mode === 'free') seedRects(state, termTabs);
    if (!termTabs.length) {
        // In free mode the layer is a zero-size transformed box, so a message placed inside it wraps to one word per line in the canvas corner.
        const host = state.mode === 'free' ? state.empty : state.layer;
        if (state.mode === 'free') state.layer.innerHTML = '';
        host.innerHTML = `<div class="col-span-full flex flex-col items-center justify-center h-48 text-faint text-sm gap-1"><span>No open sessions.</span><span class="text-xs">Open sessions from the sidebar to tile them here.</span></div>`;
        if (state.empty) state.empty.classList.toggle('hidden', state.mode !== 'free');
        state.mounted = true;
        updateGridToolbar();
        return;
    }
    if (state.empty) { state.empty.classList.add('hidden'); state.empty.innerHTML = ''; }
    termTabs.forEach(t => {
        const cell = document.createElement('div');
        // transition-shadow, never transition-all: animating left/top/width made
        // a dragged pane ease toward the cursor 150ms behind the pointer.
        cell.dataset.tabId = t.id;
        cell.className = 'grid-cell flex flex-col bg-black rounded overflow-hidden relative ring-1 ring-edge hover:ring-accent hover:ring-2 transition-shadow' +
            (state.selected.has(t.id) ? ' cell-selected' : '');
        const header = document.createElement('div');
        header.className = 'bg-panel2 px-2 py-1 flex justify-between items-center select-none h-7 shrink-0 border-b border-edge relative cursor-pointer';
        header.title = 'Click to select this server for bulk actions';
        const color = t.error ? 'bg-bad' : (t.connected ? 'bg-ok' : 'bg-warn');
        const sel = state.selected.has(t.id);
        header.innerHTML = `
            <div class="flex items-center gap-2 overflow-hidden min-w-0 flex-1">
                <span class="w-2 h-2 rounded-full ${color} shrink-0"></span>
                <svg class="cell-check w-3.5 h-3.5 shrink-0 transition-opacity ${sel ? 'opacity-100 text-accent' : 'opacity-25 text-muted'}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>
                <span class="server-name font-bold text-xs text-txt truncate font-mono cursor-pointer hover:text-accent hover:underline" title="Open this tab">${escapeHtml(t.title)}</span>
                <div class="h-3.5 w-px bg-edge mx-1 shrink-0"></div>
                <div class="flex items-center gap-2 text-[10px] font-bold font-mono text-faint">
                    <span class="cpu">CPU ${t.lastStats.cpu}</span><span class="mem hidden md:inline">${t.lastStats.mem}</span><span class="net text-muted">${t.lastStats.net || '↑-- ↓--'}</span>
                </div>
                <span class="xfer hidden text-[10px] font-bold font-mono text-accent shrink-0 ml-auto"></span>
            </div>
            <div class="xfer-bar hidden absolute left-0 bottom-0 h-0.5 bg-accent transition-all" style="width:0%"></div>`;
        const body = document.createElement('div');
        body.className = 'flex-grow relative bg-black overflow-hidden';
        cell.appendChild(header); cell.appendChild(body);

        // Handles exist in both modes but are only shown (and only bound) on the
        // canvas; CSS hides them in column mode.
        const handles = ['r', 'b', 'br'].map(kind => {
            const h = document.createElement('div');
            h.className = 'rz rz-' + kind;
            h.addEventListener('pointerdown', e => beginDrag(state, t.id, kind, e));
            cell.appendChild(h);
            return h;
        });

        state.layer.appendChild(cell);

        if (t.term && t.term.element) body.appendChild(t.term.element);

        const els = {
            cell, dot: header.querySelector('span'), cpu: header.querySelector('.cpu'),
            mem: header.querySelector('.mem'), net: header.querySelector('.net'),
            check: header.querySelector('.cell-check'), xfer: header.querySelector('.xfer'),
            xferBar: header.querySelector('.xfer-bar'), body
        };
        state.cells.set(t.id, els);
        header.querySelector('.server-name').addEventListener('click', e => { e.stopPropagation(); tabsMod().setActiveTab(t.id); });
        header.addEventListener('pointerdown', e => {
            if (state.mode !== 'free') return;
            if (e.target.closest('.server-name')) return;
            beginDrag(state, t.id, 'move', e);
        });
        header.addEventListener('click', () => {
            // A drag that moved the pane must not also toggle its selection.
            if (shouldSuppressClick(t.id)) return;
            const nowSelected = !state.selected.has(t.id);
            if (nowSelected) state.selected.add(t.id);
            else state.selected.delete(t.id);
            refreshSelection(state);
            // With the SFTP pane open, picking a server in the grid is the
            // clearest statement of which host you want to browse.
            if (nowSelected && RT.sftpMode && t.connected) {
                require('./errors').attempt(() => require('./sftp').focusTab(t.id), 'sftp focus');
            }
        });

        if (state.mode === 'free') applyRect(state, t.id);

        requestAnimationFrame(() => { try { t.fitAddon.fit(); if (t.stream && t.stream.setWindow) t.stream.setWindow(t.term.rows, t.term.cols, 0, 0); t.term.scrollToBottom(); } catch (e) {} });
        gridStartStats(t, els);
    });
    state.mounted = true;
    if (state.mode === 'free') {
        growCanvas(state);
        // Only on the first mount: re-centring on every tab switch would throw
        // away wherever the user had panned to.
        if (!state._centred) { state._centred = true; centerOnContent(state); }
    }
    // Reapplies cell-selected / cell-armed to the freshly built cells and syncs
    // both toolbars.
    refreshSelection(state);
}

function gridUnmount(state) {
    if (!state.mounted) return;
    // A pointer capture that outlives the cells it referenced would write rects
    // for elements that no longer exist.
    if (activeDrag && activeDrag.state === state) activeDrag = null;
    state.cells.forEach((els, tabId) => {
        const t = RT.tabs.find(x => x.id === tabId);
        gridStopStats(t);
        if (t && t.term && t.term.element && t.el) {
            t.el.appendChild(t.term.element);
            requestAnimationFrame(() => tabsMod().fitTerminalTab(t));
        }
    });
    state.cells.clear();
    state.layer.innerHTML = '';
    state.mounted = false;
}

function gridRefit(state) {
    // Recompute how many columns fit before measuring the terminals, so a
    // resize reflows the layout instead of squishing panes past usability.
    applyColumns(state);
    requestAnimationFrame(() => {
        state.cells.forEach((els, tabId) => {
            const t = RT.tabs.find(x => x.id === tabId);
            if (!t || !t.fitAddon) return;
            try { t.fitAddon.fit(); if (t.stream && t.stream.setWindow) t.stream.setWindow(t.term.rows, t.term.cols, 0, 0); t.term.scrollToBottom(); } catch (e) {}
        });
    });
}

function liveCell(tabId) {
    const g = tabsMod().activeGrid();
    return g && g.isMounted() ? g.state.cells.get(tabId) : null;
}

function gridStartStats(tab, els) {
    if (!tab || tab.closed || !tab.client || !tab.connected) return;
    if (tab._gridTimer) return;
    tab._gridPrev = null; tab._gridFails = 0;
    const errors = require('./errors');
    const tick = () => {
        if (tab.closed || !tab.connected || !tab.client) return gridStopStats(tab);
        if (tab._gridBusy) return;
        tab._gridBusy = true;
        let buf = '';
        const fail = e => {
            tab._gridBusy = false;
            tab._gridFails = (tab._gridFails || 0) + 1;
            if (e) errors.record('grid.stats', e, tab.title);
            if (tab._gridFails >= 5) gridStopStats(tab);
        };
        try {
            tab.client.exec(GRID_SAMPLE_CMD, (err, stream) => {
                if (err) return fail(err);
                if (tab.closed) { tab._gridBusy = false; try { stream.close(); } catch (e) {} return; }
                errors.guardStream(stream, 'grid.stats');
                // 'error' without 'close' would latch _gridBusy true forever.
                stream.on('error', e => fail(e));
                stream.on('data', d => { buf += d.toString(); });
                stream.stderr.on('data', () => {});
                stream.on('close', () => {
                    tab._gridBusy = false;
                    try { parseGridSample(tab, buf); tab._gridFails = 0; }
                    catch (e) { errors.record('grid.parse', e); }
                });
            });
        } catch (e) { fail(e); }
    };
    tick();
    tab._gridTimer = setInterval(tick, 1000);
}

function parseGridSample(tab, text) {
    const lines = text.split('\n');
    const sec = { K_MEM: [], K_CPU: [], K_NET: [] };
    let key = null;
    for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (sec[line]) { key = line; continue; }
        if (key) sec[key].push(line);
    }
    const cur = liveCell(tab.id);
    const prev = tab._gridPrev || {};
    const next = {};

    let mt = 0, ma = 0;
    sec.K_MEM.forEach(l => { const m = l.match(/(MemTotal|MemAvailable):\s+(\d+)/); if (m) { if (m[1] === 'MemTotal') mt = +m[2]; else ma = +m[2]; } });
    if (mt) {
        const memTxt = Math.round((mt - ma) / 1024) + '/' + Math.round(mt / 1024) + 'MB';
        tab.lastStats.mem = memTxt;
        if (cur && cur.mem) cur.mem.innerText = memTxt;
    }

    const nums = (sec.K_CPU[0] || '').trim().split(/\s+/).slice(1).map(Number);
    if (nums.length >= 4) {
        const idle = nums[3] + (nums[4] || 0), total = nums.reduce((a, b) => a + b, 0);
        if (prev.cpuTotal != null && total > prev.cpuTotal) {
            const dT = total - prev.cpuTotal, dI = idle - prev.cpuIdle;
            const usage = dT > 0 ? (100 * (dT - dI) / dT).toFixed(1) : '0.0';
            tab.lastStats.cpu = usage + '%';
            if (cur && cur.cpu) {
                cur.cpu.innerText = 'CPU ' + usage + '%';
                cur.cpu.className = 'cpu ' + (usage > 80 ? 'text-bad font-extrabold' : usage > 50 ? 'text-warn font-bold' : 'text-muted');
            }
        }
        next.cpuTotal = total; next.cpuIdle = idle;
    }

    let rx = 0, tx = 0;
    sec.K_NET.forEach(l => {
        if (!l.includes(':')) return;
        const idx = l.indexOf(':'), iface = l.slice(0, idx).trim();
        if (iface === 'lo') return;
        const n = l.slice(idx + 1).trim().split(/\s+/).map(Number);
        if (n.length >= 9) { rx += n[0] || 0; tx += n[8] || 0; }
    });
    const now = Date.now();
    if (prev.rx != null && prev.t) {
        const dt = (now - prev.t) / 1000;
        if (dt > 0) {
            const down = Math.max(0, (rx - prev.rx) * 8 / 1e6 / dt);
            const up = Math.max(0, (tx - prev.tx) * 8 / 1e6 / dt);
            const netTxt = `↑${up.toFixed(1)} ↓${down.toFixed(1)}`;
            tab.lastStats.net = netTxt;
            if (cur && cur.net) cur.net.innerText = netTxt;
        }
    }
    next.rx = rx; next.tx = tx; next.t = now;
    tab._gridPrev = next;
}

function gridStopStats(tab) {
    if (!tab) return;
    if (tab._gridTimer) clearInterval(tab._gridTimer);
    tab._gridTimer = null; tab._gridBusy = false; tab._gridPrev = null;
}

function init() {
    const btnInteractive = $('btnInteractive');
    const activeGrid = () => tabsMod().activeGrid();

    require('./gridupload').init();
    $('btnGridLayout').addEventListener('click', () => { const g = activeGrid(); if (g) g.toggleMode(); });
    $('btnGridArrange').addEventListener('click', () => { const g = activeGrid(); if (g) g.arrange(); });
    $('btnZoomIn').addEventListener('click', () => { const g = activeGrid(); if (g) g.zoomBy(ZOOM_STEP); });
    $('btnZoomOut').addEventListener('click', () => { const g = activeGrid(); if (g) g.zoomBy(1 / ZOOM_STEP); });
    $('gridZoomLabel').addEventListener('click', () => { const g = activeGrid(); if (g) g.resetZoom(); });

    // +/- zoom the canvas. Terminals must keep every keystroke, so this only
    // fires when focus is not inside a text field or a live terminal.
    document.addEventListener('keydown', e => {
        const g = activeGrid();
        if (!g || g.getMode() !== 'free') return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (anyOverlayOpen()) return;
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
        if (el && el.closest && el.closest('.xterm')) return;
        if (RT.isInteractiveMode) return;

        if (e.key === '+' || e.key === '=' || e.key === 'Add') { e.preventDefault(); g.zoomBy(ZOOM_STEP); }
        else if (e.key === '-' || e.key === '_' || e.key === 'Subtract') { e.preventDefault(); g.zoomBy(1 / ZOOM_STEP); }
        else if (e.key === '0') { e.preventDefault(); g.resetZoom(); }
    });
    $('btnGridUpload').addEventListener('click', () => { const g = activeGrid(); if (g) g.startUpload(); });
    $('btnGridUploadCancel').addEventListener('click', () => {
        const g = activeGrid(); if (!g) return;
        g.cancelUpload();
        updateGridToolbar();
    });
    $('btnGridSelAll').addEventListener('click', () => { const g = activeGrid(); if (g) g.selectAll(); });
    $('btnGridSelNone').addEventListener('click', () => { const g = activeGrid(); if (g) g.clearSelection(); });

    $('btnPasteAll').addEventListener('click', async () => {
        const g = activeGrid(); if (!g) return;
        const n = g.interactiveTargets().length;
        if (!n) return require('./dialog').notify(
            'Select the servers to paste into first — click their headers in the grid.',
            { kind: 'warn', title: 'No targets selected' });
        const t = clipboard.readText();
        if (!t) return;
        if (await require('./dialog').confirm(
            `Paste the clipboard into ${n} selected server${n === 1 ? '' : 's'}?`, { okLabel: 'Paste' })) g.broadcast(t);
    });
    const setCols = n => { const g = activeGrid(); if (g) g.setCols(n); updateGridToolbar(); };
    COL_CHOICES.forEach(c => { const b = $('btnCols' + c); if (b) b.addEventListener('click', () => setCols(c)); });
    const ICON_EYE = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.46 12C3.73 7.94 7.52 5 12 5s8.27 2.94 9.54 7c-1.27 4.06-5.06 7-9.54 7s-8.27-2.94-9.54-7z"></path></svg>';
    const ICON_STOP = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.36 18.36A9 9 0 005.64 5.64m12.72 12.72L5.64 5.64"></path></svg>';
    const CLS_ON = 'bg-bad/20 text-bad border border-bad text-xs font-semibold px-3 py-2 rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap';
    const CLS_OFF = 'bg-panel2 hover:bg-panel3 text-muted hover:text-txt border border-edge text-xs font-semibold px-3 py-2 rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap';

    btnInteractive.addEventListener('click', () => {
        RT.isInteractiveMode = !RT.isInteractiveMode;
        const g = activeGrid();
        // Rebuild rather than overwrite innerHTML wholesale, so #interactiveLabel
        // survives and updateInteractiveUi can keep writing the target count.
        btnInteractive.className = RT.isInteractiveMode ? CLS_ON : CLS_OFF;
        btnInteractive.innerHTML = (RT.isInteractiveMode ? ICON_STOP : ICON_EYE) + '<span id="interactiveLabel"></span>';
        if (g) refreshSelection(g.state);
        else updateInteractiveUi(null);
    });

    document.addEventListener('keydown', e => {
        if (!RT.isInteractiveMode) return;
        const g = activeGrid(); if (!g) return;
        const tgt = e.target;
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
        // A dialog on screen owns the keyboard.
        if (anyOverlayOpen()) return;
        // Armed with no targets, the old code still swallowed every key, so Esc,
        // Ctrl+W and Ctrl+T stopped working app-wide with nothing to show for it.
        if (!g.interactiveTargets().length) return;
        let data = '';
        if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
            const k = e.key.toLowerCase();
            if (k.length === 1 && k >= 'a' && k <= 'z') data = String.fromCharCode(k.charCodeAt(0) - 96);
            else if (e.key === '[') data = '\x1b';
        } else if (!e.ctrlKey && !e.altKey && !e.metaKey) {
            switch (e.key) {
                case 'Enter': data = '\r'; break; case 'Backspace': data = '\x7f'; break;
                case 'Tab': data = '\t'; break; case 'Escape': data = '\x1b'; break;
                case 'ArrowUp': data = '\x1b[A'; break; case 'ArrowDown': data = '\x1b[B'; break;
                case 'ArrowRight': data = '\x1b[C'; break; case 'ArrowLeft': data = '\x1b[D'; break;
                case 'Home': data = '\x1b[H'; break; case 'End': data = '\x1b[F'; break;
                default: if (e.key.length === 1) data = e.key;
            }
        }
        if (data) { e.preventDefault(); e.stopPropagation(); g.broadcast(data); }
    }, true);
}

function setCellProgress(state, tabId, pct, text) {
    const els = state.cells.get(tabId);
    if (!els) return;
    if (els.xfer) {
        els.xfer.classList.toggle('hidden', text == null);
        if (text != null) els.xfer.textContent = text;
    }
    if (els.xferBar) {
        els.xferBar.classList.toggle('hidden', pct == null);
        if (pct != null) els.xferBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }
}

// Called from renderTabBar so grid dots track connection changes live.
function refreshActiveGridStatus() {
    const g = tabsMod().activeGrid();
    if (g && g.isMounted()) { refreshCellStatus(g.state); updateGridToolbar(); }
}

module.exports = {
    buildGridView, gridStopStats, init, uploadTargets, updateGridToolbar,
    setCellProgress, refreshActiveGridStatus
};
