const fs=require('fs'),path=require('path');
const ids=new Set();
for (const f of fs.readdirSync('views')) {
  const t=fs.readFileSync(path.join('views',f),'utf8');
  for (const m of t.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
}
for (const m of fs.readFileSync('index.html','utf8').matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);

const files=['app.js',...fs.readdirSync('src').map(f=>'src/'+f)];
const miss=[];
for (const f of files) {
  const t=fs.readFileSync(f,'utf8');
  t.split('\n').forEach((line,i)=>{
    for (const m of line.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)) {
      const id=m[1]||m[2];
      if(!ids.has(id)) miss.push(`${f}:${i+1}  ${id}`);
    }
  });
}
console.log(miss.length? 'MISSING DOM IDS:\n'+miss.join('\n') : 'All referenced DOM ids exist ('+ids.size+' defined)');
