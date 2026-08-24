const __ROOT__ = require('path').join(__dirname, '..');
const fs = require('fs'), path = require('path');
const ROOT = __ROOT__;
process.chdir(ROOT);

const files = ['main.js', 'app.js'].concat(fs.readdirSync('src').filter(f => f.endsWith('.js')).map(f => 'src/' + f));
const sources = {};
files.forEach(f => { sources[f] = fs.readFileSync(f, 'utf8'); });
const all = Object.values(sources).join('\n');

const unusedLocals = [], unusedExports = [], unusedRequires = [];

for (const f of files) {
  const t = sources[f];

  // Declared functions never referenced anywhere else in the same file.
  for (const m of t.matchAll(/^function ([a-zA-Z_$][\w$]*)\s*\(/gm)) {
    const name = m[1];
    const uses = (t.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
    const exported = new RegExp('\\b' + name + '\\b').test((/module\.exports\s*=\s*\{[\s\S]*?\};/.exec(t) || [''])[0]);
    if (uses <= 1 && !exported) unusedLocals.push(f + '  function ' + name);
  }

  // Exported names never referenced by any other file.
  const exp = /module\.exports\s*=\s*\{([\s\S]*?)\};/.exec(t);
  if (exp) {
    const names = exp[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean);
    const mod = path.basename(f, '.js');
    names.forEach(n => {
      let used = false;
      for (const g of files) {
        if (g === f) continue;
        const s = sources[g];
        if (!s.includes("'./" + mod + "'")) continue;
        if (new RegExp('\\.' + n + '\\b').test(s)) { used = true; break; }
        if (new RegExp('\\{[^}]*\\b' + n + '\\b[^}]*\\}\\s*=\\s*require').test(s)) { used = true; break; }
      }
      if (!used) unusedExports.push(f + '  exports ' + n);
    });
  }

  // const X = require(...) where X is never used again.
  for (const m of t.matchAll(/^const \{?\s*([a-zA-Z_$][\w$]*)\s*\}?\s*=\s*require\(/gm)) {
    const name = m[1];
    const uses = (t.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
    if (uses <= 1) unusedRequires.push(f + '  require binding ' + name);
  }
}

// Destructured util imports that are never used in that file.
for (const f of files) {
  const t = sources[f];
  const m = /^const \{([^}]+)\}\s*=\s*require\('\.\/util'\)/m.exec(t);
  if (!m) continue;
  m[1].split(',').map(s => s.trim()).filter(Boolean).forEach(n => {
    const uses = (t.match(new RegExp('\\b' + n.replace('$', '\\$') + '\\b', 'g')) || []).length;
    if (uses <= 1) unusedRequires.push(f + '  unused util import ' + n);
  });
}

const show = (label, arr) => {
  console.log('\n' + label + ' (' + arr.length + ')');
  arr.forEach(x => console.log('  ' + x));
};
show('Unreferenced local functions', unusedLocals);
show('Exports nobody imports', unusedExports);
show('Unused require bindings', unusedRequires);

// Orphan CSS classes: defined in app.css but never mentioned in js/html.
const css = fs.readFileSync('assets/app.css', 'utf8');
const html = fs.readdirSync('views').map(v => fs.readFileSync('views/' + v, 'utf8')).join('\n') +
  fs.readFileSync('index.html', 'utf8');
const orphanCss = [];
for (const m of css.matchAll(/^\.([a-zA-Z][\w-]*)/gm)) {
  const cls = m[1];
  if (!new RegExp('[\'"\\s.]' + cls + '[\'"\\s,.){:]').test(all + html)) orphanCss.push(cls);
}
show('CSS classes with no reference in js/html', [...new Set(orphanCss)]);
