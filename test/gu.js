const __ROOT__ = require('path').join(__dirname, '..');
const Module=require('module'),path=require('path');
const ROOT=(__ROOT__ + '/src/');
let changeHandler=null, notified=[], confirmAnswer=true, destAnswer='.';
const el=()=>({classList:{add(){},remove(){},toggle(){}},addEventListener(n,f){if(n==='change')changeHandler=f},
  click(){},style:{},set textContent(v){this._t=v},get textContent(){return this._t},set value(v){},get value(){return ''},files:[]});
const picker=el();

const gridCalls={progress:[]};
const stubs={
 './util':{$:id=>id==='gridUploadPicker'?picker:el(),escapeHtml:s=>s,humanBytes:n=>n+'B',filePath:x=>(x&&x.path)||''},
 './modal':{askInput:async()=>({dest:destAnswer})},
 './dialog':{confirm:async()=>confirmAnswer,notify:async(m,o)=>{notified.push({m,o});return true}},
 './errors':{describe:e=>e&&e.message||'err',attempt:f=>{try{return f()}catch(e){console.log('ATTEMPT THREW',e.message)}},record(){}},
 './grid':{uploadTargets:()=>global.__targets,updateGridToolbar(){},setCellProgress:(s,id,p,t)=>gridCalls.progress.push([id,p,t])},
};
const orig=Module._load;
Module._load=function(req,parent){
  if(stubs[req]&&parent&&parent.filename.includes('gridupload')) return stubs[req];
  if(req==='./sftp'&&parent&&parent.filename.includes('gridupload')) return global.__sftp;
  if(req==='fs') return {statSync:()=>({size:1000})};
  return orig.apply(this,arguments);
};
const gu=require(ROOT+'gridupload');
gu.init();

let pass=0,fail=0;
const t=(n,c)=>{if(c===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(typeof c==='string'?' -> '+c:''))}};

function mkTargets(n){return Array.from({length:n},(_,i)=>({id:'t'+i,title:'srv'+i,closed:false,connected:true}))}

async function scenario(opts){
  notified=[]; gridCalls.progress=[];
  global.__targets=mkTargets(opts.servers);
  const log={puts:[],maxActive:0,active:0,perServer:{}};
  global.__sftp={
    ensureRemoteDir:(tab,d,cb)=>setTimeout(()=>cb(opts.dirFail&&opts.dirFail(tab)?new Error('mkdir denied'):null),1),
    putFile:(tab,local,remote,onProg,cb)=>{
      log.active++; log.maxActive=Math.max(log.maxActive,log.active);
      (log.perServer[tab.id]=log.perServer[tab.id]||[]).push(local);
      log.puts.push(tab.id+':'+path.basename(local));
      onProg(500,1000);
      setTimeout(()=>{log.active--;cb(opts.putFail&&opts.putFail(tab,local)?new Error('EACCES denied'):null)},opts.delay||2);
    }
  };
  const state={selected:new Set(),cells:new Map(),upload:null};
  gu.start(state);
  picker.files=opts.files.map(f=>({path:f}));
  await changeHandler();
  // wait for the job to drain
  for(let i=0;i<400 && state.upload;i++) await new Promise(r=>setTimeout(r,10));
  if(opts.cancelAfterMs!==undefined){/*handled inline*/}
  return {state,log};
}

(async()=>{
  let r=await scenario({servers:3,files:['/a/one.txt','/a/two.txt']});
  t('uploads every file to every server (3x2=6)',r.log.puts.length===6||'got '+r.log.puts.length);
  t('each server receives both files in order',
    Object.values(r.log.perServer).every(v=>v.length===2&&path.basename(v[0])==='one.txt'&&path.basename(v[1])==='two.txt')||JSON.stringify(r.log.perServer));
  t('clears state.upload when finished',r.state.upload===null);
  t('reports success once',notified.length===1&&notified[0].o.kind==='success'||JSON.stringify(notified.map(n=>n.o.kind)));

  r=await scenario({servers:10,files:['/a/one.txt'],delay:8});
  t('never exceeds the 4-server concurrency cap',r.log.maxActive<=4||'peak '+r.log.maxActive);
  t('still reaches all 10 servers',r.log.puts.length===10||'got '+r.log.puts.length);
  t('completes and clears state.upload with more servers than the cap',r.state.upload===null);

  r=await scenario({servers:4,files:['/a/one.txt'],putFail:tab=>tab.id==='t1'});
  t('one failing server does not stop the others',r.log.puts.length===4||'got '+r.log.puts.length);
  t('finishes despite a failure',r.state.upload===null);
  t('reports the failure rather than success',notified.length===1&&notified[0].o.kind==='error'||JSON.stringify(notified.map(n=>n.o.kind)));
  t('names the failing server in the summary',/srv1/.test(notified[0].m)||notified[0].m);

  r=await scenario({servers:3,files:['/a/one.txt'],dirFail:tab=>tab.id==='t0'});
  t('a server whose destination cannot be created is skipped, not fatal',r.log.puts.length===2||'got '+r.log.puts.length);
  t('finishes after a mkdir failure',r.state.upload===null);

  confirmAnswer=false;
  r=await scenario({servers:3,files:['/a/one.txt']});
  t('declining the confirm uploads nothing',r.log.puts.length===0);
  t('declining leaves no job running',r.state.upload===null);
  confirmAnswer=true;

  r=await scenario({servers:2,files:[]});
  t('no files selected is a no-op',r.log.puts.length===0&&r.state.upload===null);

  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})();
