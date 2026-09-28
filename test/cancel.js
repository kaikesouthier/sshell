// Transfer cancellation: each transfer owns its channel, cancelling aborts only
// that one, and the partial file is removed afterwards.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src/sftp.js'), 'utf8');

const grab = n => {
  let i = src.indexOf('function ' + n + '(');
  if (src.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};

const body =
  'let transfers=[],xferSeq=1;const SFTP_OPEN_TIMEOUT=20000;const CANCEL_GRACE_MS=3000;\n' +
  ['addTransfer', 'transferById', 'openTransferChannel', 'closeChannel', 'discardPartial',
   'cancelTransfer', 'cancelAllTransfers', 'stepTransfer', 'finishTransfer', 'wasCancelled',
   'errCode', 'guardedAttempt'].map(grab).join('\n');

let unlinkedRemote = [], unlinkedLocal = [], rendered = 0, xferChannels = 0, pendingTimers = [];
const H = new Function('fs', 'errors', 'ensureSftp', 'renderTransfers', 'sftpState', 'sftpRefresh', 'setTimeout', 'clearTimeout', 'xfer', 'discardChannel',
  body + ';return {addTransfer,cancelTransfer,cancelAllTransfers,finishTransfer,stepTransfer,' +
  'wasCancelled,openTransferChannel,closeChannel,guardedAttempt,list:()=>transfers};')(
  { unlinkSync: p => unlinkedLocal.push(p) },
  { record() {} },
  (tab, cb) => cb(null, { unlink: (p, cb2) => { unlinkedRemote.push(p); cb2(null); } }),
  () => { rendered++; },
  { tabId: null },
  () => {},
  // Run the short deferred cleanup immediately; long timers (the 20s
  // channel-open timeout, the cancel watchdog) are held for firePending().
  (fn, ms) => { if (!ms || ms < 1000) { fn(); return 0; } pendingTimers.push({ fn, ms }); return pendingTimers.length; },
  id => { if (id > 0 && pendingTimers[id - 1]) pendingTimers[id - 1].fn = null; },
  // Transfers now open their channel on the dedicated connection.
  { clientFor: (tab, cb) => cb(null, { sftp: scb => { xferChannels++; scb(null, mkChannel()); } }, true) },
  () => {}
);
// Fire every held timer of the given length (the cancel watchdog is 3000ms).
const firePending = ms => {
  const due = pendingTimers.filter(p => p.fn && p.ms === ms);
  due.forEach(p => { const fn = p.fn; p.fn = null; fn(); });
  return due.length;
};

let pass = 0, fail = 0;
const t = (n, c) => {
  try {
    const r = c();
    if (r === true) { pass++; console.log('  ok   ' + n); }
    else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
  } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

const mkChannel = () => { const c = { ended: false, destroyed: false }; c.end = () => { c.ended = true; }; c.destroy = () => { c.destroyed = true; }; return c; };
const mkTab = () => ({ id: 'tab1', closed: false, connected: true, client: {}, title: 'srv' });
const reset = () => { unlinkedRemote = []; unlinkedLocal = []; H.list().length = 0; pendingTimers = []; };
// A channel that is also an EventEmitter, as ssh2's SFTP channel is.
const mkEmitChannel = () => {
  const c = mkChannel(), ls = {};
  c.once = (ev, fn) => { (ls[ev] = ls[ev] || []).push(fn); };
  c.removeListener = (ev, fn) => { ls[ev] = (ls[ev] || []).filter(f => f !== fn); };
  c.emit = ev => { const l = ls[ev] || []; ls[ev] = []; l.forEach(f => f()); };
  c.listeners = ev => (ls[ev] || []).length;
  return c;
};

reset();
t('a new transfer starts active and not cancelled', () => {
  const x = H.addTransfer('a.bin', 'up', 100);
  return x.status === 'active' && x.cancelled === false;
});

reset();
t('cancelling marks it cancelling and ends its channel', () => {
  const x = H.addTransfer('a.bin', 'up', 100);
  const ch = mkChannel(); x.channel = ch; x.tab = mkTab(); x.remote = '/srv/a.bin';
  H.cancelTransfer(x.id);
  return x.cancelled === true && x.status === 'cancelling' && ch.ended === true;
});

reset();
t('a cancelled UPLOAD deletes the partial file on the server', () => {
  const x = H.addTransfer('a.bin', 'up', 100);
  x.channel = mkChannel(); x.tab = mkTab(); x.remote = '/srv/a.bin';
  x.wrote = true;                       // fastPut has truncated the target
  H.cancelTransfer(x.id);
  H.finishTransfer(x, new Error('aborted'));
  return unlinkedRemote.join() === '/srv/a.bin' || ('remote unlinks: ' + unlinkedRemote.join());
});

reset();
// Cancelling during the connect phase must not touch the server: fastPut never
// ran, so the only file with that name is the one that was already there.
t('cancelling an UPLOAD before it writes leaves the existing file alone', () => {
  const x = H.addTransfer('a.bin', 'up', 100);
  x.channel = mkChannel(); x.tab = mkTab(); x.remote = '/srv/a.bin';
  H.cancelTransfer(x.id);
  H.finishTransfer(x, null);
  return unlinkedRemote.length === 0 || ('remote unlinks: ' + unlinkedRemote.join());
});

reset();
t('a cancelled DOWNLOAD deletes the partial local file', () => {
  const x = H.addTransfer('a.bin', 'down', 100);
  x.channel = mkChannel(); x.tab = mkTab(); x.local = 'C:/tmp/a.bin'; x.remote = '/srv/a.bin';
  H.cancelTransfer(x.id);
  H.finishTransfer(x, new Error('aborted'));
  return unlinkedLocal.join() === 'C:/tmp/a.bin' && unlinkedRemote.length === 0;
});

reset();
t('a cancelled save-back does NOT delete the remote file', () => {
  const x = H.addTransfer('conf (save)', 'up', 100);
  x.channel = mkChannel(); x.tab = mkTab(); x.remote = '/etc/app.conf'; x.local = 'C:/tmp/x';
  x.keepRemoteOnCancel = true;
  H.cancelTransfer(x.id);
  H.finishTransfer(x, new Error('aborted'));
  return unlinkedRemote.length === 0 || ('deleted ' + unlinkedRemote.join());
});

reset();
t('a completed transfer deletes nothing', () => {
  const x = H.addTransfer('a.bin', 'up', 100);
  x.channel = mkChannel(); x.tab = mkTab(); x.remote = '/srv/a.bin';
  H.finishTransfer(x, null);
  return x.status === 'done' && unlinkedRemote.length === 0 && unlinkedLocal.length === 0;
});

reset();
t('a failed transfer deletes nothing and reports failure', () => {
  const x = H.addTransfer('a.bin', 'up', 100);
  x.channel = mkChannel(); x.tab = mkTab(); x.remote = '/srv/a.bin';
  H.finishTransfer(x, new Error('disk full'));
  return x.status === 'error' && unlinkedRemote.length === 0;
});

reset();
t('finishing always closes the transfer channel', () => {
  const x = H.addTransfer('a.bin', 'up', 100);
  const ch = mkChannel(); x.channel = ch; x.tab = mkTab();
  H.finishTransfer(x, null);
  return ch.ended === true && x.channel === null;
});

reset();
t('cancelling one transfer leaves the others running', () => {
  const a = H.addTransfer('a', 'up', 100), b = H.addTransfer('b', 'up', 100);
  const ca = mkChannel(), cb = mkChannel();
  a.channel = ca; b.channel = cb; a.tab = mkTab(); b.tab = mkTab();
  H.cancelTransfer(a.id);
  return ca.ended === true && cb.ended === false && b.status === 'active';
});

reset();
t('cancelling twice is harmless', () => {
  const x = H.addTransfer('a', 'up', 100);
  x.channel = mkChannel(); x.tab = mkTab();
  H.cancelTransfer(x.id); H.cancelTransfer(x.id);
  return x.status === 'cancelling';
});
t('cancelling an unknown id is harmless', () => { H.cancelTransfer(99999); return true; });

reset();
t('a finished transfer cannot be cancelled afterwards', () => {
  const x = H.addTransfer('a', 'up', 100);
  x.channel = mkChannel(); x.tab = mkTab();
  H.finishTransfer(x, null);
  H.cancelTransfer(x.id);
  return x.status === 'done' && unlinkedRemote.length === 0;
});

reset();
t('cancel all stops every active transfer', () => {
  const a = H.addTransfer('a', 'up', 100), b = H.addTransfer('b', 'down', 100), c = H.addTransfer('c', 'up', 100);
  [a, b, c].forEach(x => { x.channel = mkChannel(); x.tab = mkTab(); });
  H.finishTransfer(c, null);              // already done
  H.cancelAllTransfers();
  return a.cancelled && b.cancelled && c.status === 'done';
});

reset();
t('openTransferChannel refuses a disconnected tab', () => {
  let got = null;
  H.openTransferChannel({ closed: false, connected: false, client: {} }, e => { got = e; });
  return !!got && /Not connected/.test(got.message);
});
t('openTransferChannel refuses a closed tab', () => {
  let got = null;
  H.openTransferChannel({ closed: true, connected: true, client: {} }, e => { got = e; });
  return !!got;
});
t('openTransferChannel opens a fresh channel per call', () => {
  // Channels now come from the dedicated transfer connection, not the tab's
  // own client, but each transfer must still get its own so cancelling one
  // cannot abort another.
  xferChannels = 0;
  const tab = { closed: false, connected: true, client: {} };
  H.openTransferChannel(tab, () => {});
  H.openTransferChannel(tab, () => {});
  return xferChannels === 2;
});

reset();
t('progress updates the transfer without ending it', () => {
  const x = H.addTransfer('a', 'up', 1000);
  x._lastTime = Date.now() - 1000;
  H.stepTransfer(x, 500, 1000);
  return x.done === 500 && x.status === 'active';
});

// --- transfers that ssh2 never calls back ---
// fastGet/fastPut only call back once the server answers. A dropped
// connection never answers, so the transfer froze and Cancel then sat on
// "cancelling…" for good.

reset();
t('a channel that closes without calling back fails the transfer', () => {
  const x = H.addTransfer('a.bin', 'down', 100);
  const ch = mkEmitChannel(); x.channel = ch; x.tab = mkTab();
  let got;
  H.guardedAttempt(x, ch, () => { /* ssh2 never calls back */ })(e => { got = e; });
  ch.emit('close');                        // the socket died
  return got instanceof Error && /closed before the transfer finished/.test(got.message);
});

reset();
t('a channel that closes after a cancel settles the attempt as cancelled, not failed', () => {
  const x = H.addTransfer('a.bin', 'down', 100);
  const ch = mkEmitChannel(); x.channel = ch; x.tab = mkTab();
  let got = 'unset';
  H.guardedAttempt(x, ch, () => {})(e => { got = e; });
  H.cancelTransfer(x.id);
  ch.emit('close');                        // the server acknowledged the close
  return got === null && x.status === 'cancelling';
});

reset();
t('a normal completion stops listening for the close', () => {
  const x = H.addTransfer('a.bin', 'down', 100);
  const ch = mkEmitChannel(); x.channel = ch; x.tab = mkTab();
  let calls = 0;
  H.guardedAttempt(x, ch, done => done(null))(() => { calls++; });
  ch.emit('close');                        // finishTransfer closes the channel afterwards
  return calls === 1 && ch.listeners('close') === 0 && x.settle === null;
});

reset();
t('an attempt on an already-cancelled transfer never touches the channel', () => {
  const x = H.addTransfer('a.bin', 'up', 100);
  const ch = mkEmitChannel(); x.tab = mkTab();
  x.cancelled = true;
  let ran = false, got = 'unset';
  H.guardedAttempt(x, ch, () => { ran = true; })(e => { got = e; });
  return !ran && got === null;
});

reset();
t('a cancel that the server never acknowledges is settled by the watchdog', () => {
  const x = H.addTransfer('a.bin', 'down', 100);
  const ch = mkEmitChannel(); x.channel = ch; x.tab = mkTab(); x.local = 'C:/tmp/a.bin';
  let got = 'unset';
  H.guardedAttempt(x, ch, () => {})(e => { got = e; H.finishTransfer(x, e); });
  H.cancelTransfer(x.id);
  if (x.status !== 'cancelling') return 'expected cancelling, got ' + x.status;
  const fired = firePending(3000);         // the connection is dead: no close ever comes
  return fired === 1 && got === null && x.status === 'cancelled' && unlinkedLocal.join() === 'C:/tmp/a.bin';
});

reset();
t('cancelling while the channel is still being opened does not wait on it', () => {
  const x = H.addTransfer('a.bin', 'up', 100);
  x.tab = mkTab(); x.remote = '/srv/a.bin';        // no channel yet
  H.cancelTransfer(x.id);
  firePending(3000);
  return x.status === 'cancelled' && unlinkedRemote.length === 0;
});

reset();
t('a transfer settled before the watchdog fires is not settled twice', () => {
  const x = H.addTransfer('a.bin', 'down', 100);
  const ch = mkEmitChannel(); x.channel = ch; x.tab = mkTab(); x.local = 'C:/tmp/a.bin';
  H.guardedAttempt(x, ch, () => {})(e => H.finishTransfer(x, e));
  H.cancelTransfer(x.id);
  ch.emit('close');
  const fired = firePending(3000);
  return fired === 0 && x.status === 'cancelled' && unlinkedLocal.length === 1;
});

reset();
t('finishing a transfer twice deletes the partial only once', () => {
  const x = H.addTransfer('a.bin', 'up', 100);
  x.channel = mkChannel(); x.tab = mkTab(); x.remote = '/srv/a.bin'; x.wrote = true;
  H.cancelTransfer(x.id);
  H.finishTransfer(x, new Error('aborted'));
  H.finishTransfer(x, new Error('aborted again'));
  return x.status === 'cancelled' && unlinkedRemote.length === 1;
});

reset();
t('a late error cannot overwrite a finished transfer', () => {
  const x = H.addTransfer('a.bin', 'up', 100);
  x.channel = mkChannel(); x.tab = mkTab();
  H.finishTransfer(x, null);
  H.finishTransfer(x, new Error('No response from server'));
  return x.status === 'done';
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
