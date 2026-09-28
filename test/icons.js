// Icons are referenced by name from saved sessions and folders, so this suite
// is mostly a compatibility guard: a vault written by any earlier build must
// still draw the same thing.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const icons = require(path.join(ROOT, 'src/icons.js'));
const pickerSrc = fs.readFileSync(path.join(ROOT, 'src/iconpicker.js'), 'utf8');
const sidebarSrc = fs.readFileSync(path.join(ROOT, 'src/sidebar.js'), 'utf8');
const modalsHtml = fs.readFileSync(path.join(ROOT, 'views/modals.html'), 'utf8');

let pass = 0, fail = 0;
const t = (n, c) => {
    try {
        const r = c();
        if (r === true) { pass++; console.log('  ok   ' + n); }
        else { fail++; console.log('  FAIL ' + n + (typeof r === 'string' ? ' -> ' + r : '')); }
    } catch (e) { fail++; console.log('  FAIL ' + n + ' -> ' + e.message); }
};

// Every icon name that shipped in 1.0.0. A session saved by that build stores
// one of these, so removing or renaming any of them silently changes what the
// user sees. Add new icons freely; never take one out of this list.
const LEGACY = ['server', 'server-stack', 'database', 'cloud', 'globe', 'desktop', 'laptop', 'terminal',
    'cpu', 'hard-drive', 'network', 'wifi', 'router', 'signal', 'activity', 'box', 'layers', 'hexagon',
    'linux', 'windows', 'apple', 'android', 'shield', 'shield-check', 'lock', 'key', 'bug', 'code',
    'git-branch', 'beaker', 'rocket', 'bolt', 'fire', 'power', 'cog', 'wrench', 'star', 'heart', 'flag',
    'bookmark', 'home', 'building', 'users', 'user', 'eye', 'mail', 'chat', 'inbox', 'clock', 'bell',
    'tag', 'map-pin', 'crown', 'diamond', 'anchor', 'leaf', 'gamepad', 'folder', 'folder-open', 'map',
    'circle', 'square', 'triangle', 'pentagon', 'octagon', 'grid', 'circle-check', 'circle-x', 'info',
    'question', 'plus-circle', 'check', 'refresh', 'sync', 'download', 'upload', 'external', 'arrow-up',
    'arrow-down', 'arrow-right', 'arrow-left', 'filter', 'play', 'pause', 'music', 'video', 'image',
    'camera', 'mic', 'sun', 'moon', 'droplet', 'snowflake', 'tree', 'mountain', 'trophy', 'calendar',
    'battery', 'plug', 'lightbulb', 'compass', 'target', 'gauge', 'bluetooth', 'usb', 'keyboard',
    'mouse', 'printer', 'phone', 'tablet', 'watch', 'antenna', 'dollar', 'credit-card', 'wallet',
    'chart-bar', 'chart-line', 'coffee', 'qr', 'scan', 'navigation', 'route', 'folder-plus'];

t('every icon that shipped in 1.0 is still present', () => {
    const missing = LEGACY.filter(k => !Object.prototype.hasOwnProperty.call(icons.ICONS, k));
    return missing.length === 0 || 'missing: ' + missing.join(', ');
});
t('the legacy list is complete — 1.0 had 123 icons', () => LEGACY.length === 123 || 'list has ' + LEGACY.length);
t('new icons were added rather than swapped in', () => icons.ICON_KEYS.length > LEGACY.length);
t('every icon draws at least one path', () =>
    icons.ICON_KEYS.every(k => Array.isArray(icons.ICONS[k]) && icons.ICONS[k].length > 0 &&
        icons.ICONS[k].every(d => typeof d === 'string' && d.length > 0)));
t('an unknown icon name still renders, so a vault from a newer build is readable', () => {
    const svg = icons.iconSvg('not-a-real-icon-name', 'txt', 'w-4 h-4');
    return svg.includes('<svg') && svg.includes(icons.ICONS.server[0]);
});
t('a prototype key cannot be used to smuggle in a non-icon', () =>
    icons.iconSvg('__proto__', 'txt').includes(icons.ICONS.server[0]) &&
    icons.iconSvg('constructor', 'txt').includes(icons.ICONS.server[0]));

// --- search ---

t('searching by name finds the icon', () => icons.searchIcons('docker').join() === 'docker');
t('an empty query lists everything', () => icons.searchIcons('').length === icons.ICON_KEYS.length &&
    icons.searchIcons(null).length === icons.ICON_KEYS.length);
t('search is case-insensitive and ignores surrounding space', () =>
    icons.searchIcons('  DOCKER ').join() === 'docker');
t('aliases find an icon by what it is used for, not what it is called', () => {
    const cases = [['k8s', 'kubernetes'], ['pihole', 'dns'], ['synology', 'nas'], ['pve', 'proxmox'],
        ['wireguard', 'vpn'], ['grafana', 'monitoring'], ['plex', 'media'], ['letsencrypt', 'certificate'],
        ['minecraft', 'game-server'], ['cron', 'scheduler'], ['samba', 'share'], ['jenkins', 'ci']];
    const bad = cases.filter(([q, want]) => !icons.searchIcons(q).includes(want));
    return bad.length === 0 || 'no hit for: ' + bad.map(b => b[0]).join(', ');
});
t('a partial word still matches', () => icons.searchIcons('kube').includes('kubernetes'));
t('a query that matches nothing returns nothing rather than everything', () =>
    icons.searchIcons('zzzznope').length === 0);
t('every alias points at an icon that exists', () =>
    Object.keys(icons.ALIASES).every(k => Object.prototype.hasOwnProperty.call(icons.ICONS, k)));

// --- the OS fallback ---
// A session with no icon picked shows the OS the app detected on connect. It is
// only ever a fallback: nothing is written to the vault.

t('detected operating systems map to a fitting icon', () => {
    const cases = [['Proxmox VE 8.2.4', 'proxmox'], ['Proxmox Backup Server', 'backup'],
        ['Ubuntu 24.04.1 LTS', 'ubuntu'], ['Debian GNU/Linux 12 (bookworm)', 'debian'],
        ['Raspbian GNU/Linux 11', 'debian'], ['Rocky Linux 9.4', 'linux'], ['Alpine Linux v3.20', 'linux'],
        ['Windows Server 2022', 'windows'], ['TrueNAS-13.0', 'nas'], ['pfSense 2.7', 'firewall'],
        ['FreeBSD 14.1', 'shield']];
    const bad = cases.filter(([os, want]) => icons.iconForOs(os) !== want);
    return bad.length === 0 || bad.map(b => b[0] + ' -> ' + icons.iconForOs(b[0])).join('; ');
});
t('a raspberry pi is matched ahead of the generic linux fallback', () =>
    icons.iconForOs('Raspberry Pi OS') === 'raspberry-pi');
t('an unknown or missing OS falls back to no icon at all', () =>
    icons.iconForOs('') === null && icons.iconForOs(null) === null &&
    icons.iconForOs(undefined) === null && icons.iconForOs('Plan 9') === null);
t('a non-string OS is handled rather than thrown on', () =>
    icons.iconForOs({}) === null && icons.iconForOs(42) === null);
t('a chosen icon always wins over the detected OS', () =>
    /const shown = s\.icon \|\| icons\.iconForOs\(s\.os\)/.test(sidebarSrc));
t('the OS fallback is display only and never written to the session', () =>
    !/s\.icon = icons\.iconForOs/.test(sidebarSrc));

// --- the picker ---

t('the picker has a search box', () => /id="ipSearch"/.test(modalsHtml));
t('typing filters the grid', () => /search\.addEventListener\('input'/.test(pickerSrc) && /icons\.searchIcons\(query\)/.test(pickerSrc));
t('the search is cleared and focused each time the picker opens', () =>
    /query = '';/.test(pickerSrc) && /ipSearch'\)\.value = ''/.test(pickerSrc) && /s\.focus\(\)/.test(pickerSrc));
t('a search with one hit can be taken with Enter', () => /hits\.length === 1/.test(pickerSrc));
t('an empty result says so instead of showing a blank grid', () => /No icon matches that/.test(pickerSrc));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
