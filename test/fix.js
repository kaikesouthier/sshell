const __ROOT__ = require('path').join(__dirname, '..');
const fs=require('fs');
const R=(__ROOT__ + '/src/');
const src=fs.readFileSync(R+'sidebar.js','utf8');
let pass=0,fail=0;
const t=(n,c)=>{if(c===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n)}};

// Finding 1: the selection bar must never outlive the selection it describes.
t('clearSelection syncs the bar when the set is already empty',
  /if \(!RT\.selection\.size\) \{ renderSelectionBar\(\); return; \}/.test(src));
t('clearSelection(false) still repaints the selection bar',
  /if \(rerender !== false\) renderSidebar\(\);\s*\n\s*else renderSelectionBar\(\);/.test(src));
const endDrag=src.slice(src.indexOf('function endDrag'),src.indexOf('function dropZone'));
t('endDrag clears both drag ids and re-renders',
  /RT\.dragSessId = null; RT\.dragFolderId = null;/.test(endDrag)&&/renderSidebar\(\);/.test(endDrag));
t('every row wires dragend to endDrag so a cancelled drag cannot strand state',
  /addEventListener\('dragend', \(\) => endDrag\(el\)\)/.test(src));

// Finding 2: Open must be driven by the selection, not by what is rendered.
const fn=src.slice(src.indexOf('function resolveSelectedSessions'),src.indexOf('function sessionsInFolder'));
t('resolveSelectedSessions enumerates from the selection',/selectedSessionIds\(\)/.test(fn));
t('resolveSelectedSessions no longer filters by RT.rows membership',
  !/RT\.rows\.forEach\([\s\S]*RT\.selection\.has/.test(fn));
t('RT.rows is used only for display ordering',/rowOrder/.test(fn)&&/sort\(/.test(fn));

// Finding 3
const tools=fs.readFileSync(R+'tools.js','utf8');
const ident=tools.slice(tools.indexOf('function identifyService'),tools.indexOf('function buildPortScanner'));
t('identifyService returns its socket so Cancel can destroy it',/return sock;/.test(ident));

// Ordering behaviour in isolation
const RT={rows:[{type:'ses',id:'b'},{type:'ses',id:'a'}]},sel=['a','b','zz'];
const rowOrder=new Map(); RT.rows.forEach((r,i)=>rowOrder.set(r.type+':'+r.id,i));
const rank=id=>rowOrder.has('ses:'+id)?rowOrder.get('ses:'+id):Number.MAX_SAFE_INTEGER;
const store=new Map([['a',0],['b',1],['zz',2]]);
t('unrendered selections sort last but are still included',
  sel.slice().sort((x,y)=>(rank(x)-rank(y))||((store.get(x)||0)-(store.get(y)||0))).join()==='b,a,zz');

// SFTP must ignore internal sidebar drags, including the new folder drag
const sftp=fs.readFileSync(R+'sftp.js','utf8');
t('SFTP drop zone ignores folder drags',
  (sftp.match(/RT\.dragSessId \|\| RT\.dragFolderId \|\| RT\.dragTabId/g)||[]).length===4);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
