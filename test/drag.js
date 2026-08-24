const __ROOT__ = require('path').join(__dirname, '..');
const fs=require('fs');
const S=require((__ROOT__ + '/src/store'));
// Pull the pure tree helpers out of sidebar.js and bind them to the real store.
const src=fs.readFileSync((__ROOT__ + '/src/sidebar.js'),'utf8');
const grab=n=>{const i=src.indexOf('function '+n+'(');let d=0,j=src.indexOf('{',i);for(let k=j;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(i,k+1)}}};
const helpers=['isDescendantFolder','sessionsInFolder','wouldCycle','draggedFolderIds'].map(grab).join('\n');
const ctx=new Function('S','isSelected','selectedFolderIds',helpers+
  ';return {isDescendantFolder,sessionsInFolder,wouldCycle,draggedFolderIds};');
let selectedFolders=[];
const H=ctx(S,(k,id)=>k==='fld'&&selectedFolders.includes(id),()=>selectedFolders);

let pass=0,fail=0;
const t=(n,c)=>{try{const r=c();if(r===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(typeof r==='string'?' -> '+r:''))}}catch(e){fail++;console.log('  FAIL '+n+' -> '+e.message)}};

// a > b > c > d  and a separate root e
const tree=()=>{S.store={folders:[
  {id:'a',name:'a',parentId:null},{id:'b',name:'b',parentId:'a'},
  {id:'c',name:'c',parentId:'b'},{id:'d',name:'d',parentId:'c'},
  {id:'e',name:'e',parentId:null}],sessions:[]};selectedFolders=[];};

tree();
t('isDescendantFolder finds a deep descendant',()=>H.isDescendantFolder('d','a')===true);
t('isDescendantFolder rejects an unrelated branch',()=>H.isDescendantFolder('e','a')===false);
t('isDescendantFolder is not reflexive',()=>H.isDescendantFolder('a','a')===false);

t('moving a folder into its own child is a cycle',()=>H.wouldCycle(['a'],'b')===true);
t('moving a folder into its own grandchild is a cycle',()=>H.wouldCycle(['a'],'d')===true);
t('moving a folder into itself is a cycle',()=>H.wouldCycle(['a'],'a')===true);
t('moving a folder into an unrelated folder is allowed',()=>H.wouldCycle(['e'],'d')===false);
t('moving a folder to the root is always allowed',()=>H.wouldCycle(['a'],null)===false);
t('moving a child under a different root is allowed',()=>H.wouldCycle(['c'],'e')===false);

// multi-select: dragging a parent and its child together
tree(); selectedFolders=['a','c'];
t('dragging a parent and its descendant only moves the parent',()=>
  H.draggedFolderIds('a').join()==='a'||H.draggedFolderIds('a').join());
tree(); selectedFolders=['b','e'];
t('dragging two unrelated folders moves both',()=>H.draggedFolderIds('b').sort().join()==='b,e');
tree(); selectedFolders=[];
t('dragging an unselected folder moves just that one',()=>H.draggedFolderIds('c').join()==='c');
tree(); selectedFolders=['a','b','c','d'];
t('dragging a whole chain collapses to its root',()=>H.draggedFolderIds('a').join()==='a');

// cycle guard must consider every folder in a multi-drag
tree(); selectedFolders=['a','e'];
t('a multi-drag is rejected if any member would cycle',()=>H.wouldCycle(H.draggedFolderIds('a'),'c')===true);

// deep chain
S.store={folders:Array.from({length:90},(_,i)=>({id:'f'+i,name:'f'+i,parentId:i?'f'+(i-1):null})),sessions:[]};
t('the deepest folder is a descendant of the root',()=>H.isDescendantFolder('f89','f0')===true);
t('cycle detection holds across 90 levels',()=>H.wouldCycle(['f0'],'f89')===true);
t('sessionsInFolder walks 90 levels without blowing the stack',()=>{
  S.store.sessions=[{id:'s',folderId:'f89',label:'s',host:'h'}];
  return H.sessionsInFolder('f0').length===1;
});
t('sessionsInFolder terminates even if a cycle exists',()=>{
  S.store={folders:[{id:'x',parentId:'y'},{id:'y',parentId:'x'}],sessions:[{id:'s',folderId:'x',host:'h'}]};
  return H.sessionsInFolder('x').length===1;
});
console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
