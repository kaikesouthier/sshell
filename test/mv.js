const __ROOT__ = require('path').join(__dirname, '..');
const fs=require('fs');
const S=require((__ROOT__ + '/src/store'));
const src=fs.readFileSync((__ROOT__ + '/src/sidebar.js'),'utf8');
const grab=n=>{const i=src.indexOf('function '+n+'(');let d=0,j=src.indexOf('{',i);for(let k=j;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(i,k+1)}}};
const body=['isDescendantFolder','wouldCycle','draggedFolderIds','orderForMove','spliceRelative','moveFolder','moveSession'].map(grab).join('\n');
let selFolders=[],selSessions=[],warned=null,RT={rows:[]};
const ctx=new Function('S','RT','isSelected','selectedFolderIds','selectedSessionIds','dialog','renderSidebar',
  body+';return {moveFolder,moveSession,wouldCycle};');
const H=ctx(S,RT,
  (k,id)=>k==='fld'?selFolders.includes(id):selSessions.includes(id),
  ()=>selFolders,()=>selSessions,
  {notify:m=>{warned=m}},()=>{});

let pass=0,fail=0;
const t=(n,c)=>{try{const r=c();if(r===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(typeof r==='string'?' -> '+r:''))}}catch(e){fail++;console.log('  FAIL '+n+' -> '+e.message)}};

const tree=()=>{S.store={folders:[
  {id:'a',name:'a',parentId:null},{id:'b',name:'b',parentId:null},{id:'c',name:'c',parentId:null},
  {id:'a1',name:'a1',parentId:'a'}],sessions:[{id:'s1',folderId:'a',host:'h'},{id:'s2',folderId:null,host:'h'}]};
  selFolders=[];selSessions=[];warned=null;RT.rows=[];};
const order=()=>S.store.folders.map(f=>f.id).join();
const parent=id=>(S.store.folders.find(f=>f.id===id)||{}).parentId;
const valid=()=>{const seen=new Set();
  const walk=p=>S.store.folders.filter(f=>f.parentId===p).forEach(f=>{if(seen.has(f.id))return;seen.add(f.id);walk(f.id)});
  walk(null);return seen.size===S.store.folders.length;};

tree(); H.moveFolder('c',{parentId:null,beforeId:'a'});
t('reorder to the front puts c first and keeps the tree valid',()=>order()==='c,a,b,a1'&&valid()||order());
tree(); H.moveFolder('a',{parentId:null,afterId:'c'});
t('reorder to the end places a after c',()=>order()==='b,c,a,a1'&&valid()||order());
tree(); H.moveFolder('b',{parentId:'a'});
t('nesting b under a reparents it',()=>parent('b')==='a'&&valid());
tree(); H.moveFolder('a1',{parentId:null});
t('dragging a child to the root clears its parent',()=>parent('a1')===null&&valid());
tree(); H.moveFolder('a',{parentId:'a1'});
t('a cycle is refused and the tree is untouched',()=>parent('a')===null&&/inside itself/.test(warned||'')&&valid());
tree(); H.moveFolder('a',{parentId:'a'});
t('self-nesting is refused',()=>parent('a')===null&&!!warned);

tree(); H.moveFolder('a',{parentId:'b'});
t('moving a parent carries its child along',()=>parent('a')==='b'&&parent('a1')==='a'&&valid());
t('sessions stay attached through a reparent',()=>S.store.sessions.find(s=>s.id==='s1').folderId==='a');

tree(); selFolders=['a','b']; RT.rows=[{type:'fld',id:'a'},{type:'fld',id:'b'}];
H.moveFolder('a',{parentId:'c'});
t('multi-select folder drag moves every selected folder',()=>parent('a')==='c'&&parent('b')==='c'&&valid());
tree(); selFolders=['a','a1'];
H.moveFolder('a',{parentId:'b'});
t('dragging a parent with its own child does not duplicate the move',()=>
  parent('a')==='b'&&parent('a1')==='a'&&S.store.folders.length===4&&valid());

tree(); H.moveFolder('a',{parentId:null,beforeId:'a'});
t('dropping a folder onto itself leaves the order intact',()=>valid()&&S.store.folders.length===4);

tree(); H.moveSession('s2',{folderId:'a'});
t('moveSession still reparents a session',()=>S.store.sessions.find(s=>s.id==='s2').folderId==='a');
tree(); H.moveSession('s1',{folderId:null,afterId:'s2'});
t('moveSession honours afterId ordering',()=>S.store.sessions.map(s=>s.id).join()==='s2,s1');

console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
