const __ROOT__ = require('path').join(__dirname, '..');
const fs=require('fs'),path=require('path'),os=require('os');
const src=fs.readFileSync((__ROOT__ + '/src/configpage.js'),'utf8');
const i=src.indexOf('async function changeDir');let d=0,j=src.indexOf('{',i),body;
for(let k=j;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d){body=src.slice(i,k+1);break}}}

let pass=0,fail=0;
const t=async(n,f)=>{try{if(await f()===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n)}}catch(e){fail++;console.log('  FAIL '+n+' -> '+e.message)}};

function harness(opts){
  let dataDir=opts.start, notes=[];
  const paths={getDataDir:()=>dataDir,setDataDir:d=>{dataDir=d},
    sessionsPath:()=>path.join(dataDir,'sessions.json'),configPath:()=>path.join(dataDir,'config.json')};
  const config={save(){ if(opts.cfgWrites!==false) fs.writeFileSync(paths.configPath(),'{}'); }};
  const S={persist(){ if(!opts.persistOk) return false;
    fs.writeFileSync(paths.sessionsPath(),'{"v":1}'); return true; }};
  const dialog={confirm:async()=>true,notify:async(m,o)=>{notes.push({m,kind:o&&o.kind});return true}};
  const ipcRenderer={invoke:async()=>({canceled:false,filePaths:[opts.target]})};
  const $=()=>({set value(v){},get value(){return ''}});
  const fn=new Function('fs','path','ipcRenderer','$','S','config','paths','dialog',
    body+';return changeDir;')(fs,path,ipcRenderer,$,S,config,paths,dialog);
  return {run:fn,dir:()=>dataDir,notes};
}

(async()=>{
  const base=path.join(os.tmpdir(),'sshell-cfg-'+Date.now());
  const good=path.join(base,'good'), start=path.join(base,'start');
  fs.mkdirSync(good,{recursive:true}); fs.mkdirSync(start,{recursive:true});

  let h=harness({start,target:good,persistOk:true});
  await h.run();
  await t('a successful move commits the new folder',()=>h.dir()===good);
  await t('and reports success',()=>h.notes.some(n=>n.kind==='success'));
  await t('and the vault really exists there',()=>fs.existsSync(path.join(good,'sessions.json')));

  const bad=path.join(base,'bad');
  h=harness({start,target:bad,persistOk:false});
  await h.run();
  await t('a failed vault write rolls the pointer back',()=>h.dir()===start);
  await t('and reports an error, not success',()=>h.notes.some(n=>n.kind==='error')&&!h.notes.some(n=>n.kind==='success'));
  await t('and names the folder still in use',()=>h.notes.some(n=>n.m.includes(start)));

  const half=path.join(base,'half'); fs.mkdirSync(half,{recursive:true});
  h=harness({start,target:half,persistOk:true,cfgWrites:false});
  await h.run();
  await t('a missing config file after write also rolls back',()=>h.dir()===start);

  fs.rmSync(base,{recursive:true,force:true});
  console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
})();
