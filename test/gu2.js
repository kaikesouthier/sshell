const __ROOT__ = require('path').join(__dirname, '..');
const Module=require('module'),path=require('path');
const ROOT=(__ROOT__ + '/src/');
let changeHandler=null,notified=[];
const el=()=>({classList:{add(){},remove(){},toggle(){}},addEventListener(n,f){if(n==='change')changeHandler=f},click(){},style:{},textContent:'',value:'',files:[]});
const picker=el();
const stubs={
 './util':{$:id=>id==='gridUploadPicker'?picker:el(),escapeHtml:s=>s,humanBytes:n=>n+'B',filePath:x=>(x&&x.path)||''},
 './modal':{askInput:async()=>({dest:'/tmp'})},
 './dialog':{confirm:async()=>true,notify:async(m,o)=>{notified.push({m,o});return true}},
 './errors':{describe:e=>e&&e.message||'err',attempt:f=>f(),record(){}},
 './grid':{uploadTargets:()=>global.__targets,updateGridToolbar(){},setCellProgress(){}},
};
const orig=Module._load;
Module._load=function(req,parent){
  if(parent&&parent.filename.includes('gridupload')){ if(stubs[req])return stubs[req]; if(req==='./sftp')return global.__sftp; }
  if(req==='fs')return {statSync:()=>({size:1000})};
  return orig.apply(this,arguments);
};
const gu=require(ROOT+'gridupload'); gu.init();
let pass=0,fail=0;
const t=(n,c)=>{if(c===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(typeof c==='string'?' -> '+c:''))}};

(async()=>{
  global.__targets=Array.from({length:8},(_,i)=>({id:'t'+i,title:'srv'+i,closed:false,connected:true}));
  let puts=0;
  global.__sftp={
    ensureRemoteDir:(tab,d,cb)=>setTimeout(()=>cb(null),1),
    putFile:(tab,l,r,p,cb)=>{puts++;setTimeout(()=>cb(null),15)}
  };
  const state={selected:new Set(),cells:new Map(),upload:null};
  gu.start(state);
  picker.files=[{path:'/a/one.txt'},{path:'/a/two.txt'},{path:'/a/three.txt'}];
  const p=changeHandler();
  await new Promise(r=>setTimeout(r,30));
  t('job is running before cancel',!!state.upload);
  const before=puts;
  state.upload.cancelled=true;
  for(let i=0;i<200&&state.upload;i++) await new Promise(r=>setTimeout(r,10));
  t('cancel terminates the job (state.upload cleared)',state.upload===null);
  t('cancel stops further uploads (8x3=24 total, stopped early)',puts<24||'ran all '+puts);
  t('cancel still reports a summary',notified.length===1||'notifications: '+notified.length);
  t('cancelled summary is not reported as success',notified[0].o.kind!=='success'||notified[0].o.kind);
  await p;

  // completion must fire exactly once even when every server fails instantly
  notified=[];
  global.__sftp={ensureRemoteDir:(tab,d,cb)=>cb(new Error('nope')),putFile:(t2,l,r,p2,cb)=>cb(null)};
  const s2={selected:new Set(),cells:new Map(),upload:null};
  gu.start(s2);
  picker.files=[{path:'/a/one.txt'}];
  await changeHandler();
  for(let i=0;i<200&&s2.upload;i++) await new Promise(r=>setTimeout(r,5));
  t('all-servers-fail still completes',s2.upload===null);
  t('all-servers-fail reports exactly one summary',notified.length===1||'got '+notified.length);

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
