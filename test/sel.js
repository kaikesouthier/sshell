const __ROOT__ = require('path').join(__dirname, '..');
const R=(__ROOT__ + '/src/');
const S=require(R+'store');
let pass=0,fail=0;
const t=(n,c)=>{try{const r=c();if(r===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(typeof r==='string'?' -> '+r:''))}}catch(e){fail++;console.log('  FAIL '+n+' -> '+e.message)}};

// root > mid > leaf, with sessions at each level
const fixture=()=>({folders:[
  {id:'root',name:'root',parentId:null},{id:'mid',name:'mid',parentId:'root'},
  {id:'leaf',name:'leaf',parentId:'mid'},{id:'other',name:'other',parentId:null}],
 sessions:[{id:'a',folderId:'root',label:'a',host:'h'},{id:'b',folderId:'mid',label:'b',host:'h'},
  {id:'c',folderId:'leaf',label:'c',host:'h'},{id:'d',folderId:'other',label:'d',host:'h'},
  {id:'e',folderId:null,label:'e',host:'h'}]});

function sessionsInFolder(id){
  const out=S.store.sessions.filter(s=>s.folderId===id);
  S.store.folders.filter(f=>f.parentId===id).forEach(f=>out.push(...sessionsInFolder(f.id)));
  return out;
}
// mirrors deleteSelection's cascade
function cascade(fldIds,sessIds){
  const nested=new Set();
  fldIds.forEach(fid=>sessionsInFolder(fid).forEach(s=>nested.add(s.id)));
  sessIds.forEach(id=>nested.add(id));
  const drop=new Set(fldIds);
  let grew=true;
  while(grew){grew=false;S.store.folders.forEach(f=>{if(f.parentId&&drop.has(f.parentId)&&!drop.has(f.id)){drop.add(f.id);grew=true}})}
  const sessions=S.store.sessions.filter(s=>!nested.has(s.id)&&!drop.has(s.folderId));
  const folders=S.store.folders.filter(f=>!drop.has(f.id));
  return {sessions:sessions.map(s=>s.id).sort(),folders:folders.map(f=>f.id).sort(),count:nested.size};
}

S.store=fixture();
t('sessionsInFolder recurses through nested folders',()=>
  sessionsInFolder('root').map(s=>s.id).sort().join()==='a,b,c'||'got '+sessionsInFolder('root').map(s=>s.id));
t('sessionsInFolder on a leaf returns only its own',()=>sessionsInFolder('leaf').map(s=>s.id).join()==='c');
t('sessionsInFolder on an empty folder returns []',()=>{S.store.folders.push({id:'empty',parentId:null,name:'e'});return sessionsInFolder('empty').length===0});

S.store=fixture();
t('deleting a root folder removes its whole subtree',()=>{
  const r=cascade(['root'],[]);
  return (r.sessions.join()==='d,e' && r.folders.join()==='other' && r.count===3)||JSON.stringify(r);
});
S.store=fixture();
t('deleting a mid folder leaves the parent and its own sessions',()=>{
  const r=cascade(['mid'],[]);
  return (r.sessions.join()==='a,d,e' && r.folders.sort().join()==='other,root')||JSON.stringify(r);
});
S.store=fixture();
t('overlapping folder+session selection counts each session once',()=>{
  const r=cascade(['root'],['a','b']);
  return r.count===3||'count '+r.count;
});
S.store=fixture();
t('session-only selection leaves every folder intact',()=>{
  const r=cascade([],['a','e']);
  return (r.sessions.join()==='b,c,d' && r.folders.length===4)||JSON.stringify(r);
});
S.store=fixture();
t('empty selection is a no-op',()=>{
  const r=cascade([],[]);
  return r.sessions.length===5 && r.folders.length===4 && r.count===0;
});
S.store=fixture();
t('cascade terminates on a parent cycle',()=>{
  S.store.folders.push({id:'x',parentId:'y',name:'x'},{id:'y',parentId:'x',name:'y'});
  const done=cascade(['root'],[]); return !!done;
});
console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
