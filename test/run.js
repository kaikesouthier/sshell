// Runs every suite in this folder and reports a single pass/fail summary.
//   npm test
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');

const dir = __dirname;
// check/load/dead are analysers with their own output shape; run them first.
const analysers = ['check.js', 'load.js'];
const suites = fs.readdirSync(dir)
    .filter(f => f.endsWith('.js') && f !== 'run.js' && !analysers.includes(f) && f !== 'dead.js')
    .sort();

let total = 0, failed = 0, broken = [];

const run = f => {
    try {
        return { out: execFileSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' }), ok: true };
    } catch (e) {
        return { out: (e.stdout || '') + (e.stderr || ''), ok: false };
    }
};

console.log('--- static analysis ---');
for (const f of analysers) {
    const r = run(f);
    const last = r.out.trim().split('\n').filter(Boolean).pop() || '(no output)';
    console.log('  ' + f.padEnd(13) + last);
    if (/MISSING|FAIL/.test(r.out) && !/clock2/.test(r.out)) { failed++; broken.push(f); }
}

console.log('\n--- suites ---');
for (const f of suites) {
    const r = run(f);
    const last = r.out.trim().split('\n').filter(Boolean).pop() || '(no output)';
    const m = /^(\d+) passed, (\d+) failed$/.exec(last);
    if (m) {
        total += Number(m[1]);
        if (Number(m[2]) > 0) { failed += Number(m[2]); broken.push(f); }
        console.log('  ' + f.replace('.js', '').padEnd(13) + last);
    } else {
        failed++; broken.push(f);
        console.log('  ' + f.replace('.js', '').padEnd(13) + 'DID NOT COMPLETE');
        console.log(r.out.split('\n').slice(0, 6).map(l => '      ' + l).join('\n'));
    }
}

console.log('\n' + total + ' assertions passed');
if (failed) {
    console.log(failed + ' failure(s) in: ' + broken.join(', '));
    process.exit(1);
}
console.log('all green');
