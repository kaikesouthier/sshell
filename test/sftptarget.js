const __ROOT__ = require('path').join(__dirname, '..');
const fs = require('fs');
const src = fs.readFileSync((__ROOT__ + '/src/sftp.js'), 'utf8');
const grab = n => {
  const i = src.indexOf('function ' + n + '(');
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const body =
  'const sftpState={tabId:null,cwd:null,entries:[],selected:new Set(),anchor:null};\n' +
  'let clearedSelections=0;\n' +
  'function clearFileSelection(){clearedSelections++;sftpState.selected.clear();sftpState.anchor=null;return true;}\n' +
  ['getSftpTab', 'updateTargetLabel', 'clearTarget', 'focusTab', 'gridSelectedTab', 'sftpOnActiveChange']
    .map(grab).join('\n');

let RT = { tabs: [], activeTabId: null };
let opened = [], placeholders = [], label = { textContent: '', classList: { toggle() {} } };
let gridPick = null;

const H = new Function('RT', 'require', '$', 'setBusy', 'renderSftpPlaceholder', 'openSftpFor', 'errors',
  body + ';return {sftpOnActiveChange,focusTab,state:sftpState,cleared:()=>clearedSelections};')(
  RT,
  m => m === './tabs' ? { activeGrid: () => gridPick === undefined ? null : { interactiveTargets: () => gridPick ? [gridPick] : [] } }
    : { attempt: f => f(), record() {} },
  id => id === 'sftpTarget' ? label : { value: '', classList: { toggle() {} } },
  () => {}, m => placeholders.push(m), t => opened.push(t.id),
  { attempt: f => f(), record() {} });

let pass = 0, fail = 0;
const t = (n, c) => {
  try {
    const r = c();
    if (r === true) { pass++; console.log('  ok   ' + n); }
    else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
  } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

const term = (id, connected) => ({ id, type: 'terminal', closed: false, connected, title: id, sftpCwd: null });
const grid = id => ({ id, type: 'grid', closed: false, title: 'Grid' });
const reset = () => { opened = []; placeholders = []; H.state.tabId = null; H.state.cwd = null; gridPick = null; };

t('an active terminal tab is used directly', () => {
  reset();
  RT.tabs = [term('a', true), term('b', true)];
  RT.activeTabId = 'a';
  H.sftpOnActiveChange();
  return H.state.tabId === 'a' && opened.join() === 'a';
});
t('switching terminal tabs retargets SFTP', () => {
  reset();
  RT.tabs = [term('a', true), term('b', true)];
  RT.activeTabId = 'a'; H.sftpOnActiveChange();
  RT.activeTabId = 'b'; H.sftpOnActiveChange();
  return H.state.tabId === 'b' && opened.join() === 'a,b';
});
t('re-selecting the same tab does not reopen the channel', () => {
  reset();
  RT.tabs = [term('a', true)];
  RT.activeTabId = 'a'; H.sftpOnActiveChange(); H.sftpOnActiveChange();
  return opened.length === 1;
});
t('an unconnected active tab clears the pane', () => {
  reset();
  RT.tabs = [term('a', false)];
  RT.activeTabId = 'a'; H.sftpOnActiveChange();
  return H.state.tabId === null && /not connected/i.test(placeholders.join(' '));
});

t('with the grid in front, the selected server is used', () => {
  reset();
  const a = term('a', true);
  RT.tabs = [a, grid('g')];
  RT.activeTabId = 'g';
  gridPick = a;
  H.sftpOnActiveChange();
  return H.state.tabId === 'a' && opened.join() === 'a';
});
t('with the grid in front and nothing chosen, the pane explains what to do', () => {
  reset();
  RT.tabs = [term('a', true), grid('g')];
  RT.activeTabId = 'g';
  gridPick = null;
  H.sftpOnActiveChange();
  return H.state.tabId === null && /click a server in the grid/i.test(placeholders.join(' '));
});
t('switching to the grid keeps the server already being browsed', () => {
  reset();
  const a = term('a', true);
  RT.tabs = [a, grid('g')];
  RT.activeTabId = 'a'; H.sftpOnActiveChange();
  RT.activeTabId = 'g'; H.sftpOnActiveChange();
  return H.state.tabId === 'a' && opened.length === 1;
});
t('clicking a different grid cell retargets SFTP', () => {
  reset();
  const a = term('a', true), b = term('b', true);
  RT.tabs = [a, b, grid('g')];
  RT.activeTabId = 'g';
  H.focusTab('a'); H.focusTab('b');
  return H.state.tabId === 'b' && opened.join() === 'a,b';
});
t('focusTab ignores a disconnected server', () => {
  reset();
  RT.tabs = [term('a', false), grid('g')];
  RT.activeTabId = 'g';
  H.focusTab('a');
  return H.state.tabId === null && /not connected/i.test(placeholders.join(' '));
});
t('focusTab ignores an unknown tab id', () => {
  reset();
  RT.tabs = [term('a', true)];
  H.focusTab('ghost');
  return H.state.tabId === null && opened.length === 0;
});
t('focusTab refuses a grid tab', () => {
  reset();
  RT.tabs = [grid('g')];
  H.focusTab('g');
  return H.state.tabId === null;
});
t('if the browsed server drops, the grid selection takes over', () => {
  reset();
  const a = term('a', true), b = term('b', true);
  RT.tabs = [a, b, grid('g')];
  RT.activeTabId = 'a'; H.sftpOnActiveChange();
  a.connected = false;
  RT.activeTabId = 'g'; gridPick = b;
  H.sftpOnActiveChange();
  return H.state.tabId === 'b';
});
t('if the browsed server closes, the pane falls back cleanly', () => {
  reset();
  const a = term('a', true);
  RT.tabs = [a, grid('g')];
  RT.activeTabId = 'a'; H.sftpOnActiveChange();
  a.closed = true;
  RT.activeTabId = 'g';
  H.sftpOnActiveChange();
  return H.state.tabId === null;
});
t('the target label names the server being browsed', () => {
  reset();
  RT.tabs = [term('a', true)];
  RT.activeTabId = 'a'; H.sftpOnActiveChange();
  return label.textContent === 'a';
});

// A selection is made against one server's listing. Carried across a retarget,
// the names still matched rows on the new host, so a bulk Delete could act on
// files the user never picked, on a server they never picked them from.
t('switching servers drops the file selection', () => {
  reset();
  RT.tabs = [term('a', true), term('b', true)];
  RT.activeTabId = 'a'; H.sftpOnActiveChange();
  H.state.selected.add('.bashrc'); H.state.selected.add('notes.txt');
  H.state.anchor = '.bashrc';
  RT.activeTabId = 'b'; H.sftpOnActiveChange();
  return H.state.selected.size === 0 && H.state.anchor === null;
});
t('switching servers drops the stale listing too', () => {
  reset();
  RT.tabs = [term('a', true), term('b', true)];
  RT.activeTabId = 'a'; H.sftpOnActiveChange();
  H.state.entries = [{ name: 'from-server-a' }];
  RT.activeTabId = 'b'; H.sftpOnActiveChange();
  return H.state.entries.length === 0;
});
t('staying on the same server keeps the selection', () => {
  reset();
  RT.tabs = [term('a', true)];
  RT.activeTabId = 'a'; H.sftpOnActiveChange();
  H.state.selected.add('keep-me');
  const before = H.cleared();
  H.sftpOnActiveChange();
  return H.state.selected.size === 1 && H.cleared() === before;
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
