const __ROOT__ = require('path').join(__dirname, '..');
// Minimal DOM/Electron stubs so the renderer modules can be required and their
// init() run, surfacing ReferenceErrors and missing imports.
const path=require('path');
const Module=require('module');
const els={};
function mkEl(id){
  const e={id,children:[],style:{setProperty(){},},dataset:{},classList:{_s:new Set(),add(...c){c.forEach(x=>this._s.add(x))},remove(...c){c.forEach(x=>this._s.delete(x))},toggle(c,f){f?this._s.add(c):this._s.delete(c)},contains(c){return this._s.has(c)}},
    addEventListener(){},removeEventListener(){},appendChild(c){this.children.push(c);return c},removeChild(){},insertBefore(){},
    querySelector(){return mkEl('q')},querySelectorAll(){return []},getBoundingClientRect(){return{top:0,left:0,right:0,bottom:0,width:100,height:100}},
    focus(){},click(){},select(){},contains(){return false},closest(){return null},
    set innerHTML(v){this._h=v},get innerHTML(){return this._h||''},
    set textContent(v){this._t=v},get textContent(){return this._t||''},
    set value(v){this._v=v},get value(){return this._v||''},
    set disabled(v){this._d=v},get disabled(){return this._d}};
  return e;
}
global.window={addEventListener(){},removeEventListener(){},innerWidth:1600,innerHeight:900,close(){}};
global.document={
  documentElement:mkEl('html'),body:mkEl('body'),
  getElementById(id){return els[id]||(els[id]=mkEl(id))},
  createElement(t){return mkEl(t)},
  addEventListener(){},querySelectorAll(){return []},querySelector(){return mkEl('q')}
};
global.localStorage={getItem(){return null},setItem(){}};
global.requestAnimationFrame=fn=>setTimeout(fn,0);
global.ResizeObserver=class{observe(){}disconnect(){}};
global.Blob=class{};global.URL={createObjectURL(){return''},revokeObjectURL(){}};

const orig=Module._load;
Module._load=function(req,parent,isMain){
  if(req==='electron') return {ipcRenderer:{sendSync(){return __dirname},invoke(){return Promise.resolve({canceled:true})},on(){}},clipboard:{readText(){return''},writeText(){}},shell:{openPath(){return Promise.resolve('')}}};
  if(req==='xterm') return {Terminal:class{constructor(){this.element=mkEl('t')}open(){}loadAddon(){}onData(){return{dispose(){}}}onSelectionChange(){}write(){}writeln(){}dispose(){}focus(){}scrollToBottom(){}get options(){return{}}}};
  if(req==='xterm-addon-fit') return {FitAddon:class{fit(){}}};
  if(req==='ssh2') return {Client:class{on(){return this}connect(){}end(){}}};
  return orig.apply(this,arguments);
};

const mods=['runtime','util','errors','safefile','paths','crypto','config','store','icons','ctxmenu','dialog','modal','iconpicker','theme','statusbar','terminal','monitor','grid','sftp','tools','sidebar','editor','bulk','configpage','menu','tabs','lock'];
let fail=0;
for(const m of mods){
  try{
    const mod=require((__ROOT__ + '/src/')+m);
    if(typeof mod.init==='function'){ mod.init(); }
    console.log('  ok   '+m);
  }catch(e){ fail++; console.log('  FAIL '+m+'  '+e.message+'\n       '+(e.stack||'').split('\n')[1]); }
}
console.log(fail? '\n'+fail+' module(s) failed' : '\nAll modules loaded and init() ran clean');
