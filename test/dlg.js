const __ROOT__ = require('path').join(__dirname, '..');
const Module=require('module');
const mk=()=>({classList:{add(){},remove(){},toggle(){}},addEventListener(){},focus(){},
  set innerHTML(v){},set textContent(v){this._t=v},get textContent(){return this._t},
  set className(v){},get className(){return ''}});
const els={};
global.document={getElementById:id=>els[id]||(els[id]=mk()),addEventListener(){}};
global.setTimeout=setTimeout;
const orig=Module._load;
Module._load=function(r,p){ if(r==='./util')return{$:id=>global.document.getElementById(id),escapeHtml:s=>s}; return orig.apply(this,arguments); };
const d=require((__ROOT__ + '/src/dialog'));
d.init();

let pass=0,fail=0;
const t=(n,c)=>{if(c===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(typeof c==='string'?' -> '+c:''))}};
const clickOk=()=>els['msgOk']._h();  // captured below

// capture the click handlers init() registered
const handlers={};
els['msgOk'].addEventListener=(n,f)=>{handlers.ok=f};
els['msgCancel'].addEventListener=(n,f)=>{handlers.cancel=f};
els['msgModal'].addEventListener=()=>{};
d.init();

(async()=>{
  // A confirm is open; a notify arrives from the background.
  let confirmResult=null, notifyDone=false;
  const cp=d.confirm('Upload 3 files?',{okLabel:'Upload'}).then(v=>{confirmResult=v});
  const np=d.notify('A save failed').then(()=>{notifyDone=true});
  await new Promise(r=>setTimeout(r,5));
  t('the background notify does not answer the pending confirm',confirmResult===null);
  t('the confirm is still the visible dialog',els['msgTitle'].textContent==='Please confirm');

  handlers.ok();                      // user presses Upload
  await new Promise(r=>setTimeout(r,5));
  t('the confirm resolves true when the user accepts',confirmResult===true);
  t('the queued notify then becomes visible',els['msgTitle'].textContent==='Notice');
  t('the notify has not resolved yet',notifyDone===false);

  handlers.ok();                      // dismiss the notify
  await Promise.all([cp,np]);
  t('the queued notify resolves once dismissed',notifyDone===true);

  // three stacked dialogs drain in order
  const order=[];
  const a=d.notify('one').then(()=>order.push(1));
  const b=d.notify('two').then(()=>order.push(2));
  const c=d.notify('three').then(()=>order.push(3));
  await new Promise(r=>setTimeout(r,5));
  handlers.ok(); await new Promise(r=>setTimeout(r,2));
  handlers.ok(); await new Promise(r=>setTimeout(r,2));
  handlers.ok();
  await Promise.all([a,b,c]);
  t('queued dialogs resolve in FIFO order',order.join()==='1,2,3'||order.join());

  // cancel path still works
  let v=null; const p=d.confirm('Delete?',{danger:true}).then(x=>{v=x});
  await new Promise(r=>setTimeout(r,5));
  handlers.cancel(); await p;
  t('cancel resolves false',v===false);

  console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
})();
