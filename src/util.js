
let idCounter = 1;

const $ = id => document.getElementById(id);

// Electron removed the non-standard File.path in v32; webUtils.getPathForFile is
// the replacement. Reading .path directly silently yields undefined, which made
// every picker and drop target look like it did nothing at all.
function filePath(file) {
    if (!file) return '';
    try {
        const { webUtils } = require('electron');
        if (webUtils && typeof webUtils.getPathForFile === 'function') {
            return webUtils.getPathForFile(file) || '';
        }
    } catch (e) {}
    return file.path || '';
}

function genId(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + (idCounter++).toString(36); }

// Hoisted: this runs several times per rendered row, and the inline object
// literal allocated a fresh map for every escaped character.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

function humanBytes(n) {
    if (n === undefined || n === null) return '-';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

function fmtMtime(sec) {
    if (!sec) return '-';
    const d = new Date(sec * 1000);
    return d.toLocaleDateString([], { year: '2-digit', month: 'short', day: '2-digit' }) + ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function pjoin(base, name) {
    if (name === '..') {
        if (base === '/' || !base) return '/';
        const p = base.replace(/\/+$/, '').split('/'); p.pop();
        return p.join('/') || '/';
    }
    if (!base) return '/' + name;
    return base.endsWith('/') ? base + name : base + '/' + name;
}
function pbase(p) { return p.replace(/\/+$/, '').split('/').pop() || p; }

function downloadText(name, text) {
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

module.exports = { $, genId, escapeHtml, humanBytes, fmtMtime, pjoin, pbase, downloadText, filePath };
