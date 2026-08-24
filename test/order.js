const __ROOT__ = require('path').join(__dirname, '..');
const fs=require('fs');
const S=require((__ROOT__ + '/src/store'));
const src=fs.readFileSync((__ROOT__ + '/src/sidebar.js'),'utf8');
const grab=n=>{const i=src.indexOf('function '+n+'(');let d=0,j=src.indexOf('{',i);for(let k=j;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(i,k+1)}}};
const body=['isDescendantFolder','wouldCycle','draggedFolderIds','orderForMove','spliceRelative','moveFolder','moveSession'].map(grab).join('\n');
let selF=[],selS=[],RT={rows:[]};
const H=new Function('S','RT','isSelected','selectedFolderIds','selectedSessionIds','dialog','renderSidebar',
  body+';return {moveFolder,moveSession};')(S,RT,
  (k,id)=>k==='fld'?selF.includes(id):selS.includes(id),()=>selF,()=>selS,{notify(){}},()=>{});

let pass=0,fail=0;
const t=(n,c)=>{const r=c();if(r===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(typeof r==='string'?' -> '+r:''))}};
const sess=()=>S.store.sessions.filter(s=>s.folderId==='P').map(s=>s.id).join();

const fixture=()=>{S.store={folders:[{id:'P',name:'Prod',parentId:null}],
  sessions:['a','b','c','d','e'].map(id=>({id,folderId:'P',label:id,host:'h'}))};
  RT.rows=[{type:'fld',id:'P'}].concat(['a','b','c','d','e'].map(id=>({type:'ses',id})));
  selF=[];selS=[];};

// Regression: dropping a row onto itself used to fling it to the bottom.
fixture(); H.moveSession('a',{folderId:'P',beforeId:'a'});
t('dropping a session on its own top edge is a no-op',()=>sess()==='a,b,c,d,e'||sess());
fixture(); H.moveSession('a',{folderId:'P',afterId:'a'});
t('dropping a session on its own bottom edge is a no-op',()=>sess()==='a,b,c,d,e'||sess());

// Regression: multi-select dropped on a co-selected neighbour went to the end.
fixture(); selS=['a','b','c'];
H.moveSession('a',{folderId:'P',beforeId:'b'});
t('multi-select dropped on a co-selected member is a no-op',()=>sess()==='a,b,c,d,e'||sess());

// Genuine reorders still work
fixture(); H.moveSession('a',{folderId:'P',beforeId:'d'});
t('moving one session before another reorders correctly',()=>sess()==='b,c,a,d,e'||sess());
fixture(); H.moveSession('e',{folderId:'P',beforeId:'a'});
t('moving the last session to the front works',()=>sess()==='e,a,b,c,d'||sess());
fixture(); H.moveSession('a',{folderId:'P',afterId:'e'});
t('moving the first session to the end works',()=>sess()==='b,c,d,e,a'||sess());
fixture(); selS=['a','b'];
H.moveSession('a',{folderId:'P',beforeId:'e'});
t('multi-select moves the group before an outside anchor',()=>sess()==='c,d,a,b,e'||sess());

// Regression: selected-but-unrendered sessions must still move.
fixture(); selS=['a','c','e'];
RT.rows=[{type:'fld',id:'P'},{type:'ses',id:'a'},{type:'ses',id:'c'}];  // 'e' filtered out of view
H.moveSession('a',{folderId:null});
t('a selected session that is not rendered still moves',()=>
  S.store.sessions.filter(s=>s.folderId===null).map(s=>s.id).sort().join()==='a,c,e'||
  S.store.sessions.filter(s=>s.folderId===null).map(s=>s.id).join());

// Folder equivalents
const folders=()=>S.store.folders.map(f=>f.id).join();
const ffix=()=>{S.store={folders:['A','B','C','D'].map(id=>({id,name:id,parentId:null})),sessions:[]};
  RT.rows=['A','B','C','D'].map(id=>({type:'fld',id}));selF=[];selS=[];};
ffix(); H.moveFolder('A',{parentId:null,beforeId:'A'});
t('dropping a folder on itself is a no-op',()=>folders()==='A,B,C,D'||folders());
ffix(); H.moveFolder('A',{parentId:null,beforeId:'D'});
t('reordering a folder before another works',()=>folders()==='B,C,A,D'||folders());
ffix(); selF=['A','B'];
H.moveFolder('A',{parentId:null,beforeId:'B'});
t('multi-folder drop on a co-selected member is a no-op',()=>folders()==='A,B,C,D'||folders());
ffix(); H.moveFolder('D',{parentId:null,afterId:'A'});
t('moving a folder after another works',()=>folders()==='A,D,B,C'||folders());

console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
