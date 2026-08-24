const __ROOT__ = require('path').join(__dirname, '..');
const fs=require('fs');
const src=fs.readFileSync((__ROOT__ + '/src/grid.js'),'utf8');
const grab=n=>{const i=src.indexOf('function '+n+'(');let d=0,j=src.indexOf('{',i);for(let k=j;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(i,k+1)}}};
const consts=/const MIN_W[\s\S]*?ZOOM_STEP = [\d.]+;\n/.exec(src)[0];
const body=consts+'let layoutTimer=null;const snap=n=>Math.round(n/SNAP)*SNAP;const clampZoom=z=>Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,z));\n'+
  ['sanitizeRect','overlaps','visibleCanvasWidth','autoPlace','contentBounds','centerOnContent','migrateSavedLayout','saveLayoutSoon','arrangeColumns','seedRects','savedLayout','getRect','setRect','growCanvas','shrinkCanvas']
  .map(grab).join('\n');

let RT={tabs:[]}, cfg={data:{}}, remembered=[];
const H=new Function('RT','require','applyRect','rememberRect','gridRefit',
  body+';return {sanitizeRect,overlaps,autoPlace,contentBounds,centerOnContent,migrateSavedLayout,arrangeColumns,seedRects,growCanvas,shrinkCanvas,getRect,setRect,visibleCanvasWidth,MIN_W,MIN_H,SNAP,snap,ZOOM_MIN,ZOOM_MAX,clampZoom,CANVAS_ORIGIN};')(
  RT,m=>m==='./config'?cfg:{attempt:f=>f(),record(){}},()=>{},(id,r)=>remembered.push({id,r}),()=>{});

let pass=0,fail=0;
const t=(n,c)=>{try{const r=c();if(r===true){pass++;console.log('  ok   '+n)}else{fail++;console.log('  FAIL '+n+(typeof r==='string'?' -> '+r:''))}}catch(e){fail++;console.log('  FAIL '+n+' -> '+e.message)}};
const mkState=(w,z)=>({mode:'free',zoom:z||1,cols:4,cells:new Map(),rects:new Map(),
  wrap:{clientWidth:w||1000,clientHeight:700,scrollLeft:0,scrollTop:0,style:{}},
  spacer:{style:{}},layer:{style:{}}});

t('snap rounds to the 8px grid',()=>H.snap(11)===8&&H.snap(13)===16);
t('sanitizeRect rejects garbage',()=>H.sanitizeRect(null)===null&&H.sanitizeRect({x:NaN,y:0,w:1,h:1})===null);
t('sanitizeRect clamps negatives and enforces minimums',()=>{
  const r=H.sanitizeRect({x:-5,y:-5,w:1,h:1});return r.x===0&&r.y===0&&r.w===H.MIN_W&&r.h===H.MIN_H;});
t('overlaps is correct for touching and separated rects',()=>
  H.overlaps({x:0,y:0,w:100,h:100},{x:50,y:50,w:100,h:100})===true &&
  H.overlaps({x:0,y:0,w:100,h:100},{x:100,y:0,w:100,h:100})===false);

t('zoom clamps to the allowed range',()=>H.clampZoom(99)===H.ZOOM_MAX&&H.clampZoom(0.01)===H.ZOOM_MIN);
t('visible canvas width grows as you zoom out',()=>
  H.visibleCanvasWidth(mkState(1000,0.5))===2000 && H.visibleCanvasWidth(mkState(1000,2))===500);

t('autoPlace lays out many panes with no overlap',()=>{
  const s=mkState(1200); const placed=[];
  for(let i=0;i<12;i++) placed.push(H.autoPlace(s,placed.slice()));
  for(let i=0;i<placed.length;i++) for(let j=i+1;j<placed.length;j++)
    if(H.overlaps(placed[i],placed[j])) return 'overlap '+i+','+j;
  return true;});
t('autoPlace fits more per row when zoomed out',()=>{
  const wide=H.autoPlace(mkState(1000,0.5),[]);
  const near=H.autoPlace(mkState(1000,2),[]);
  return wide.w>near.w;});

t('arrangeColumns tidies with no overlaps',()=>{
  RT.tabs=Array.from({length:9},(_,i)=>({id:'t'+i,type:'terminal',closed:false,configId:'c'+i}));
  const s=mkState(1200); H.arrangeColumns(s);
  const rects=[...s.rects.values()];
  for(let i=0;i<rects.length;i++) for(let j=i+1;j<rects.length;j++)
    if(H.overlaps(rects[i],rects[j])) return 'overlap';
  return rects.length===9;});
t('arrangeColumns brings the viewport back over the panes',()=>{
  RT.tabs=[{id:'a',type:'terminal',closed:false,configId:'c'}];
  const s=mkState(); s.wrap.scrollLeft=9000; s.wrap.scrollTop=9000;
  H.arrangeColumns(s);
  const b=H.contentBounds(s);
  const cx=(b.minX+b.maxX)/2, cy=(b.minY+b.maxY)/2;
  // viewport centre should land on the content centre
  return (Math.abs((s.wrap.scrollLeft+500)-cx)<2 && Math.abs((s.wrap.scrollTop+350)-cy)<2)
    || s.wrap.scrollLeft+','+s.wrap.scrollTop+' vs '+cx+','+cy;});
t('arrangeColumns lays panes out away from the origin',()=>{
  RT.tabs=[{id:'a',type:'terminal',closed:false,configId:'c'}];
  const s=mkState(); H.arrangeColumns(s);
  return s.rects.get('a').x>=H.CANVAS_ORIGIN;});
t('Tidy keeps the same pane aspect at every zoom level',()=>{
  RT.tabs=Array.from({length:4},(_,i)=>({id:'t'+i,type:'terminal',closed:false,configId:'c'+i}));
  const aspects=[1,0.5,0.25].map(z=>{
    const s=mkState(1200,z); H.arrangeColumns(s);
    const r=s.rects.get('t0'); return r.w/r.h;
  });
  const spread=Math.max(...aspects)-Math.min(...aspects);
  return spread<0.05||('aspects '+aspects.map(a=>a.toFixed(2)).join(', '));});
t('Tidy panes occupy the same on-screen size at every zoom',()=>{
  RT.tabs=Array.from({length:4},(_,i)=>({id:'t'+i,type:'terminal',closed:false,configId:'c'+i}));
  const px=[1,0.5,0.25].map(z=>{
    const s=mkState(1200,z); H.arrangeColumns(s);
    const r=s.rects.get('t0'); return Math.round(r.h*z);
  });
  return (Math.max(...px)-Math.min(...px))<12||('heights on screen: '+px.join(', '));});
t('Tidy never produces a pane below the minimum size',()=>{
  RT.tabs=[{id:'a',type:'terminal',closed:false,configId:'c'}];
  const s=mkState(300,2); H.arrangeColumns(s);
  const r=s.rects.get('a');
  return r.w>=H.MIN_W&&r.h>=H.MIN_H;});

t('arrangeColumns honours the column count',()=>{
  RT.tabs=Array.from({length:8},(_,i)=>({id:'t'+i,type:'terminal',closed:false,configId:'c'+i}));
  const s=mkState(1200); s.cols=2; H.arrangeColumns(s);
  return new Set([...s.rects.values()].map(r=>r.x)).size===2;});
t('arrangeColumns ignores closed tabs',()=>{
  RT.tabs=[{id:'a',type:'terminal',closed:false,configId:'c1'},{id:'b',type:'terminal',closed:true,configId:'c2'}];
  const s=mkState(); H.arrangeColumns(s);
  return s.rects.size===1&&s.rects.has('a');});

t('seedRects restores a saved layout by session',()=>{
  cfg.data.gridLayout={cfgA:{x:2400,y:2200,w:400,h:300}};
  const s=mkState(); H.seedRects(s,[{id:'t1',configId:'cfgA'}]);
  const r=s.rects.get('t1'); return r.x===2400&&r.y===2200&&r.w===400;});

t('panes are laid out away from the canvas origin',()=>{
  cfg.data.gridLayout={};
  const s=mkState(); H.seedRects(s,[{id:'t1',configId:'a'}]);
  const r=s.rects.get('t1');
  return (r.x>=H.CANVAS_ORIGIN&&r.y>=H.CANVAS_ORIGIN)||JSON.stringify(r);});
t('an origin-anchored legacy layout is shifted inward as a block',()=>{
  cfg.data.gridLayout={a:{x:0,y:0,w:400,h:300},b:{x:500,y:120,w:400,h:300}}; cfg.data.gridLayoutCentred=false;
  const s=mkState(); H.seedRects(s,[{id:'t1',configId:'a'},{id:'t2',configId:'b'}]);
  const A=s.rects.get('t1'), B=s.rects.get('t2');
  // Relative arrangement preserved, whole block moved off the corner.
  return (A.x>=H.CANVAS_ORIGIN&&B.x-A.x===500&&B.y-A.y===120)||JSON.stringify([A,B]);});
t('an already-centred layout is left alone',()=>{
  cfg.data.gridLayout={a:{x:3000,y:3000,w:400,h:300}}; cfg.data.gridLayoutCentred=false;
  const s=mkState(); H.seedRects(s,[{id:'t1',configId:'a'}]);
  return s.rects.get('t1').x===3000;});

t('the centring migration runs once, not on every mount',()=>{
  cfg.data.gridLayout={a:{x:0,y:0,w:400,h:300}}; cfg.data.gridLayoutCentred=false;
  H.migrateSavedLayout();
  const afterFirst=cfg.data.gridLayout.a.x;
  H.migrateSavedLayout(); H.migrateSavedLayout();
  return (cfg.data.gridLayout.a.x===afterFirst&&cfg.data.gridLayoutCentred===true)
    ||('drifted to '+cfg.data.gridLayout.a.x);});
t('a pane dragged near the origin does not re-trigger a mass shift',()=>{
  // The old bug: contentBounds saw only open tabs, so one low pane teleported
  // the whole layout on the next mount.
  cfg.data.gridLayout={a:{x:2000,y:2000,w:400,h:300},b:{x:2500,y:2400,w:400,h:300}};
  cfg.data.gridLayoutCentred=true;
  const s=mkState();
  s.rects.set('t1',{x:768,y:0,w:400,h:300});
  H.seedRects(s,[{id:'t1',configId:'a'}]);
  return s.rects.get('t1').x===768||('shifted to '+s.rects.get('t1').x);});

t('contentBounds is null with no panes',()=>H.contentBounds(mkState())===null);
t('contentBounds spans every pane',()=>{
  const s=mkState();
  s.rects.set('a',{x:100,y:100,w:200,h:100});
  s.rects.set('b',{x:500,y:300,w:200,h:100});
  const b=H.contentBounds(s);
  return b.minX===100&&b.minY===100&&b.maxX===700&&b.maxY===400;});
t('centerOnContent puts the viewport over the middle of the panes',()=>{
  const s=mkState(1000);  // viewport 1000x700
  s.rects.set('a',{x:2000,y:2000,w:400,h:400});
  H.centerOnContent(s);
  // centre of content is 2200,2200 -> scroll = 2200 - half viewport
  return (s.wrap.scrollLeft===2200-500&&s.wrap.scrollTop===2200-350)||
    s.wrap.scrollLeft+','+s.wrap.scrollTop;});
t('centerOnContent accounts for zoom',()=>{
  const s=mkState(1000,0.5);
  s.rects.set('a',{x:2000,y:2000,w:400,h:400});
  H.centerOnContent(s);
  return (s.wrap.scrollLeft===2200*0.5-500)||s.wrap.scrollLeft;});
t('centerOnContent never scrolls negative',()=>{
  const s=mkState(4000); s.rects.set('a',{x:10,y:10,w:100,h:100});
  H.centerOnContent(s);
  return s.wrap.scrollLeft>=0&&s.wrap.scrollTop>=0;});
t('there is room to scroll on all sides of centred content',()=>{
  const s=mkState(1000); s.rects.set('a',{x:2000,y:2000,w:400,h:400});
  H.centerOnContent(s);
  // zooming out must be able to pull back without hitting the clamp
  return s.wrap.scrollLeft>0&&s.wrap.scrollTop>0;});
t('seedRects separates two tabs of the same session',()=>{
  cfg.data.gridLayout={dup:{x:0,y:0,w:400,h:300}};
  const s=mkState(); H.seedRects(s,[{id:'t1',configId:'dup'},{id:'t2',configId:'dup'}]);
  return !H.overlaps(s.rects.get('t1'),s.rects.get('t2'));});
t('seedRects keeps a rect already on screen',()=>{
  cfg.data.gridLayout={cfgA:{x:5000,y:5000,w:400,h:300}};
  const s=mkState(); s.rects.set('t1',{x:2500,y:2500,w:300,h:200});
  H.seedRects(s,[{id:'t1',configId:'cfgA'}]);
  return s.rects.get('t1').x===2500;});
t('seedRects drops rects for closed tabs',()=>{
  const s=mkState(); s.rects.set('gone',{x:0,y:0,w:300,h:200});
  H.seedRects(s,[{id:'t1',configId:'c'}]); return !s.rects.has('gone');});
t('seedRects ignores a corrupt saved rect',()=>{
  cfg.data.gridLayout={bad:{x:'nope'}};
  const s=mkState(); H.seedRects(s,[{id:'t1',configId:'bad'}]);
  return s.rects.get('t1').w>=H.MIN_W;});

t('the canvas always keeps a screenful of headroom past content',()=>{
  const s=mkState(); s.rects.set('a',{x:900,y:700,w:300,h:200}); H.growCanvas(s);
  return parseInt(s.spacer.style.width)>1200&&parseInt(s.spacer.style.height)>900;});
t('the canvas extends past wherever you have scrolled (endless)',()=>{
  const s=mkState(); H.growCanvas(s);
  const first=parseInt(s.spacer.style.width);
  s.wrap.scrollLeft=5000; H.growCanvas(s);
  return parseInt(s.spacer.style.width)>first;});
t('the canvas extent never shrinks mid-session',()=>{
  const s=mkState(); s.wrap.scrollLeft=4000; H.growCanvas(s);
  const big=parseInt(s.spacer.style.width);
  s.wrap.scrollLeft=0; H.growCanvas(s);
  return parseInt(s.spacer.style.width)===big;});
t('zooming in enlarges the scroll extent',()=>{
  const a=mkState(1000,1); a.rects.set('x',{x:2000,y:0,w:300,h:200}); H.growCanvas(a);
  const b=mkState(1000,2); b.rects.set('x',{x:2000,y:0,w:300,h:200}); H.growCanvas(b);
  return parseInt(b.spacer.style.width)>parseInt(a.spacer.style.width);});
t('shrinkCanvas trims the extent back to the content',()=>{
  const s=mkState(); s.wrap.scrollLeft=6000; H.growCanvas(s);
  const big=parseInt(s.spacer.style.width);
  s.wrap.scrollLeft=0; H.shrinkCanvas(s);
  return parseInt(s.spacer.style.width)<big;});
t('growCanvas is a no-op in column mode',()=>{
  const s=mkState(); s.mode='columns'; H.growCanvas(s); return !s.spacer.style.width;});

console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
