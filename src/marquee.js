
// Rubber-band selection shared by the SFTP list and the grid canvas.
// Rects are kept in client coordinates and compared with getBoundingClientRect,
// so scrolling and the canvas zoom transform are handled for free.
const THRESHOLD = 4;

let active = null;
let box = null;

function ensureBox() {
    if (box && box.isConnected) return box;
    box = document.createElement('div');
    box.className = 'marquee-box hidden';
    document.body.appendChild(box);
    return box;
}

function rectFrom(a, b) {
    return {
        left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
        right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y)
    };
}

function intersects(r, el) {
    const b = el.getBoundingClientRect();
    if (!b.width && !b.height) return false;
    return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
}

function paint(r) {
    const el = ensureBox();
    el.classList.remove('hidden');
    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
    el.style.width = (r.right - r.left) + 'px';
    el.style.height = (r.bottom - r.top) + 'px';
}

function hide() {
    if (box) { box.classList.add('hidden'); box.style.width = '0px'; box.style.height = '0px'; }
    document.documentElement.classList.remove('marquee-active');
}

// Restrict the band to what the user can actually see. Items scrolled out of
// the container still report rects on screen, so an unclipped band selected
// rows nobody could see — and a following bulk delete acted on them.
function clipTo(r, el) {
    if (!el) return r;
    const c = el.getBoundingClientRect();
    const out = {
        left: Math.max(r.left, c.left), top: Math.max(r.top, c.top),
        right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom)
    };
    if (out.right < out.left) out.right = out.left;
    if (out.bottom < out.top) out.bottom = out.top;
    return out;
}

// opts: { itemsSelector, root, clip, onSelect(elements, additive), onDone }
function begin(e, opts) {
    if (active) return;
    active = {
        start: { x: e.clientX, y: e.clientY },
        moved: false,
        // The grid uses Ctrl to START a band, so it cannot also mean "add to
        // the selection" there; it passes the flag explicitly instead.
        additive: typeof opts.additive === 'boolean' ? opts.additive : (e.ctrlKey || e.metaKey || e.shiftKey),
        opts
    };
}

function move(e) {
    if (!active) return;
    const r = rectFrom(active.start, { x: e.clientX, y: e.clientY });
    if (!active.moved) {
        // Ignore a plain click; only a real drag starts a selection.
        if ((r.right - r.left) + (r.bottom - r.top) < THRESHOLD) return;
        active.moved = true;
        document.documentElement.classList.add('marquee-active');
    }
    e.preventDefault();

    const root = active.opts.root;
    const band = clipTo(r, active.opts.clip || root);
    paint(band);

    if (!root) return;
    const hits = [];
    root.querySelectorAll(active.opts.itemsSelector).forEach(el => { if (intersects(band, el)) hits.push(el); });
    if (active.opts.onSelect) active.opts.onSelect(hits, active.additive);
}

function end() {
    const a = active;
    active = null;
    hide();
    if (a && a.moved && a.opts.onDone) a.opts.onDone();
    return !!(a && a.moved);
}

function isDragging() { return !!(active && active.moved); }
function isArmed() { return !!active; }

let installed = false;

function install() {
    // Called once per SFTP pane and once per grid tab. Without this guard every
    // pointermove ran the hit test again for each extra grid tab open.
    if (installed) return;
    installed = true;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    window.addEventListener('blur', end);
}

module.exports = { begin, end, install, isDragging, isArmed };
