
const fs = require('fs');
const path = require('path');
const { $, escapeHtml, humanBytes, filePath } = require('./util');
const modal = require('./modal');
const dialog = require('./dialog');
const errors = require('./errors');

// Each server gets its files in order; several servers run at once. Going wider
// mostly queues work behind the slowest link while multiplying SSH channels.
const MAX_PARALLEL_SERVERS = 4;

let pending = null;

function gridMod() { return require('./grid'); }
function sftpMod() { return require('./sftp'); }

function start(state) {
    if (state.upload) return dialog.notify('An upload is already running.', { kind: 'warn' });
    const targets = gridMod().uploadTargets(state);
    if (!targets.length) {
        return dialog.notify(
            state.selected.size
                ? 'None of the selected servers are connected.'
                : 'Select the servers to upload to first — click their headers in the grid.',
            { kind: 'warn', title: 'No targets selected' }
        );
    }
    pending = { state };
    const picker = $('gridUploadPicker');
    picker.value = '';
    picker.click();
}

async function onPicked() {
    const picker = $('gridUploadPicker');
    const files = Array.from(picker.files || []).map(f => filePath(f)).filter(Boolean);
    picker.value = '';
    const ctx = pending; pending = null;
    if (!ctx || !files.length) return;
    const state = ctx.state;

    // The picker is modal but slow; a server can drop while it is open.
    const targets = gridMod().uploadTargets(state).filter(t => !t.closed && t.connected);
    if (!targets.length) return dialog.notify('Those servers are no longer connected.', { kind: 'warn' });

    let bytes = 0;
    const sizes = files.map(f => {
        try { const s = fs.statSync(f); bytes += s.size; return s.size; }
        catch (e) { return 0; }
    });

    const r = await modal.askInput({
        title: `Upload to ${targets.length} server${targets.length === 1 ? '' : 's'}`,
        message: `${files.length} file${files.length === 1 ? '' : 's'} (${humanBytes(bytes)}) will be sent to every target.\n` +
            'A relative path lands in each server\'s home directory. Missing directories are created.',
        okLabel: 'Continue',
        fields: [{ key: 'dest', label: 'Destination directory on each server', value: '.', placeholder: '/opt/app  or  .' }]
    });
    if (!r) return;
    const dest = (r.dest || '').trim() || '.';

    const total = files.length * targets.length;
    const names = targets.slice(0, 6).map(t => '· ' + t.title).join('\n') +
        (targets.length > 6 ? `\n· …and ${targets.length - 6} more` : '');
    const ok = await dialog.confirm(
        `Send ${files.length} file${files.length === 1 ? '' : 's'} to ${dest} on:\n\n${names}\n\n` +
        `${total} transfer${total === 1 ? '' : 's'}, ${humanBytes(bytes * targets.length)} total.`,
        { okLabel: `Upload to ${targets.length}`, danger: targets.length > 5 }
    );
    if (!ok) return;

    run(state, targets, files, sizes, bytes, dest);
}

function run(state, targets, files, sizes, perServerBytes, dest) {
    const grid = gridMod();
    const job = { cancelled: false, done: 0, total: files.length * targets.length, results: [], dest, fileCount: files.length };
    state.upload = job;
    grid.updateGridToolbar();
    setStatus(job);

    let idx = 0, active = 0, finished = false;

    function maybeFinish() {
        if (finished || active > 0 || (idx < targets.length && !job.cancelled)) return;
        finished = true;
        state.upload = null;
        // Clearing every cell here wiped the "failed" marker in the same tick it
        // was set for whichever server finished last. Leave failures on screen.
        const failedIds = new Set(job.results.filter(r => !r.ok && !(r.error && r.error.cancelled)).map(r => r.tabId));
        targets.forEach(t => { if (!failedIds.has(t.id)) grid.setCellProgress(state, t.id, null, null); });
        setTimeout(() => targets.forEach(t => grid.setCellProgress(state, t.id, null, null)), 8000);
        grid.updateGridToolbar();
        setStatus(null);
        report(job, targets.length);
    }

    function pump() {
        if (job.cancelled) return maybeFinish();
        while (active < MAX_PARALLEL_SERVERS && idx < targets.length) {
            const tab = targets[idx++];
            active++;
            uploadToServer(state, job, tab, files, sizes, perServerBytes, dest, () => {
                active--;
                setStatus(job);
                pump();
            });
        }
        if (!active) maybeFinish();
    }
    pump();
}

function uploadToServer(state, job, tab, files, sizes, perServerBytes, dest, done) {
    const grid = gridMod();
    const sftp = sftpMod();
    let sent = 0, i = 0, settled = false;

    const finish = (ok, error) => {
        if (settled) return; settled = true;
        job.results.push({ title: tab.title, tabId: tab.id, ok, error });
        if (ok) {
            grid.setCellProgress(state, tab.id, 100, '↑ done');
            setTimeout(() => grid.setCellProgress(state, tab.id, null, null), 2500);
        } else {
            grid.setCellProgress(state, tab.id, null, error && error.cancelled ? null : '↑ failed');
        }
        done();
    };

    if (tab.closed || !tab.connected) return finish(false, new Error('not connected'));

    sftp.ensureRemoteDir(tab, dest, err => {
        if (err) return finish(false, err);
        const nextFile = () => {
            if (job.cancelled) { const e = new Error('cancelled'); e.cancelled = true; return finish(false, e); }
            if (tab.closed || !tab.connected) return finish(false, new Error('connection lost'));
            if (i >= files.length) return finish(true);

            const local = files[i];
            const remote = dest.replace(/\/+$/, '') + '/' + path.basename(local);
            const baseSent = sent;

            // Keep the handle so Stop can abort the file that is already in
            // flight, rather than only stopping before the next one.
            job.active = job.active || new Map();
            const handle = sftp.putFile(tab, local, remote,
                transferred => {
                    const pct = perServerBytes ? Math.round(100 * (baseSent + transferred) / perServerBytes) : 0;
                    grid.setCellProgress(state, tab.id, pct, '↑ ' + pct + '%');
                },
                e => {
                    job.active.delete(tab.id);
                    if (e && e.cancelled) { const c = new Error('cancelled'); c.cancelled = true; return finish(false, c); }
                    if (e) return finish(false, e);
                    sent += sizes[i] || 0;
                    i++; job.done++;
                    setStatus(job);
                    nextFile();
                });
            job.active.set(tab.id, handle);
            if (job.cancelled) handle.cancel();
        };
        nextFile();
    });
}

function setStatus(job) {
    const el = $('gridUploadStatus');
    if (!el) return;
    if (!job) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.remove('hidden');
    const pct = job.total ? Math.round(100 * job.done / job.total) : 0;
    // Stop takes effect between files; a large transfer already in flight has to
    // finish, so say so rather than looking hung.
    el.textContent = job.cancelled
        ? `Stopping after the current file… ${job.done}/${job.total}`
        : `Uploading ${job.done}/${job.total} · ${pct}%`;
}

function report(job, serverCount) {
    const failed = job.results.filter(r => !r.ok && !(r.error && r.error.cancelled));
    const cancelled = job.results.filter(r => r.error && r.error.cancelled);
    const okCount = job.results.filter(r => r.ok).length;

    if (!failed.length && !cancelled.length) {
        return dialog.notify(
            `${job.fileCount} file${job.fileCount === 1 ? '' : 's'} uploaded to ${okCount} server${okCount === 1 ? '' : 's'} into ${job.dest}.`,
            { kind: 'success', title: 'Upload complete' }
        );
    }

    const lines = failed.slice(0, 8).map(r => '· ' + r.title + ' — ' + errors.describe(r.error).split('\n')[0]);
    if (failed.length > 8) lines.push(`· …and ${failed.length - 8} more`);

    dialog.notify(
        `Succeeded on ${okCount} of ${serverCount} server${serverCount === 1 ? '' : 's'}.` +
        (cancelled.length ? `\n${cancelled.length} cancelled.` : '') +
        (failed.length ? `\n\nFailed:\n${lines.join('\n')}` : ''),
        { kind: failed.length ? 'error' : 'warn', title: 'Upload finished with problems' }
    );
}

function init() {
    const picker = $('gridUploadPicker');
    if (picker) picker.addEventListener('change', () => errors.attempt(onPicked, 'gridupload'));
}

module.exports = { start, init };
