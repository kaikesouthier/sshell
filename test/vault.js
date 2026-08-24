const __ROOT__ = require('path').join(__dirname, '..');
const fs=require('fs'),path=require('path'),os=require('os');
const R=(__ROOT__ + '/src/');
const safefile=require(R+'safefile'), crypto=require(R+'crypto');
const dir=path.join(os.tmpdir(),'sshell-test-'+Date.now());
fs.mkdirSync(dir,{recursive:true});
const f=path.join(dir,'sessions.json');
let pass=0,fail=0;
const t=(n,c)=>{try{if(c()){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n)}}catch(e){fail++;console.log('  FAIL '+n+' -> '+e.message)}};

const store={folders:[{id:'f1',name:'Prod',parentId:null,collapsed:false}],
  sessions:[{id:'s1',folderId:'f1',label:'web',host:'10.0.0.1',port:22,username:'root',authType:'password',password:'p@ss "quoted" \ \n ünïcode 🔐'}]};

t('encrypt -> atomic write -> read -> decrypt round-trips',()=>{
  safefile.writeAtomic(f,JSON.stringify(crypto.encryptData(store,'master'),null,2));
  const back=crypto.decryptData(JSON.parse(safefile.readWithBackup(f).text),'master');
  return JSON.stringify(back)===JSON.stringify(store);
});
t('wrong passphrase throws, does not return garbage',()=>{
  try{crypto.decryptData(JSON.parse(fs.readFileSync(f,'utf8')),'wrong');return false}catch(e){return true}
});
t('second write creates .bak of previous contents',()=>{
  const first=fs.readFileSync(f,'utf8');
  safefile.writeAtomic(f,JSON.stringify(crypto.encryptData({folders:[],sessions:[]},'master'),null,2));
  return fs.readFileSync(f+'.bak','utf8')===first;
});
t('no .tmp files left behind',()=>fs.readdirSync(dir).filter(n=>n.includes('.tmp-')).length===0);
t('readWithBackup falls back to .bak when primary is gone',()=>{
  const bak=fs.readFileSync(f+'.bak','utf8');
  fs.unlinkSync(f);
  const r=safefile.readWithBackup(f);
  return r.fromBackup===true && r.text===bak;
});
t('readWithBackup throws when both are gone',()=>{
  fs.unlinkSync(f+'.bak');
  try{safefile.readWithBackup(f);return false}catch(e){return e.code==='ENOENT'}
});
t('writeAtomic creates missing parent directories',()=>{
  const deep=path.join(dir,'a','b','c.json');
  safefile.writeAtomic(deep,'{"x":1}');
  return fs.readFileSync(deep,'utf8')==='{"x":1}';
});
// Windows can still hold a handle briefly (indexer, AV), and a cleanup that
// throws would fail a run whose assertions all passed.
for(let i=0;i<5;i++){
  try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});break}catch(e){if(i===4)console.log('  note: temp dir not removed ('+e.code+')')}
}
console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
