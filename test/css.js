// Verifies the vendored Tailwind build actually contains every utility class the
// app uses. Without this there is no way to know a class silently went missing
// when the CDN was removed.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

const css = fs.readFileSync(path.join(ROOT, 'assets/tailwind.css'), 'utf8');
const appCss = fs.readFileSync(path.join(ROOT, 'assets/app.css'), 'utf8');

const files = ['index.html']
    .concat(fs.readdirSync(path.join(ROOT, 'views')).map(f => 'views/' + f))
    .concat(['app.js'])
    .concat(fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.js')).map(f => 'src/' + f));

// Classes the app defines itself, plus library and state classes.
const OWN = new Set();
for (const m of appCss.matchAll(/\.([a-zA-Z][\w-]*)/g)) OWN.add(m[1]);
['hidden', 'flex', 'block', 'active', 'open', 'collapsed', 'dragging', 'dir', 'is-win', 'is-other', 'dark']
    .forEach(c => OWN.add(c));

// Only Tailwind-shaped tokens are asserted. The app also uses plain hook
// classes (pw-eye, cell-check, ...) purely as querySelector handles; those have
// no utility to generate.
const UTIL = /^(-?(sm|md|lg|xl|2xl|hover|focus|active|group-hover|peer|disabled|first|last|odd|even|dark|placeholder):)*(-?(bg|text|border|ring|shadow|from|via|to|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min|max|gap|space|inset|top|bottom|left|right|z|opacity|rounded|font|leading|tracking|grid|col|row|flex|order|basis|object|overflow|translate|rotate|scale|cursor|select|pointer|whitespace|break|align|justify|items|content|self|place|divide|outline|fill|stroke|transition|duration|delay|ease|animate|backdrop|filter|aspect|list|table|resize|appearance|snap|touch|will|caret|accent|decoration|underline|uppercase|lowercase|capitalize|truncate|sr|not|antialiased|italic|invisible|visible|hidden|block|inline|contents|absolute|relative|fixed|sticky|static|isolate)(-|$))/;

const tokens = new Set();
const addToken = c => {
    if (!c) return;
    if (/[${}'"?|`()]/.test(c)) return;          // template fragment, not a class
    tokens.add(c);
};
for (const f of files) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of t.matchAll(/class="([^"$]*)"/g)) m[1].split(/\s+/).forEach(addToken);
    for (const m of t.matchAll(/classList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
        for (const s of m[1].matchAll(/'([^']+)'/g)) s[1].split(/\s+/).forEach(addToken);
    }
    for (const m of t.matchAll(/className\s*=\s*'([^']+)'/g)) m[1].split(/\s+/).forEach(addToken);
}

// Tailwind escapes these in the emitted selector.
const esc = c => c.replace(/[.:/[\]%(),#!+*~='"<>&^$|?{}@`\\]/g, ch => '\\' + ch);

const missing = [], skipped = [];
for (const c of tokens) {
    if (OWN.has(c)) continue;
    const looksLikeUtility = UTIL.test(c) || c.includes('[');
    if (!looksLikeUtility) { skipped.push(c); continue; }
    if (css.includes('.' + esc(c))) continue;
    if (css.includes(esc(c))) continue;   // group-hover/peer land in a wrapper selector
    missing.push(c);
}

let pass = 0, fail = 0;
const t = (n, c) => { if (c === true) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (typeof c === 'string' ? ' -> ' + c : '')); } };

t('the vendored stylesheet exists and is non-trivial', css.length > 5000 || ('only ' + css.length + ' bytes'));
t('no remote stylesheet or script remains in index.html', (() => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    return !/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')) || 'index.html still references a remote URL';
})());
t('a Content-Security-Policy is declared', (() => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    return /http-equiv="Content-Security-Policy"/.test(html) || 'no CSP meta tag';
})());
t('the theme colour utilities resolved', ['bg-panel', 'text-txt', 'border-edge', 'text-accent', 'bg-bad', 'text-ok', 'text-warn', 'text-faint', 'text-muted']
    .every(c => css.includes('.' + esc(c))) || 'a theme colour class is missing');
t('alpha-modified theme colours resolved', ['bg-bad/20', 'text-txt/90', 'border-edge/40']
    .filter(c => tokens.has(c)).every(c => css.includes('.' + esc(c))) || 'an alpha variant is missing');
t('arbitrary-value utilities resolved', [...tokens].filter(c => /\[/.test(c)).every(c => css.includes('.' + esc(c)))
    || 'an arbitrary-value class is missing');
t('the runtime-built dialog colours are safelisted', ['text-accent', 'text-ok', 'text-warn', 'text-bad']
    .every(c => css.includes('.' + esc(c))) || 'a safelisted class is missing');
t('every class used anywhere is present in the build',
    missing.length === 0 || (missing.length + ' missing: ' + missing.slice(0, 25).join(' ')));

console.log('\nscanned ' + tokens.size + ' distinct classes across ' + files.length + ' files (' +
    (tokens.size - skipped.length) + ' Tailwind utilities, ' + skipped.length + ' app hooks)');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
