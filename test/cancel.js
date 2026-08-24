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
  'let transfers=[],xferSeq=1;const SFTP_OPEN_TIMEOUT=20000;\n' +
  ['addTransfer', 'transferById', 'openTransferChannel', 'closeChannel', 'discardPartial',
   'cancelTransfer', 'cancelAllTransfers', 'stepTransfer', 'finishTransfer', 'wasCancelled',
   'errCode'].map(grab).join('\n');

let unlinkedRemote = [], unlinkedLocal = [], rendered = 0, xferChannels = 0;
const H = new Function('fs', 'errors', 'ensureSftp', 'renderTransfers', 'sftpState', 'sftpRefresh', 'setTimeout', 'xfer', 'discardChannel',
  body + ';return {addTransfer,cancelTransfer,cancelAllTransfers,finishTransfer,stepTransfer,' +
  'wasCancelled,openTransferChannel,closeChannel,list:()=>transfers};')(
  { unlinkSync: p => unlinkedLocal.push(p) },
  { record() {} },
  (tab, cb) => cb(null, { unlink: (p, cb2) => { unlinkedRemote.push(p); cb2(null); } }),
  () => { rendered++; },
  { tabId: null },
  () => {},
  // Run the short deferred cleanup immediately, but leave long timers
  // (the 20s channel-open timeout) unfired.
  (fn, ms) => { if (!ms || ms < 1000) fn(); return 0; },
  // Transfers now open their channel on the dedicated connection.
  { clientFor: (tab, cb) => cb(null, { sftp: scb => { xferChannels++; scb(null, mkChannel()); } }, true) },
  () => {}
);

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
const reset = () => { unlinkedRemote = []; unlinkedLocal = []; H.list().length = 0; };

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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
