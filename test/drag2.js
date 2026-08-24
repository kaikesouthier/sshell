const __ROOT__ = require('path').join(__dirname, '..');
const fs = require('fs');
const src = fs.readFileSync((__ROOT__ + '/src/grid.js'), 'utf8');
const grab = n => {
  const i = src.indexOf('function ' + n + '(');
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const consts = /const MIN_W[\s\S]*?ZOOM_STEP = [\d.]+;\n/.exec(src)[0];
const body = consts +
  'const snap=n=>Math.round(n/SNAP)*SNAP;const clampZoom=z=>Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,z));\n' +
  'let activeDrag=null,zTop=10,suppressClickFor=null,activePan=null,fitQueued=null,zoomTimer=null;\n' +
  'let dragFrame=null,dragPointer=null;\n' +
  ['bringToFront', 'beginDrag', 'onDragMove', 'applyDragFrame', 'growCanvasFast', 'onDragEnd',
   'getRect', 'setRect', 'applyRect', 'growCanvas', 'ensureExtent', 'fitTab', 'beginPan', 'onPanMove', 'endPan',
   'applyZoom', 'zoomAt', 'setZoom', 'saveZoomSoon', 'updateZoomReadout'].map(grab).join('\n');

let RT = { tabs: [] }, fits = [], remembered = [], cfg = { data: {} };
const H = new Function('RT', 'require', 'rememberRect', 'requestAnimationFrame', '$',
  body + ';return {beginDrag,onDragMove,onDragEnd,getRect,zoomAt,setZoom,beginPan,onPanMove,endPan,' +
  'MIN_W,MIN_H,ZOOM_MIN,ZOOM_MAX,ZOOM_STEP,peek:()=>activeDrag,pan:()=>activePan,supp:()=>suppressClickFor};')(
  RT, m => m === './config' ? cfg : { attempt: f => f(), record() {} },
  (id, r) => remembered.push({ id, r }),
  // Default: run the callback synchronously and return a falsy id, so the
  // "frame already flushed" guard behaves as it does in a real browser.
  // Switch to 'queue' to observe coalescing.
  f => { if (rafMode === 'queue') { rafQueue.push(f); return rafQueue.length; } f(); return 0; },
  () => null);
let rafMode = 'sync', rafQueue = [];
global.cancelAnimationFrame = () => {};

const mkCell = () => ({ style: {}, classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
function mkState(zoom) {
  const cell = mkCell();
  const s = {
    mode: 'free', zoom: zoom || 1, cols: 4,
    wrap: {
      clientWidth: 1000, clientHeight: 700, scrollLeft: 0, scrollTop: 0, style: {},
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      classList: { add() {}, remove() {} }
    },
    spacer: { style: {} }, layer: { style: {} },
    cells: new Map([['t1', { cell }]]),
    rects: new Map([['t1', { x: 100, y: 100, w: 400, h: 300 }]])
  };
  RT.tabs = [{ id: 't1', type: 'terminal', closed: false, configId: 'c1',
    fitAddon: { fit() { fits.push('fit'); } }, term: { rows: 24, cols: 80 },
    stream: { setWindow() { fits.push('setWindow'); } } }];
  return s;
}
const ev = (x, y, btn) => ({ clientX: x, clientY: y, button: btn === undefined ? 0 : btn,
  preventDefault() {}, stopPropagation() {}, target: { closest: () => null } });

let pass = 0, fail = 0;
const t = (n, c) => {
  try {
    const r = c();
    if (r === true) { pass++; console.log('  ok   ' + n); }
    else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
  } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

t('a move drag translates the pane (snapped)', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'move', ev(0, 0)); H.onDragMove(ev(64, 32)); H.onDragEnd();
  const r = H.getRect(s, 't1'); return (r.x === 168 && r.y === 136) || JSON.stringify(r);
});
t('a pane cannot be dragged past the origin', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'move', ev(0, 0)); H.onDragMove(ev(-9999, -9999)); H.onDragEnd();
  const r = H.getRect(s, 't1'); return r.x === 0 && r.y === 0;
});
t('a sub-threshold jiggle is not a move', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'move', ev(0, 0)); H.onDragMove(ev(2, 1)); H.onDragEnd();
  return H.getRect(s, 't1').x === 100 && H.supp() === null;
});
t('a real move suppresses the click for that pane only', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'move', ev(0, 0)); H.onDragMove(ev(60, 60)); H.onDragEnd();
  return H.supp() === 't1';
});
t('starting a new drag clears a stale click suppression', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'move', ev(0, 0)); H.onDragMove(ev(60, 60)); H.onDragEnd();
  H.beginDrag(s, 't1', 'move', ev(0, 0)); const cleared = H.supp() === null; H.onDragEnd(); return cleared;
});

t('at 50% zoom the pane tracks the cursor 1:1 on screen', () => {
  // 100 screen px at 0.5 zoom = 200 canvas px; 100+200=300, snapped to 304.
  const s = mkState(0.5); H.beginDrag(s, 't1', 'move', ev(0, 0)); H.onDragMove(ev(100, 0)); H.onDragEnd();
  const r = H.getRect(s, 't1'); return r.x === 304 || ('x=' + r.x);
});
t('at 200% zoom the pane tracks the cursor 1:1 on screen', () => {
  const s = mkState(2); H.beginDrag(s, 't1', 'move', ev(0, 0)); H.onDragMove(ev(100, 0)); H.onDragEnd();
  const r = H.getRect(s, 't1'); return r.x === 152 || ('x=' + r.x);
});

t('the corner handle resizes both axes', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'br', ev(0, 0)); H.onDragMove(ev(80, 40)); H.onDragEnd();
  const r = H.getRect(s, 't1'); return (r.w === 480 && r.h === 344) || JSON.stringify(r);
});
t('the right handle resizes width only', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'r', ev(0, 0)); H.onDragMove(ev(80, 999)); H.onDragEnd();
  const r = H.getRect(s, 't1'); return (r.w === 480 && r.h === 300) || JSON.stringify(r);
});
t('the bottom handle resizes height only', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'b', ev(0, 0)); H.onDragMove(ev(999, 40)); H.onDragEnd();
  const r = H.getRect(s, 't1'); return (r.w === 400 && r.h === 344) || JSON.stringify(r);
});
t('resizing cannot go below the minimum', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'br', ev(0, 0)); H.onDragMove(ev(-9999, -9999)); H.onDragEnd();
  const r = H.getRect(s, 't1'); return r.w === H.MIN_W && r.h === H.MIN_H;
});
t('resizing leaves the origin alone', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'br', ev(0, 0)); H.onDragMove(ev(120, 120)); H.onDragEnd();
  const r = H.getRect(s, 't1'); return r.x === 100 && r.y === 100;
});

t('mid-drag canvas scrolling is compensated', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'move', ev(0, 0));
  s.wrap.scrollLeft = 50; s.wrap.scrollTop = 24; H.onDragMove(ev(0, 0)); H.onDragEnd();
  // 100+50=150 -> 152, 100+24=124 -> 128 after snapping to the 8px grid.
  const r = H.getRect(s, 't1'); return (r.x === 152 && r.y === 128) || JSON.stringify(r);
});
t('the remote window is notified once, on release', () => {
  fits = []; const s = mkState(); H.beginDrag(s, 't1', 'br', ev(0, 0));
  H.onDragMove(ev(40, 40)); H.onDragMove(ev(80, 80));
  const during = fits.filter(f => f === 'setWindow').length; H.onDragEnd();
  return during === 0 && fits.filter(f => f === 'setWindow').length === 1;
});
t('geometry is persisted on release', () => {
  remembered = []; const s = mkState(); H.beginDrag(s, 't1', 'move', ev(0, 0)); H.onDragMove(ev(64, 64)); H.onDragEnd();
  return remembered.length === 1;
});
t('an unmoved drag persists nothing', () => {
  remembered = []; const s = mkState(); H.beginDrag(s, 't1', 'move', ev(0, 0)); H.onDragEnd();
  return remembered.length === 0;
});
t('drags are ignored in column mode', () => {
  const s = mkState(); s.mode = 'columns'; H.beginDrag(s, 't1', 'move', ev(0, 0)); return H.peek() === null;
});
t('right-click does not start a drag', () => {
  const s = mkState(); H.beginDrag(s, 't1', 'move', ev(0, 0, 2)); return H.peek() === null;
});
t('stray pointer events with nothing active are harmless', () => {
  H.onDragMove(ev(10, 10)); H.onDragEnd(); H.onPanMove(ev(10, 10)); H.endPan(); return true;
});

t('panning scrolls the canvas opposite the drag', () => {
  const s = mkState(); s.wrap.scrollLeft = 300; s.wrap.scrollTop = 300;
  H.beginPan(s, ev(0, 0)); H.onPanMove(ev(-50, -40)); H.endPan();
  return (s.wrap.scrollLeft === 350 && s.wrap.scrollTop === 340) || s.wrap.scrollLeft + ',' + s.wrap.scrollTop;
});
t('panning cannot scroll to a negative offset', () => {
  const s = mkState(); H.beginPan(s, ev(0, 0)); H.onPanMove(ev(9999, 9999)); H.endPan();
  return s.wrap.scrollLeft === 0 && s.wrap.scrollTop === 0;
});
t('panning is ignored in column mode', () => {
  const s = mkState(); s.mode = 'columns'; H.beginPan(s, ev(0, 0)); return H.pan() === null;
});

t('zoom in raises the scale', () => { const s = mkState(); H.zoomAt(s, H.ZOOM_STEP, 500, 350); return s.zoom > 1; });
t('zoom out lowers the scale', () => { const s = mkState(); H.zoomAt(s, 1 / H.ZOOM_STEP, 500, 350); return s.zoom < 1; });
t('zoom clamps at both ends', () => {
  const s = mkState();
  for (let i = 0; i < 80; i++) H.zoomAt(s, H.ZOOM_STEP);
  const hi = s.zoom === H.ZOOM_MAX;
  for (let i = 0; i < 200; i++) H.zoomAt(s, 1 / H.ZOOM_STEP);
  return hi && s.zoom === H.ZOOM_MIN;
});
// Regression: with panes at canvas 0,0 the scroll clamp made zoom-out drift.
t('zooming out around centred content keeps the anchor exact', () => {
  const s = mkState();
  s.rects.set('t1', { x: 2000, y: 2000, w: 400, h: 300 });
  s.wrap.scrollLeft = 1800; s.wrap.scrollTop = 1800;
  const px = 300, py = 200;
  let worst = 0;
  for (let i = 0; i < 8; i++) {
    const before = (s.wrap.scrollLeft + px) / s.zoom;
    H.zoomAt(s, 1 / H.ZOOM_STEP, px, py);
    const after = (s.wrap.scrollLeft + px) / s.zoom;
    worst = Math.max(worst, Math.abs(after - before));
  }
  return worst < 0.5 || ('drift ' + worst.toFixed(2) + 'px');
});
t('zooming out from the canvas corner is where the old clamp bit', () => {
  const s = mkState();
  s.rects.set('t1', { x: 0, y: 0, w: 400, h: 300 });
  s.wrap.scrollLeft = 0; s.wrap.scrollTop = 0;
  // Anchor cannot be honoured at the corner — this documents why panes are
  // laid out at CANVAS_ORIGIN instead of the origin.
  const before = (s.wrap.scrollLeft + 300) / s.zoom;
  H.zoomAt(s, 1 / H.ZOOM_STEP, 300, 200);
  const after = (s.wrap.scrollLeft + 300) / s.zoom;
  return after !== before;
});

t('the point under the cursor stays put while zooming', () => {
  const s = mkState(); s.wrap.scrollLeft = 200; s.wrap.scrollTop = 100;
  const px = 400, py = 300;
  const before = ((s.wrap.scrollLeft + px) / s.zoom).toFixed(4);
  H.zoomAt(s, H.ZOOM_STEP, px, py);
  const after = ((s.wrap.scrollLeft + px) / s.zoom).toFixed(4);
  return before === after || ('before ' + before + ' after ' + after);
});
t('resetZoom returns to 100%', () => {
  const s = mkState(); H.zoomAt(s, H.ZOOM_STEP, 0, 0); H.setZoom(s, 1); return s.zoom === 1;
});
t('zoom is ignored in column mode', () => {
  const s = mkState(); s.mode = 'columns'; H.zoomAt(s, 2); return s.zoom === 1;
});

// --- performance guarantees (these are what made dragging feel laggy) ---

t('moving uses a compositor transform, not left/top writes', () => {
  const s = mkState(); const cell = s.cells.get('t1').cell;
  H.beginDrag(s, 't1', 'move', ev(0, 0));
  H.onDragMove(ev(80, 80));
  const usedTransform = /translate3d/.test(cell.style.transform || '');
  const touchedLeft = cell.style.left !== undefined && cell.style.left !== '';
  H.onDragEnd();
  return (usedTransform && !touchedLeft) || ('transform=' + cell.style.transform + ' left=' + cell.style.left);
});
t('the transform is swapped for real geometry on release', () => {
  const s = mkState(); const cell = s.cells.get('t1').cell;
  // 100 + 80 = 180, snapped to 184.
  H.beginDrag(s, 't1', 'move', ev(0, 0)); H.onDragMove(ev(80, 80)); H.onDragEnd();
  return (cell.style.transform === '' && cell.style.left === '184px') ||
    ('transform=' + cell.style.transform + ' left=' + cell.style.left);
});
t('50 pointermove events collapse into a single frame', () => {
  rafMode = 'queue'; rafQueue = [];
  const s = mkState();
  H.beginDrag(s, 't1', 'move', ev(0, 0));
  for (let i = 1; i <= 50; i++) H.onDragMove(ev(i * 2, i));
  const scheduled = rafQueue.length;
  rafQueue.forEach(f => f());   // flush the one frame
  rafQueue = []; rafMode = 'sync';
  // Only one frame scheduled, and it used the newest pointer (100 -> 200).
  const x = H.getRect(s, 't1') && (H.onDragEnd(), H.getRect(s, 't1').x);
  return (scheduled === 1 && x === 200) || ('scheduled=' + scheduled + ' x=' + x);
});
t('a drag never reads layout mid-gesture', () => {
  const s = mkState();
  let reads = 0;
  Object.defineProperty(s.wrap, 'clientWidth', { get() { reads++; return 1000; } });
  Object.defineProperty(s.wrap, 'clientHeight', { get() { reads++; return 700; } });
  H.beginDrag(s, 't1', 'move', ev(0, 0));
  const afterBegin = reads;
  for (let i = 0; i < 20; i++) H.onDragMove(ev(i * 5, i * 5));
  const duringDrag = reads - afterBegin;
  H.onDragEnd();
  return duringDrag === 0 || ('layout reads during drag: ' + duringDrag);
});
t('resize throttles the terminal reflow rather than fitting every frame', () => {
  fits = []; const s = mkState();
  H.beginDrag(s, 't1', 'br', ev(0, 0));
  for (let i = 1; i <= 20; i++) H.onDragMove(ev(i * 4, i * 4));
  const during = fits.filter(f => f === 'fit').length;
  H.onDragEnd();
  return during <= 2 || ('fits during resize: ' + during);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
