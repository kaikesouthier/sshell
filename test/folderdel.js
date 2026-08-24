const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'src/store'));
const src = fs.readFileSync(path.join(ROOT, 'src/sidebar.js'), 'utf8');

const grab = n => {
  let i = src.indexOf('function ' + n + '(');
  // Keep a leading `async` — without it the extracted body has a bare await.
  if (src.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const body = ['folderSubtree', 'countFolderSessions', 'buildCounts', 'sessionsInFolder', 'deleteFolder']
  .map(grab).join('\n');

let confirmed = true, lastMsg = '';
const RT = { selection: new Set(), rows: [] };
const H = new Function('S', 'RT', 'dialog', 'renderSidebar', 'menuMod', 'key', 'countCache',
  body + ';return {folderSubtree,deleteFolder};')(
  S, RT,
  { confirm: async m => { lastMsg = m; return confirmed; } },
  () => {}, () => ({ renderTabMenu() {} }), (t, i) => t + ':' + i, null);

let pass = 0, fail = 0;
const t = async (n, c) => {
  try {
    const r = await c();
    if (r === true) { pass++; console.log('  ok   ' + n); }
    else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
  } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

// root ─ mid ─ leaf, sessions at every level, plus an untouched sibling tree
const fixture = () => {
  S.store = {
    folders: [
      { id: 'root', name: 'Root', parentId: null },
      { id: 'mid', name: 'Mid', parentId: 'root' },
      { id: 'leaf', name: 'Leaf', parentId: 'mid' },
      { id: 'other', name: 'Other', parentId: null }
    ],
    sessions: [
      { id: 's-root', folderId: 'root', host: 'h', label: 'root' },
      { id: 's-mid', folderId: 'mid', host: 'h', label: 'mid' },
      { id: 's-leaf', folderId: 'leaf', host: 'h', label: 'leaf' },
      { id: 's-other', folderId: 'other', host: 'h', label: 'other' },
      { id: 's-free', folderId: null, host: 'h', label: 'free' }
    ]
  };
  S.persist = () => true;
  confirmed = true; lastMsg = '';
};
const ids = a => a.map(x => x.id).sort().join(',');

(async () => {
  fixture();
  await t('folderSubtree collects the folder and all descendants',
    () => [...H.folderSubtree('root')].sort().join(',') === 'leaf,mid,root');
  await t('folderSubtree of a leaf is just itself',
    () => [...H.folderSubtree('leaf')].join(',') === 'leaf');

  fixture();
  await H.deleteFolder('root');
  await t('deleting a folder deletes the sessions inside it',
    () => ids(S.store.sessions) === 's-free,s-other' || ids(S.store.sessions));
  await t('and deletes its subfolders',
    () => ids(S.store.folders) === 'other' || ids(S.store.folders));
  await t('and leaves unrelated folders and sessions alone',
    () => !!S.store.folders.find(f => f.id === 'other') && !!S.store.sessions.find(s => s.id === 's-other'));

  fixture();
  await H.deleteFolder('mid');
  await t('deleting a mid-level folder removes only that branch',
    () => ids(S.store.sessions) === 's-free,s-other,s-root' || ids(S.store.sessions));
  await t('and keeps the parent',
    () => !!S.store.folders.find(f => f.id === 'root'));

  fixture();
  await H.deleteFolder('root');
  await t('the confirmation states what will be removed',
    () => /3 sessions/.test(lastMsg) && /2 subfolders/.test(lastMsg) || lastMsg);

  fixture();
  confirmed = false;
  await H.deleteFolder('root');
  await t('declining the confirmation deletes nothing',
    () => S.store.sessions.length === 5 && S.store.folders.length === 4);

  fixture();
  S.store.folders.push({ id: 'empty', name: 'Empty', parentId: null });
  await H.deleteFolder('empty');
  await t('an empty folder is removed without touching sessions',
    () => S.store.sessions.length === 5 && !S.store.folders.find(f => f.id === 'empty'));

  fixture();
  await H.deleteFolder('nope');
  await t('deleting a folder that does not exist is a no-op',
    () => S.store.sessions.length === 5 && S.store.folders.length === 4);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
