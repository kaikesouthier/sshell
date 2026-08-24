
const net = require('net');
const { execFile } = require('child_process');
const { escapeHtml, downloadText } = require('./util');

function openPortScanner() { require('./tabs').openToolTab('portscan', 'Port Scanner'); }
function openCidrPing() { require('./tabs').openToolTab('cidrping', 'CIDR Ping'); }

function buildToolView(tab) {
    const root = document.createElement('div');
    root.className = 'term-view bg-bg overflow-y-auto';
    root.style.display = 'none';
    document.getElementById('views').appendChild(root);
    tab.el = root;
    if (tab.toolType === 'portscan') buildPortScanner(tab, root);
    else buildCidrPing(tab, root);
}

function nowStamp() { return new Date().toISOString(); }
function filterRows(tbody, term) {
    term = (term || '').toLowerCase();
    tbody.querySelectorAll('tr').forEach(tr => { tr.style.display = (!term || tr.textContent.toLowerCase().includes(term)) ? '' : 'none'; });
}
function searchExportBar(prefix) {
    return `<div class="flex items-center gap-2">
        <div class="relative">
            <svg class="w-3.5 h-3.5 text-faint absolute left-2 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z"></path></svg>
            <input class="${prefix}-search bg-panel2 border border-edge rounded-md pl-7 pr-2 py-1 text-[11px] text-txt placeholder-faint focus:outline-none focus:border-accent w-40" placeholder="Filter">
        </div>
        <button class="${prefix}-exp-txt text-[11px] px-2 py-1 rounded-md bg-panel2 border border-edge text-muted hover:text-txt hover:border-accent transition-colors">Export TXT</button>
        <button class="${prefix}-exp-json text-[11px] px-2 py-1 rounded-md bg-panel2 border border-edge text-muted hover:text-txt hover:border-accent transition-colors">Export JSON</button>
    </div>`;
}

const SERVICES = {
    20: 'FTP-data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 37: 'Time', 43: 'WHOIS', 53: 'DNS',
    67: 'DHCP', 68: 'DHCP', 69: 'TFTP', 79: 'Finger', 80: 'HTTP', 88: 'Kerberos', 110: 'POP3', 111: 'RPCbind',
    113: 'Ident', 119: 'NNTP', 123: 'NTP', 135: 'MSRPC', 137: 'NetBIOS', 138: 'NetBIOS', 139: 'NetBIOS',
    143: 'IMAP', 161: 'SNMP', 162: 'SNMP', 179: 'BGP', 389: 'LDAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS',
    500: 'IKE', 514: 'Syslog', 515: 'LPD', 520: 'RIP', 587: 'SMTP', 623: 'IPMI', 636: 'LDAPS', 993: 'IMAPS',
    995: 'POP3S', 1025: 'MS-RPC', 1080: 'SOCKS', 1194: 'OpenVPN', 1433: 'MSSQL', 1521: 'Oracle', 1723: 'PPTP',
    1883: 'MQTT', 2049: 'NFS', 2082: 'cPanel', 2083: 'cPanel', 2181: 'ZooKeeper', 2222: 'SSH-alt', 2375: 'Docker',
    2376: 'Docker-TLS', 2483: 'Oracle', 2484: 'Oracle', 3000: 'Dev/Grafana', 3128: 'Squid', 3306: 'MySQL',
    3389: 'RDP', 3690: 'SVN', 4444: 'Metasploit', 4646: 'Nomad', 4789: 'VXLAN', 5000: 'UPnP/Flask', 5060: 'SIP',
    5432: 'PostgreSQL', 5555: 'ADB', 5601: 'Kibana', 5672: 'AMQP', 5900: 'VNC', 5984: 'CouchDB', 6000: 'X11',
    6379: 'Redis', 6443: 'K8s-API', 6667: 'IRC', 7001: 'WebLogic', 8000: 'HTTP-alt', 8008: 'HTTP-alt',
    8080: 'HTTP-proxy', 8081: 'HTTP-alt', 8083: 'HTTP-alt', 8086: 'InfluxDB', 8088: 'HTTP-alt', 8443: 'HTTPS-alt',
    8888: 'HTTP-alt', 9000: 'SonarQube', 9090: 'Prometheus', 9092: 'Kafka', 9200: 'Elasticsearch', 9300: 'Elastic',
    9418: 'Git', 9999: 'HTTP-alt', 10000: 'Webmin', 11211: 'Memcached', 15672: 'RabbitMQ', 27017: 'MongoDB',
    27018: 'MongoDB', 3299: 'SAP', 5938: 'TeamViewer', 6660: 'IRC', 8090: 'HTTP-alt'
};
const COMMON_PORTS = Object.keys(SERVICES).map(Number).sort((a, b) => a - b);

function classifyBanner(s) {
    if (/^SSH-/.test(s)) return 'SSH (' + (s.split(/\r?\n/)[0] || '').trim().slice(0, 40) + ')';
    if (/^HTTP\//.test(s)) { const m = /^Server:\s*(.+)$/im.exec(s); return 'HTTP' + (m ? ' (' + m[1].trim().slice(0, 30) + ')' : ''); }
    if (/^220[ -].*(ESMTP|SMTP)/i.test(s)) return 'SMTP';
    if (/^220[ -].*ftp/i.test(s)) return 'FTP';
    if (/^220[ -]/.test(s)) return 'FTP/SMTP';
    if (/^\+OK/.test(s)) return 'POP3';
    if (/^\*\s*OK.*IMAP/i.test(s)) return 'IMAP';
    if (/^RFB\s/.test(s)) return 'VNC';
    if (/^HELO|^EHLO/i.test(s)) return 'SMTP';
    if (/mysql|mariadb/i.test(s)) return 'MySQL';
    if (/^-ERR|redis/i.test(s)) return 'Redis';
    return null;
}
function genericBanner(s) {
    const line = (s.split(/\r?\n/)[0] || '').replace(/[^\x20-\x7e]/g, '').trim();
    return line ? 'banner: ' + line.slice(0, 40) : 'unknown';
}
function identifyService(host, port, timeout, cb) {
    const sock = new net.Socket();
    let buf = Buffer.alloc(0), done = false, probeTimer = null;
    const finish = svc => { if (done) return; done = true; clearTimeout(probeTimer); try { sock.destroy(); } catch (e) {} cb(svc); };
    sock.setTimeout(Math.max(1500, timeout));
    sock.on('connect', () => { probeTimer = setTimeout(() => { if (buf.length === 0) { try { sock.write('GET / HTTP/1.0\r\n\r\n'); } catch (e) {} } }, 500); });
    sock.on('data', d => { buf = Buffer.concat([buf, d]); const svc = classifyBanner(buf.toString('latin1')); if (svc || buf.length >= 160) finish(svc || genericBanner(buf.toString('latin1'))); });
    sock.on('timeout', () => finish(buf.length ? genericBanner(buf.toString('latin1')) : null));
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(buf.length ? genericBanner(buf.toString('latin1')) : null));
    try { sock.connect(port, host); } catch (e) { finish(null); }
    // Returned so Cancel and tab-close can destroy in-flight probes instead of
    // waiting out their timeout.
    return sock;
}

function buildPortScanner(tab, root) {
    root.innerHTML = `
    <div class="max-w-3xl mx-auto p-5 space-y-4">
        <div class="flex items-center gap-2 text-txt">
            <svg class="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M11 4.5a2.5 2.5 0 013.5 3.5L6 16.5l-3 .5.5-3L11 4.5z"></path></svg>
            <h2 class="font-semibold text-base">Port Scanner</h2>
        </div>
        <div class="bg-panel border border-edge rounded-lg p-4 space-y-3">
            <div>
                <label class="block text-[11px] font-semibold text-muted mb-1">Target IP / host</label>
                <input class="ps-host w-full bg-panel2 border border-edge rounded-md px-3 py-2 text-sm font-mono text-txt placeholder-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50" placeholder="192.168.1.1">
            </div>
            <div class="flex gap-3">
                <div class="flex-1"><label class="block text-[11px] font-semibold text-muted mb-1">Rate (ports/sec, max 5000)</label>
                    <input class="ps-rate w-full bg-panel2 border border-edge rounded-md px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent" type="number" value="1000" min="1" max="5000"></div>
                <div class="flex-1"><label class="block text-[11px] font-semibold text-muted mb-1">Timeout (ms, max 5000)</label>
                    <input class="ps-timeout w-full bg-panel2 border border-edge rounded-md px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent" type="number" value="1000" min="1" max="5000"></div>
            </div>
            <div>
                <label class="block text-[11px] font-semibold text-muted mb-1">Probe mode</label>
                <div class="flex bg-panel2 border border-edge rounded-md p-0.5 text-xs font-medium mb-2">
                    <button data-mode="known" class="ps-mode flex-1 py-1.5 rounded transition-colors">Known ports (${COMMON_PORTS.length})</button>
                    <button data-mode="range" class="ps-mode flex-1 py-1.5 rounded transition-colors">Port range</button>
                </div>
                <div class="ps-range hidden flex gap-3">
                    <div class="flex-1"><label class="block text-[11px] text-muted mb-1">Start</label><input class="ps-start w-full bg-panel2 border border-edge rounded-md px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent" type="number" value="1" min="1" max="65535"></div>
                    <div class="flex-1"><label class="block text-[11px] text-muted mb-1">End</label><input class="ps-end w-full bg-panel2 border border-edge rounded-md px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent" type="number" value="1024" min="1" max="65535"></div>
                </div>
            </div>
            <div class="ps-error hidden text-xs text-bad bg-bad/10 border border-bad/30 rounded-md px-3 py-2"></div>
            <div class="flex gap-2">
                <button class="ps-start-btn bg-accent hover:bg-accent-hover text-white text-xs font-semibold px-4 py-2 rounded-md transition-colors">Start Scan</button>
                <button class="ps-cancel-btn hidden bg-bad/20 text-bad border border-bad text-xs font-semibold px-4 py-2 rounded-md transition-colors">Cancel</button>
            </div>
        </div>
        <div class="bg-panel border border-edge rounded-lg p-4">
            <div class="flex items-center justify-between mb-2 text-xs">
                <span class="ps-status text-muted">Idle</span>
                <span class="ps-pct font-mono text-txt/90">0%</span>
            </div>
            <div class="h-2 rounded bg-panel3 overflow-hidden"><div class="ps-bar h-full bg-accent transition-all" style="width:0%"></div></div>
        </div>
        <div>
            <div class="flex items-center justify-between mb-2 gap-2">
                <div class="text-[11px] font-semibold tracking-widest text-faint uppercase">Open Ports (<span class="ps-count">0</span>)</div>
                ${searchExportBar('ps')}
            </div>
            <div class="border border-edge rounded-lg overflow-auto max-h-72">
                <table class="w-full text-[12px]"><thead class="sticky top-0 bg-panel text-faint"><tr class="text-left">
                    <th class="font-semibold px-3 py-2">Port</th><th class="font-semibold px-3 py-2">Service</th><th class="font-semibold px-3 py-2">State</th>
                </tr></thead><tbody class="ps-tbody"></tbody></table>
            </div>
        </div>
    </div>`;

    const q = s => root.querySelector(s);
    let mode = 'known';
    const state = { cancelled: false, timer: null, sockets: new Set(), idSockets: new Set(), done: 0, total: 0, open: 0, inFlight: 0, idx: 0, running: false, host: '', openList: [] };

    function setMode(m) {
        mode = m;
        root.querySelectorAll('.ps-mode').forEach(b => { const on = b.dataset.mode === m; b.classList.toggle('bg-accent', on); b.classList.toggle('text-white', on); b.classList.toggle('text-muted', !on); });
        q('.ps-range').classList.toggle('hidden', m !== 'range');
    }
    root.querySelectorAll('.ps-mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    setMode('known');

    function showErr(msg) { const e = q('.ps-error'); e.textContent = msg; e.classList.remove('hidden'); }
    function clearErr() { q('.ps-error').classList.add('hidden'); }

    function updateProgress() {
        const pct = state.total ? Math.round(100 * state.done / state.total) : 0;
        q('.ps-pct').textContent = pct + '%';
        q('.ps-bar').style.width = pct + '%';
        if (state.running) q('.ps-status').textContent = `Scanning… ${state.done} / ${state.total} probed · ${state.open} open`;
    }
    function addOpen(port, timeout) {
        state.open++;
        q('.ps-count').textContent = state.open;
        const known = SERVICES[port] || null;
        const entry = { port, service: known || (state.running ? 'identifying…' : 'unknown') };
        state.openList.push(entry);
        const tr = document.createElement('tr');
        tr.className = 'border-t border-edge/40';
        tr.dataset.port = port;
        tr.innerHTML = `<td class="px-3 py-1.5 font-mono text-ok font-semibold">${port}</td><td class="ps-svc px-3 py-1.5 text-txt/90">${escapeHtml(entry.service)}</td><td class="px-3 py-1.5"><span class="text-[10px] px-1.5 py-0.5 rounded bg-ok/15 text-ok font-semibold">open</span></td>`;
        q('.ps-tbody').appendChild(tr);
        filterRows(q('.ps-tbody'), q('.ps-search').value);
        if (!known) {
            // The probe can settle before identifyService returns, so track it by a box the callback can clear either way — otherwise a finished socket stays in…
            const slot = {};
            // A banner probe can outlive the scan that started it by seconds.
            // Rows are looked up by port alone, so without a generation check a
            // late reply from the previous host lands in this one's table.
            const gen = state.gen;
            slot.sock = identifyService(state.host, port, timeout, svc => {
                slot.done = true;
                if (slot.sock) state.idSockets.delete(slot.sock);
                if (gen !== state.gen) return;
                const label = svc || 'unknown';
                entry.service = label;
                const cell = q(`.ps-tbody tr[data-port="${port}"] .ps-svc`);
                if (cell) { cell.textContent = label; cell.classList.add('text-warn'); }
                filterRows(q('.ps-tbody'), q('.ps-search').value);
            });
            if (slot.sock && !slot.done) state.idSockets.add(slot.sock);
        }
    }

    function launchPort(host, port, timeout) {
        state.inFlight++;
        const sock = new net.Socket();
        state.sockets.add(sock);
        let settled = false;
        const finish = open => {
            if (settled) return; settled = true;
            state.sockets.delete(sock); try { sock.destroy(); } catch (e) {}
            state.inFlight--; state.done++;
            if (!state.cancelled) { if (open) addOpen(port, timeout); updateProgress(); if (state.done >= state.total) complete(); }
        };
        sock.setTimeout(timeout);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        try { sock.connect(port, host); } catch (e) { finish(false); }
    }

    function complete() {
        state.running = false;
        state.idSockets.forEach(s => { try { s.destroy(); } catch (e) {} });
        state.idSockets.clear();
        if (state.timer) { clearInterval(state.timer); state.timer = null; }
        q('.ps-status').textContent = `Done — ${state.total} ports probed, ${state.open} open`;
        q('.ps-start-btn').classList.remove('hidden');
        q('.ps-cancel-btn').classList.add('hidden');
    }
    function cancel() {
        if (!state.running) { state.idSockets.forEach(s => { try { s.destroy(); } catch (e) {} }); state.idSockets.clear(); return; }
        state.cancelled = true; state.running = false;
        if (state.timer) { clearInterval(state.timer); state.timer = null; }
        state.sockets.forEach(s => { try { s.destroy(); } catch (e) {} }); state.sockets.clear();
        state.idSockets.forEach(s => { try { s.destroy(); } catch (e) {} }); state.idSockets.clear();
        q('.ps-status').textContent = `Cancelled at ${state.done} / ${state.total}`;
        q('.ps-start-btn').classList.remove('hidden');
        q('.ps-cancel-btn').classList.add('hidden');
    }

    q('.ps-start-btn').addEventListener('click', () => {
        clearErr();
        const host = q('.ps-host').value.trim();
        if (!host) return showErr('Enter a target IP or host.');
        const rate = Math.min(5000, Math.max(1, parseInt(q('.ps-rate').value, 10) || 1000));
        const timeout = Math.min(5000, Math.max(1, parseInt(q('.ps-timeout').value, 10) || 1000));
        let ports;
        if (mode === 'known') ports = COMMON_PORTS.slice();
        else {
            const start = parseInt(q('.ps-start').value, 10), end = parseInt(q('.ps-end').value, 10);
            if (!(start >= 1 && start <= 65535) || !(end >= 1 && end <= 65535)) return showErr('Ports must be 1–65535.');
            if (start > end) return showErr('Start port must be ≤ end port.');
            ports = []; for (let p = start; p <= end; p++) ports.push(p);
        }
        state.idSockets.forEach(s => { try { s.destroy(); } catch (e) {} });
        state.idSockets.clear();
        Object.assign(state, { cancelled: false, done: 0, open: 0, inFlight: 0, idx: 0, total: ports.length, running: true, host, openList: [], gen: (state.gen || 0) + 1 });
        q('.ps-tbody').innerHTML = ''; q('.ps-count').textContent = '0';
        q('.ps-start-btn').classList.add('hidden'); q('.ps-cancel-btn').classList.remove('hidden');
        updateProgress();

        const perTick = Math.max(1, Math.ceil(rate / 20));
        const maxInFlight = Math.min(1500, Math.max(perTick, rate));
        state.timer = setInterval(() => {
            if (state.cancelled) { clearInterval(state.timer); state.timer = null; return; }
            for (let k = 0; k < perTick && state.idx < ports.length && state.inFlight < maxInFlight; k++) launchPort(host, ports[state.idx++], timeout);
            if (state.idx >= ports.length) { clearInterval(state.timer); state.timer = null; }
        }, 50);
    });
    q('.ps-cancel-btn').addEventListener('click', cancel);

    q('.ps-search').addEventListener('input', () => filterRows(q('.ps-tbody'), q('.ps-search').value));
    q('.ps-exp-txt').addEventListener('click', () => {
        const lines = [`SSHell — Port Scan`, `Target: ${state.host || q('.ps-host').value.trim()}`, `Scanned: ${nowStamp()}`, `Open ports: ${state.openList.length}`, ''];
        state.openList.sort((a, b) => a.port - b.port).forEach(o => lines.push(`${o.port}\t${o.service}`));
        downloadText('port-scan.txt', lines.join('\n'));
    });
    q('.ps-exp-json').addEventListener('click', () => {
        downloadText('port-scan.json', JSON.stringify({ target: state.host || q('.ps-host').value.trim(), scannedAt: nowStamp(), open: state.openList.slice().sort((a, b) => a.port - b.port) }, null, 2));
    });

    tab.tool = { destroy: cancel };
}

function ipToInt(ip) { const p = ip.split('.'); if (p.length !== 4) return null; let n = 0; for (const s of p) { const x = Number(s); if (!Number.isInteger(x) || x < 0 || x > 255 || s === '') return null; n = (n * 256) + x; } return n >>> 0; }
function intToIp(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }

function parseSpec(spec) {
    spec = spec.trim();
    if (spec.includes('/')) {
        const [ip, bitsS] = spec.split('/'); const base = ipToInt(ip); const bits = parseInt(bitsS, 10);
        if (base == null || isNaN(bits) || bits < 0 || bits > 32) return null;
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        const netw = (base & mask) >>> 0; const bcast = (netw | (~mask >>> 0)) >>> 0;
        return { start: netw, end: bcast };
    }
    if (spec.includes('-')) {
        const [a, b] = spec.split('-').map(s => s.trim());
        const start = ipToInt(a); if (start == null) return null;
        let end;
        if (b.includes('.')) end = ipToInt(b);
        else { const lo = parseInt(b, 10); if (isNaN(lo) || lo < 0 || lo > 255) return null; end = (((start & 0xffffff00) >>> 0) | lo) >>> 0; }
        if (end == null) return null;
        return { start: Math.min(start, end), end: Math.max(start, end) };
    }
    const one = ipToInt(spec); if (one == null) return null; return { start: one, end: one };
}
function expandSpecs(input) {
    const specs = input.split(',').map(s => s.trim()).filter(Boolean);
    if (!specs.length) return { error: 'Enter at least one IP range.' };
    const ips = [], seen = new Set();
    for (const s of specs) {
        const r = parseSpec(s);
        if (!r) return { error: 'Invalid range: ' + s };
        if (r.end - r.start > 65535) return { error: 'Range too large: ' + s + ' (max 65,536 IPs).' };
        for (let n = r.start; n <= r.end; n++) {
            if (!seen.has(n)) { seen.add(n); ips.push(intToIp(n)); if (ips.length > 65536) return { error: 'Too many IPs total (max 65,536).' }; }
        }
    }
    return { ips };
}

function pingOnce(ip, timeout, cb) {
    const isWin = process.platform === 'win32';
    const args = isWin ? ['-n', '1', '-w', String(timeout), ip] : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeout / 1000))), ip];

    let settled = false;
    const done = (err, ms) => { if (settled) return; settled = true; cb(err, ms); };

    let child;
    try {
        child = execFile('ping', args, { timeout: timeout + 3000, windowsHide: true }, (err, stdout) => {
            // ENOENT is "ping is not installed", not "the host is down" — telling
            // the user every address failed would send them debugging the network.
            if (err && err.code === 'ENOENT') { const e = new Error('ping-missing'); e.fatal = true; return done(e); }
            const out = stdout || '';
            const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(out);
            if (m) done(null, /time<\s*[\d.]+/i.test(out) ? 0 : parseFloat(m[1]));
            else done(new Error('no reply'));
        });
        child.on('error', e => {
            if (e && e.code === 'ENOENT') { const err = new Error('ping-missing'); err.fatal = true; return done(err); }
            done(e);
        });
    } catch (e) {
        const err = new Error('ping-missing'); err.fatal = true;
        setTimeout(() => done(err), 0);
        return null;
    }
    return child;
}

function buildCidrPing(tab, root) {
    root.innerHTML = `
    <div class="max-w-3xl mx-auto p-5 space-y-4">
        <div class="flex items-center gap-2 text-txt">
            <svg class="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M3 12h4l2 5 4-14 2 9h6"></path></svg>
            <h2 class="font-semibold text-base">CIDR Ping</h2>
        </div>
        <div class="bg-panel border border-edge rounded-lg p-4 space-y-3">
            <div>
                <label class="block text-[11px] font-semibold text-muted mb-1">IP ranges <span class="text-faint font-normal">— comma-separated. e.g. <span class="font-mono text-accent">1.1.1.0-1.1.1.254, 10.0.0.0/24, 192.168.1.5</span></span></label>
                <input class="cp-ranges w-full bg-panel2 border border-edge rounded-md px-3 py-2 text-sm font-mono text-txt placeholder-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50" placeholder="1.1.1.0-1.1.1.254">
            </div>
            <div class="flex gap-3">
                <div class="flex-1"><label class="block text-[11px] font-semibold text-muted mb-1">Timeout (ms, max 5000)</label>
                    <input class="cp-timeout w-full bg-panel2 border border-edge rounded-md px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent" type="number" value="1000" min="1" max="5000"></div>
                <div class="flex-1"><label class="block text-[11px] font-semibold text-muted mb-1">Concurrency (max 100)</label>
                    <input class="cp-conc w-full bg-panel2 border border-edge rounded-md px-3 py-2 text-sm text-txt focus:outline-none focus:border-accent" type="number" value="50" min="1" max="100"></div>
            </div>
            <div class="cp-error hidden text-xs text-bad bg-bad/10 border border-bad/30 rounded-md px-3 py-2"></div>
            <div class="flex gap-2">
                <button class="cp-start-btn bg-accent hover:bg-accent-hover text-white text-xs font-semibold px-4 py-2 rounded-md transition-colors">Ping</button>
                <button class="cp-cancel-btn hidden bg-bad/20 text-bad border border-bad text-xs font-semibold px-4 py-2 rounded-md transition-colors">Cancel</button>
            </div>
        </div>
        <div class="bg-panel border border-edge rounded-lg p-4">
            <div class="flex items-center justify-between mb-2 text-xs">
                <span class="cp-status text-muted">Idle</span>
                <span class="cp-pct font-mono text-txt/90">0%</span>
            </div>
            <div class="h-2 rounded bg-panel3 overflow-hidden mb-3"><div class="cp-bar h-full bg-accent transition-all" style="width:0%"></div></div>
            <div class="grid grid-cols-5 gap-2 text-center">
                ${['Replied', 'Failed', 'Avg', 'Min', 'Max'].map((l, i) => `<div class="bg-panel2 border border-edge rounded-md py-2"><div class="text-[10px] text-faint uppercase tracking-wide">${l}</div><div class="cp-stat-${i} text-sm font-mono font-semibold ${i === 0 ? 'text-ok' : i === 1 ? 'text-bad' : 'text-txt'}">—</div></div>`).join('')}
            </div>
        </div>
        <div>
            <div class="flex items-center justify-between mb-2 gap-2">
                <div class="text-[11px] font-semibold tracking-widest text-faint uppercase">Alive Hosts (<span class="cp-count">0</span>)</div>
                ${searchExportBar('cp')}
            </div>
            <div class="border border-edge rounded-lg overflow-auto max-h-72">
                <table class="w-full text-[12px]"><thead class="sticky top-0 bg-panel text-faint"><tr class="text-left">
                    <th class="font-semibold px-3 py-2">IP Address</th><th class="font-semibold px-3 py-2 text-right">Response</th>
                </tr></thead><tbody class="cp-tbody"></tbody></table>
            </div>
        </div>
    </div>`;

    const q = s => root.querySelector(s);
    const state = { cancelled: false, running: false, idx: 0, active: 0, completed: 0, total: 0, replied: 0, failed: 0, times: [], children: new Set(), alive: [] };

    function showErr(m) { const e = q('.cp-error'); e.textContent = m; e.classList.remove('hidden'); }
    function clearErr() { q('.cp-error').classList.add('hidden'); }
    function stat(i, v) { q('.cp-stat-' + i).textContent = v; }
    function updateStats() {
        stat(0, state.replied); stat(1, state.failed);
        if (state.times.length) {
            const avg = state.times.reduce((a, b) => a + b, 0) / state.times.length;
            stat(2, avg.toFixed(1) + 'ms'); stat(3, Math.min(...state.times).toFixed(1) + 'ms'); stat(4, Math.max(...state.times).toFixed(1) + 'ms');
        }
        const pct = state.total ? Math.round(100 * state.completed / state.total) : 0;
        q('.cp-pct').textContent = pct + '%'; q('.cp-bar').style.width = pct + '%';
        if (state.running) q('.cp-status').textContent = `Pinging… ${state.completed} / ${state.total}`;
    }
    function addAlive(ip, ms) {
        state.alive.push({ ip, ms });
        q('.cp-count').textContent = state.replied;
        const tr = document.createElement('tr'); tr.className = 'border-t border-edge/40';
        const cls = ms < 50 ? 'text-ok' : ms < 200 ? 'text-warn' : 'text-bad';
        tr.innerHTML = `<td class="px-3 py-1.5 font-mono text-txt/90">${escapeHtml(ip)}</td><td class="px-3 py-1.5 text-right font-mono ${cls}">${ms === 0 ? '<1' : ms.toFixed(1)} ms</td>`;
        q('.cp-tbody').appendChild(tr);
        filterRows(q('.cp-tbody'), q('.cp-search').value);
    }
    function finish() {
        state.running = false;
        q('.cp-status').textContent = `Done — ${state.replied} replied, ${state.failed} failed of ${state.total}`;
        q('.cp-start-btn').classList.remove('hidden'); q('.cp-cancel-btn').classList.add('hidden');
    }
    function cancel() {
        if (!state.running) return;
        state.cancelled = true; state.running = false;
        state.children.forEach(c => { try { c.kill(); } catch (e) {} });
        state.children.clear();
        q('.cp-status').textContent = `Cancelled at ${state.completed} / ${state.total}`;
        q('.cp-start-btn').classList.remove('hidden'); q('.cp-cancel-btn').classList.add('hidden');
    }
    function summary() {
        const t = state.times;
        return { replied: state.replied, failed: state.failed, total: state.total,
            avgMs: t.length ? +(t.reduce((a, b) => a + b, 0) / t.length).toFixed(2) : null,
            minMs: t.length ? Math.min(...t) : null, maxMs: t.length ? Math.max(...t) : null };
    }

    q('.cp-start-btn').addEventListener('click', () => {
        clearErr();
        const res = expandSpecs(q('.cp-ranges').value);
        if (res.error) return showErr(res.error);
        const ips = res.ips;
        const timeout = Math.min(5000, Math.max(1, parseInt(q('.cp-timeout').value, 10) || 1000));
        const conc = Math.min(100, Math.max(1, parseInt(q('.cp-conc').value, 10) || 50));

        Object.assign(state, { cancelled: false, running: true, idx: 0, active: 0, completed: 0, total: ips.length, replied: 0, failed: 0, times: [], alive: [] });
        state.children.clear();
        q('.cp-tbody').innerHTML = ''; q('.cp-count').textContent = '0';
        [2, 3, 4].forEach(i => stat(i, '—'));
        q('.cp-start-btn').classList.add('hidden'); q('.cp-cancel-btn').classList.remove('hidden');
        updateStats();

        function pump() {
            if (state.cancelled) return;
            while (state.active < conc && state.idx < ips.length) {
                const ip = ips[state.idx++]; state.active++;
                const slot = {};
                slot.child = pingOnce(ip, timeout, (err, ms) => {
                    if (slot.child) state.children.delete(slot.child);
                    slot.done = true;
                    state.active--; state.completed++;
                    if (state.cancelled) return;
                    if (err && err.fatal) {
                        state.cancelled = true; state.running = false;
                        state.children.forEach(c => { try { c.kill(); } catch (e) {} });
                        state.children.clear();
                        q('.cp-start-btn').classList.remove('hidden'); q('.cp-cancel-btn').classList.add('hidden');
                        q('.cp-status').textContent = 'Stopped — the system ping command was not found';
                        return showErr('Could not run "ping". It is not installed or not on this system\'s PATH.');
                    }
                    if (!err) { state.replied++; state.times.push(ms); addAlive(ip, ms); } else state.failed++;
                    updateStats();
                    if (state.completed >= state.total) finish(); else pump();
                });
                if (slot.child && !slot.done) state.children.add(slot.child);
            }
        }
        pump();
    });
    q('.cp-cancel-btn').addEventListener('click', cancel);

    q('.cp-search').addEventListener('input', () => filterRows(q('.cp-tbody'), q('.cp-search').value));
    q('.cp-exp-txt').addEventListener('click', () => {
        const s = summary();
        const lines = [`SSHell — CIDR Ping`, `Ranges: ${q('.cp-ranges').value.trim()}`, `Pinged: ${nowStamp()}`,
            `Replied: ${s.replied}  Failed: ${s.failed}  Avg: ${s.avgMs ?? '-'}ms  Min: ${s.minMs ?? '-'}ms  Max: ${s.maxMs ?? '-'}ms`, ''];
        state.alive.forEach(a => lines.push(`${a.ip}\t${a.ms === 0 ? '<1' : a.ms}ms`));
        downloadText('cidr-ping.txt', lines.join('\n'));
    });
    q('.cp-exp-json').addEventListener('click', () => {
        downloadText('cidr-ping.json', JSON.stringify({ ranges: q('.cp-ranges').value.trim(), pingedAt: nowStamp(), summary: summary(), alive: state.alive }, null, 2));
    });

    tab.tool = { destroy: cancel };
}

module.exports = { openPortScanner, openCidrPing, buildToolView };
