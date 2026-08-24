const __ROOT__ = require('path').join(__dirname, '..');
const S=require((__ROOT__ + '/src/store'));
let pass=0,fail=0;
const t=(n,c)=>{try{const r=c();if(r===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(typeof r==='string'?' -> '+r:''))}}catch(e){fail++;console.log('  FAIL '+n+' -> '+e.message)}};

const noCycles=r=>r.folders.every(f=>{
  const seen=new Set([f.id]); let p=f.parentId;
  while(p){ if(seen.has(p))return false; seen.add(p);
    const pf=r.folders.find(x=>x.id===p); if(!pf)return false; p=pf.parentId; }
  return true;
});
const reachable=r=>{const seen=new Set();
  const walk=p=>r.folders.filter(f=>f.parentId===p).forEach(f=>{if(seen.has(f.id))return;seen.add(f.id);walk(f.id)});
  walk(null); return seen.size;};

t('a folder that is its own parent is reattached to the root',()=>
  S.normalizeStore({folders:[{id:'a',parentId:'a'}]}).folders[0].parentId===null);
t('a two-folder cycle becomes a valid tree with both folders kept',()=>{
  const r=S.normalizeStore({folders:[{id:'a',parentId:'b'},{id:'b',parentId:'a'}]});
  return (noCycles(r)&&reachable(r)===2)||'cycles='+!noCycles(r)+' reachable='+reachable(r);
});
t('a three-folder cycle becomes a valid tree with all three kept',()=>{
  const r=S.normalizeStore({folders:[{id:'a',parentId:'c'},{id:'b',parentId:'a'},{id:'c',parentId:'b'}]});
  return (noCycles(r)&&reachable(r)===3)||'reachable='+reachable(r);
});
t('a folder pointing at a missing parent is reattached, not orphaned',()=>
  S.normalizeStore({folders:[{id:'a',parentId:'ghost'}]}).folders[0].parentId===null);
t('mixed corruption leaves every folder reachable from a root',()=>{
  const r=S.normalizeStore({folders:[
    {id:'a',parentId:'b'},{id:'b',parentId:'a'},{id:'c',parentId:'ghost'},
    {id:'d',parentId:null},{id:'e',parentId:'d'},{id:'f',parentId:'e'}]});
  return (noCycles(r)&&reachable(r)===6)||'reachable='+reachable(r)+'/6';
});
t('sessions in a repaired folder are still attached to it',()=>{
  const r=S.normalizeStore({folders:[{id:'a',parentId:'ghost'}],sessions:[{id:'s',folderId:'a',host:'h'}]});
  return r.sessions[0].folderId==='a';
});
t('a legitimate 90-level chain is preserved untouched',()=>{
  const folders=[];for(let i=0;i<90;i++)folders.push({id:'f'+i,parentId:i?'f'+(i-1):null});
  const r=S.normalizeStore({folders});
  return r.folders.filter(f=>!f.parentId).length===1 && r.folders[89].parentId==='f88' && noCycles(r);
});
t('90-level chain stays fully walkable end to end',()=>{
  const folders=[];for(let i=0;i<90;i++)folders.push({id:'f'+i,parentId:i?'f'+(i-1):null});
  const r=S.normalizeStore({folders});
  let n=0,cur=r.folders.find(f=>!f.parentId);
  while(cur){n++;cur=r.folders.find(f=>f.parentId===cur.id)}
  return n===90||'reached '+n;
});
t('a cycle buried at the end of a long chain is repaired',()=>{
  const folders=[];for(let i=0;i<50;i++)folders.push({id:'f'+i,parentId:i?'f'+(i-1):null});
  folders[0].parentId='f49';
  const r=S.normalizeStore({folders});
  return (noCycles(r)&&reachable(r)===50)||'reachable='+reachable(r);
});
console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
