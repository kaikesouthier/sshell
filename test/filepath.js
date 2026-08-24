// Electron removed File.path in v32. Reading it directly yields undefined and
// every picker/drop silently does nothing, so guard against it returning.
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const t = (n, c) => {
  const r = typeof c === 'function' ? c() : c;
  if (r === true) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
};

const files = ['app.js'].concat(
  fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.js')).map(f => 'src/' + f));

const offenders = [];
for (const f of files) {
  if (f === 'src/util.js') continue;              // the helper itself
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  src.split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    // .path read off a File-ish expression (picker.files[n], a drop file, ...)
    if (/\bfiles\s*\[\s*\d+\s*\]\s*\.path\b/.test(line) ||
        /\bfile\.path\b/.test(line) ||
        /\bf\.path\b/.test(line)) {
      offenders.push(f + ':' + (i + 1) + '  ' + line.trim().slice(0, 80));
    }
  });
}
t('no module reads File.path directly', offenders.length === 0 || ('\n      ' + offenders.join('\n      ')));

// Every picker/drop site must go through the helper.
const consumers = ['src/sftp.js', 'src/gridupload.js', 'src/editor.js', 'src/bulk.js', 'src/menu.js'];
consumers.forEach(f => {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const usesPicker = /\.files\b|dataTransfer\.files/.test(src);
  if (!usesPicker) return;
  t(f + ' resolves paths via the helper', /filePath\s*\(/.test(src) || 'no filePath() call');
});

// The helper prefers webUtils and falls back cleanly.
const orig = Module._load;
let asked = null;
Module._load = function (req, parent) {
  if (req === 'electron' && parent && parent.filename.includes('util.js')) {
    return { webUtils: { getPathForFile: f => { asked = f; return 'C:/resolved/' + f.name; } } };
  }
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve(path.join(ROOT, 'src/util.js'))];
const util = require(path.join(ROOT, 'src/util.js'));

t('filePath uses webUtils.getPathForFile', util.filePath({ name: 'a.txt' }) === 'C:/resolved/a.txt');
t('filePath passes the File object through', asked && asked.name === 'a.txt');
t('filePath returns empty string for nothing', util.filePath(null) === '' && util.filePath(undefined) === '');

Module._load = function (req, parent) {
  if (req === 'electron' && parent && parent.filename.includes('util.js')) return {};   // no webUtils
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve(path.join(ROOT, 'src/util.js'))];
const util2 = require(path.join(ROOT, 'src/util.js'));
t('filePath falls back to File.path on older Electron', util2.filePath({ path: 'C:/legacy.txt' }) === 'C:/legacy.txt');
t('the fallback still returns empty when neither is available', util2.filePath({}) === '');

Module._load = function (req, parent) {
  if (req === 'electron' && parent && parent.filename.includes('util.js')) throw new Error('no electron');
  return orig.apply(this, arguments);
};
delete require.cache[require.resolve(path.join(ROOT, 'src/util.js'))];
const util3 = require(path.join(ROOT, 'src/util.js'));
t('filePath survives electron being unavailable', util3.filePath({ path: 'C:/x' }) === 'C:/x');
Module._load = orig;

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
