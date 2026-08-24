const __ROOT__ = require('path').join(__dirname, '..');
const fs=require('fs');
const S=require((__ROOT__ + '/src/store'));
const src=fs.readFileSync((__ROOT__ + '/src/menu.js'),'utf8');
const i=src.indexOf('function mergeImported');let d=0,j=src.indexOf('{',i),body;
for(let k=j;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d){body=src.slice(i,k+1);break}}}
const mergeImported=new Function('S','require',body+';return mergeImported;')(S,()=>({genId:p=>p+'_'+Math.random().toString(36).slice(2)}));
let pass=0,fail=0;
const t=(n,c)=>{const r=c();if(r===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(typeof r==='string'?' -> '+r:''))}};

S.store={folders:[],sessions:[]};
mergeImported({folders:[
  {id:'f1',name:'Prod',parentId:null,collapsed:true,icon:'rocket',iconColor:'#ff0000'},
  {id:'f2',name:'Sub',parentId:'f1',icon:'database',iconColor:'ok'}],
 sessions:[{id:'s1',folderId:'f2',label:'web',host:'h',icon:'server',iconColor:'warn',os:'Debian 12'}]});

t('folder icon survives import',()=>S.store.folders[0].icon==='rocket');
t('folder iconColor survives import',()=>S.store.folders[0].iconColor==='#ff0000');
t('nested folder keeps its icon too',()=>S.store.folders[1].icon==='database');
t('folder collapsed state is preserved',()=>S.store.folders[0].collapsed===true);
t('folder ids are remapped to fresh ones',()=>S.store.folders[0].id!=='f1'&&S.store.folders[1].id!=='f2');
t('parent link is remapped to the new child id',()=>S.store.folders[1].parentId===S.store.folders[0].id);
t('session keeps icon, color and os',()=>{const s=S.store.sessions[0];return s.icon==='server'&&s.iconColor==='warn'&&s.os==='Debian 12'});
t('session folderId is remapped',()=>S.store.sessions[0].folderId===S.store.folders[1].id);
t('a session in no folder stays ungrouped',()=>{
  S.store={folders:[],sessions:[]};
  mergeImported({folders:[],sessions:[{id:'x',folderId:null,host:'h'}]});
  return S.store.sessions[0].folderId===null;});
t('a session pointing at an unknown folder is ungrouped, not dangling',()=>{
  S.store={folders:[],sessions:[]};
  mergeImported({folders:[],sessions:[{id:'x',folderId:'ghost',host:'h'}]});
  return S.store.sessions[0].folderId===null;});
console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
