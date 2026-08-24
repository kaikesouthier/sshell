// Rubber-band geometry and the sidebar width policy.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src/marquee.js'), 'utf8');

const grab = n => {
  let i = src.indexOf('function ' + n + '(');
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const H = new Function(['rectFrom', 'intersects'].map(grab).join('\n') + ';return {rectFrom,intersects};')();

let pass = 0, fail = 0;
const t = (n, c) => {
  const r = typeof c === 'function' ? c() : c;
  if (r === true) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
};
const el = (l, t2, w, h) => ({ getBoundingClientRect: () => ({ left: l, top: t2, right: l + w, bottom: t2 + h, width: w, height: h }) });

t('a rect normalises when dragged up-left', () => {
  const r = H.rectFrom({ x: 100, y: 100 }, { x: 20, y: 30 });
  return r.left === 20 && r.top === 30 && r.right === 100 && r.bottom === 100;
});
t('a rect normalises when dragged down-right', () => {
  const r = H.rectFrom({ x: 5, y: 5 }, { x: 50, y: 60 });
  return r.left === 5 && r.top === 5 && r.right === 50 && r.bottom === 60;
});
t('an element fully inside the band is hit', () =>
  H.intersects({ left: 0, top: 0, right: 200, bottom: 200 }, el(50, 50, 40, 40)) === true);
t('an element partly overlapping is hit', () =>
  H.intersects({ left: 0, top: 0, right: 60, bottom: 60 }, el(50, 50, 40, 40)) === true);
t('an element outside is not hit', () =>
  H.intersects({ left: 0, top: 0, right: 40, bottom: 40 }, el(500, 500, 40, 40)) === false);
t('merely touching edges does not count as a hit', () =>
  H.intersects({ left: 0, top: 0, right: 50, bottom: 50 }, el(50, 50, 40, 40)) === false);
t('a zero-size element is never hit', () =>
  H.intersects({ left: 0, top: 0, right: 999, bottom: 999 }, el(10, 10, 0, 0)) === false);
t('a band spanning a row selects it regardless of horizontal offset', () =>
  H.intersects({ left: 0, top: 90, right: 5, bottom: 110 }, el(0, 80, 400, 24)) === true);

// --- sidebar width policy, read from the source of truth ---
const side = fs.readFileSync(path.join(ROOT, 'src/sidebar.js'), 'utf8');
const MIN = Number(/const SIDEBAR_MIN = (\d+)/.exec(side)[1]);
const MAX = Number(/SIDEBAR_MAX = (\d+)/.exec(side)[1]);
const defs = /const DEFAULT_W = \{ sessions: (\d+), sftp: (\d+) \}/.exec(side);

const clamp = px => Math.round(Math.min(MAX, Math.max(MIN, px)));
t('a drag narrower than the minimum clamps', () => clamp(10) === MIN);
t('a drag wider than the maximum clamps', () => clamp(5000) === MAX);
t('a normal drag passes through', () => clamp(400) === 400);
t('both panes have their own default width', () => defs[1] !== defs[2]);
t('the defaults sit inside the allowed range', () =>
  Number(defs[1]) >= MIN && Number(defs[1]) <= MAX && Number(defs[2]) >= MIN && Number(defs[2]) <= MAX);
t('a corrupt saved width falls back to the default', () => {
  const accept = v => (isFinite(v) && v >= MIN && v <= MAX);
  return !accept(NaN) && !accept(undefined) && !accept(-5) && !accept(99999) && accept(300);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
