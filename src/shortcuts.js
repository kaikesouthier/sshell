
const { $, escapeHtml } = require('./util');

// The help used to be one long paragraph blob in a small input dialog, which
// overflowed the window and pushed its own title and buttons off screen.
const SECTIONS = [
    {
        title: 'Tabs',
        rows: [
            { keys: [['Ctrl', 'T']], text: 'Open a saved session' },
            { keys: [['Ctrl', 'W']], text: 'Close the current tab' },
            { keys: [['Ctrl', 'PageUp'], ['Ctrl', 'PageDown']], text: 'Previous / next tab' },
            { keys: [['Ctrl', '1'], ['Ctrl', '9']], text: 'Jump to a tab — 9 is always the last one' },
            { mouse: 'Middle-click', text: 'Close a tab' },
            { mouse: 'Drag', text: 'Reorder tabs' }
        ]
    },
    {
        title: 'Active session',
        rows: [
            { keys: [['Ctrl', 'R']], text: 'Reconnect — works even when the session is healthy' },
            { keys: [['Ctrl', 'E']], text: 'Edit this session' },
            { note: 'A shell would normally use Ctrl+R for reverse history search and Ctrl+E to jump to end of line. SSHell takes both, so they no longer reach the remote shell.' }
        ]
    },
    {
        title: 'Sessions',
        rows: [
            { mouse: 'Click', text: 'Open' },
            { mouse: 'Right-click', text: 'Actions — open, edit, rename, delete' },
            { keys: [['Ctrl', 'Click']], text: 'Add to the selection' },
            { keys: [['Shift', 'Click']], text: 'Select a range' },
            { keys: [['Ctrl', 'A']], text: 'Select all' },
            { keys: [['Esc']], text: 'Clear the selection' }
        ]
    },
    {
        title: 'Folders',
        rows: [
            { mouse: 'Right-click', text: 'Actions, including Open all sessions and New subfolder' },
            { note: 'Nesting is unlimited. Dragging a folder takes everything inside it.' }
        ]
    },
    {
        title: 'Rearranging',
        rows: [
            { mouse: 'Drag onto a folder', text: 'Move it inside that folder' },
            { mouse: 'Drag onto a row edge', text: 'Place it above or below as a sibling' },
            { mouse: 'Drop on empty space', text: 'Move it back to the top level' }
        ]
    },
    {
        title: 'Grid canvas',
        rows: [
            { mouse: 'Drag background', text: 'Pan around the canvas' },
            { mouse: 'Middle-drag', text: 'Pan as well' },
            { keys: [['Space', 'Drag']], text: 'Pan as well' },
            { keys: [['Ctrl', 'Drag']], text: 'Rubber-band select panes' },
            { keys: [['Ctrl', 'Shift', 'Drag']], text: 'Add to the selected panes' },
            { mouse: 'Drag a pane header', text: 'Move that pane' },
            { mouse: 'Drag an edge or corner', text: 'Resize that pane' },
            { mouse: 'Wheel', text: 'Zoom about the cursor' },
            { keys: [['Shift', 'Wheel']], text: 'Scroll sideways' },
            { keys: [['+'], ['−'], ['0']], text: 'Zoom in, out, reset' },
            { note: 'Free Layout unlocks the canvas; Recenter re-flows the panes into a grid and brings them back into view; Columns returns to the fixed view. The canvas is endless and each pane remembers where you put it.' }
        ]
    },
    {
        title: 'Choosing targets',
        rows: [
            { mouse: 'Click a server header', text: 'Select that server in the grid' },
            { note: 'Interactive, Paste and Upload act on exactly the servers you have selected, never on everything. Armed servers pulse red.' }
        ]
    },
    {
        title: 'Files (SFTP)',
        rows: [
            { mouse: 'Click', text: 'Select a file' },
            { keys: [['Ctrl', 'Click']], text: 'Add to the selection' },
            { keys: [['Shift', 'Click']], text: 'Select a range' },
            { mouse: 'Drag empty space', text: 'Rubber-band select' },
            { mouse: 'Right-click', text: 'Actions — with several selected, bulk Download and Delete' }
        ]
    },
    {
        title: 'Panels',
        rows: [
            { mouse: 'Drag the sidebar edge', text: 'Resize it — Sessions and SFTP remember their own width' },
            { mouse: 'Drag the status bar edge', text: 'Resize it — tall enough and the metrics wrap instead of scrolling' },
            { mouse: 'Double-click either edge', text: 'Reset to the default size' },
            { keys: [['Esc']], text: 'Close the topmost dialog' }
        ]
    }
];

function kbd(k) { return `<kbd class="kbd">${escapeHtml(k)}</kbd>`; }
function combo(parts) { return parts.map(kbd).join('<span class="sc-plus">+</span>'); }

function rowHtml(r) {
    if (r.note) return `<p class="sc-note">${escapeHtml(r.note)}</p>`;
    const left = r.keys
        ? r.keys.map(combo).join('<span class="sc-or">or</span>')
        : `<span class="sc-mouse">${escapeHtml(r.mouse)}</span>`;
    return `<div class="sc-row"><div class="sc-keys">${left}</div><div class="sc-desc">${escapeHtml(r.text)}</div></div>`;
}

function render() {
    $('shortcutsBody').innerHTML = SECTIONS.map(s =>
        `<section class="sc-section"><h4 class="sc-title">${escapeHtml(s.title)}</h4>${s.rows.map(rowHtml).join('')}</section>`
    ).join('');
}

function open() {
    render();
    const m = $('shortcutsModal');
    m.classList.remove('hidden');
    $('shortcutsBody').scrollTop = 0;
    setTimeout(() => { const b = $('shortcutsDone'); if (b) b.focus(); }, 30);
}
function close() { $('shortcutsModal').classList.add('hidden'); }
function isOpen() { return !$('shortcutsModal').classList.contains('hidden'); }

function init() {
    const m = $('shortcutsModal');
    if (!m) return;
    $('shortcutsClose').addEventListener('click', close);
    $('shortcutsDone').addEventListener('click', close);
    m.addEventListener('mousedown', e => { if (e.target === m) close(); });
}

module.exports = { open, close, isOpen, init, SECTIONS };
