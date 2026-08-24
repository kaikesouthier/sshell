const __ROOT__ = require('path').join(__dirname, '..');
const fs=require('fs');
const S=require((__ROOT__ + '/src/store'));
const src=fs.readFileSync((__ROOT__ + '/src/sidebar.js'),'utf8');
const grab=n=>{const i=src.indexOf('function '+n+'(');let d=0,j=src.indexOf('{',i);for(let k=j;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(i,k+1)}}};
// The shipped rollup, exactly as it runs in the app.
const buildCounts=new Function('S','return '+grab('buildCounts'))(S);

// Independent naive reference to check it against.
function ref(id,seen){seen=seen||new Set();if(seen.has(id))return 0;seen.add(id);
  let n=S.store.sessions.filter(s=>s.folderId===id).length;
  S.store.folders.filter(f=>f.parentId===id).forEach(f=>{n+=ref(f.id,seen)});return n}

let pass=0,fail=0;
const t=(n,c)=>{const r=c();if(r===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(typeof r==='string'?' -> '+r:''))}};
const agree=()=>{const m=buildCounts();
  const bad=S.store.folders.filter(f=>ref(f.id)!==m.get(f.id));
  return bad.length===0||bad.slice(0,3).map(f=>f.id+' ref='+ref(f.id)+' rollup='+m.get(f.id)).join(', ')};

S.store=S.normalizeStore({folders:[{id:'a',parentId:null},{id:'b',parentId:'a'},{id:'c',parentId:'b'},{id:'d',parentId:null}],
  sessions:[{id:'s1',folderId:'a',host:'h'},{id:'s2',folderId:'b',host:'h'},{id:'s3',folderId:'c',host:'h'},{id:'s4',folderId:null,host:'h'}]});
t('matches the reference on a nested tree',agree);
t('root total includes all descendants',()=>buildCounts().get('a')===3);
t('a folder with no sessions counts zero',()=>buildCounts().get('d')===0);
t('ungrouped sessions are excluded from every folder',()=>{
  const m=buildCounts();return [...m.values()].reduce((x,y)=>x+y,0)===3+2+1;});

S.store=S.normalizeStore({folders:[],sessions:[{id:'s',folderId:null,host:'h'}]});
t('handles a store with no folders',agree);
S.store=S.normalizeStore({folders:[{id:'f',name:'f'}],sessions:[]});
t('handles a store with no sessions',()=>buildCounts().get('f')===0);

{const folders=[],sessions=[];
 for(let i=0;i<90;i++)folders.push({id:'f'+i,parentId:i?'f'+(i-1):null});
 for(let i=0;i<600;i++)sessions.push({id:'s'+i,folderId:'f'+(i%90),host:'h'});
 S.store=S.normalizeStore({folders,sessions});}
t('matches on a 90-deep chain with 600 sessions',agree);
t('the deepest folder counts only its own',()=>buildCounts().get('f89')===Math.ceil(600/90)||buildCounts().get('f89')===Math.floor(600/90));

{const folders=[],sessions=[];
 for(let i=0;i<300;i++)folders.push({id:'f'+i,parentId:i>=8?('f'+(i%8)):(i?'f'+(i-1):null)});
 for(let i=0;i<2000;i++)sessions.push({id:'s'+i,folderId:'f'+(i%300),host:'h'});
 S.store=S.normalizeStore({folders,sessions});}
t('matches on a wide 300-folder / 2000-session tree',agree);

S.store={folders:[{id:'x',parentId:'y'},{id:'y',parentId:'x'},{id:'z',parentId:null}],sessions:[{id:'s',folderId:'x'}]};
t('terminates on a cyclic store instead of hanging',()=>buildCounts().size===3);

{const folders=[],sessions=[];
 for(let i=0;i<2000;i++)folders.push({id:'f'+i,parentId:i?'f'+(i-1):null});
 S.store={folders,sessions};}
t('a 2000-deep chain does not blow the stack (iterative post-order)',()=>buildCounts().size===2000);

{const folders=[],sessions=[];
 for(let i=0;i<90;i++)folders.push({id:'f'+i,parentId:i?'f'+(i-1):null});
 for(let i=0;i<600;i++)sessions.push({id:'s'+i,folderId:'f'+(i%90),host:'h'});
 S.store=S.normalizeStore({folders,sessions});}
let t0=process.hrtime.bigint();
for(let i=0;i<200;i++) S.store.folders.forEach(f=>ref(f.id));
const refMs=Number(process.hrtime.bigint()-t0)/1e6/200;
t0=process.hrtime.bigint();
for(let i=0;i<200;i++) buildCounts();
const newMs=Number(process.hrtime.bigint()-t0)/1e6/200;
console.log('\n  per render, 90-deep / 600 sessions:  naive '+refMs.toFixed(2)+' ms -> rollup '+newMs.toFixed(3)+' ms ('+Math.round(refMs/newMs)+'x)');
console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
