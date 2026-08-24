const __ROOT__ = require('path').join(__dirname, '..');
const S=require((__ROOT__ + '/src/store'));
let pass=0,fail=0;
const t=(n,c)=>{try{if(c()===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n)}}catch(e){fail++;console.log('  FAIL '+n+' -> '+e.message)}};
const ok=v=>{const r=S.normalizeStore(v);return Array.isArray(r.sessions)&&Array.isArray(r.folders)};

t('null',()=>ok(null));
t('undefined',()=>ok(undefined));
t('a number',()=>ok(42));
t('a string',()=>ok('nope'));
t('an empty object',()=>ok({}));
t('a bare array of sessions (legacy format)',()=>{
  const r=S.normalizeStore([{host:'h'}]);
  return r.sessions.length===1 && r.sessions[0].port===22 && !!r.sessions[0].id;
});
t('sessions that are null entries get dropped',()=>S.normalizeStore({sessions:[null,{host:'h'},undefined,5]}).sessions.length===1);
t('folders that are null entries get dropped',()=>S.normalizeStore({folders:[null,{name:'f'},'x']}).folders.length===1);
t('sessions is the wrong type',()=>ok({sessions:'no',folders:{}}));
t('a session pointing at a folder that does not exist becomes ungrouped',()=>
  S.normalizeStore({folders:[],sessions:[{host:'h',folderId:'ghost'}]}).sessions[0].folderId===null);
t('a garbage port falls back to 22',()=>S.normalizeStore({sessions:[{host:'h',port:'abc'}]}).sessions[0].port===22);
t('a numeric-string port is honoured',()=>S.normalizeStore({sessions:[{host:'h',port:'2222'}]}).sessions[0].port===2222);
t('authType is clamped to password unless it is exactly key',()=>
  S.normalizeStore({sessions:[{host:'h',authType:'evil'}]}).sessions[0].authType==='password');
t('a session with no host still gets a usable label',()=>!!S.normalizeStore({sessions:[{}]}).sessions[0].label);
t('every generated id is unique',()=>{
  const r=S.normalizeStore({sessions:[{host:'a'},{host:'b'},{host:'c'}]});
  return new Set(r.sessions.map(s=>s.id)).size===3;
});
console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
