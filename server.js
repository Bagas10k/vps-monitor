'use strict';
// VPS Monitor — zero-dependency. Baca /proc tiap 100 ms (proses tiap 1 s), kirim via SSE.
// Bind ke 127.0.0.1; jika diproksi, lindungi dashboard dan SSE dengan autentikasi.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 3091);
const HOST = '127.0.0.1';
const TICK_MS = 100;
const PROC_EVERY = 10;               // pindai proses + diagnosa tiap 10 tick = 1 s
const HISTORY_MAX = 36000;           // 1 jam @ 100 ms, in-memory saja
const HZ = 100;                      // getconf CLK_TCK
const PAGE = 4096;                   // getconf PAGESIZE
const NCPU = os.cpus().length;
const TOP_N = 8;
const PUB = path.join(__dirname, 'public');

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// ---------- uid -> nama user ----------
const users = new Map();
for (const line of (read('/etc/passwd') || '').split('\n')) {
  const p = line.split(':');
  if (p.length > 2) users.set(Number(p[2]), p[0]);
}

// ---------- nama container docker (refresh 30 s) ----------
let dockerNames = new Map();
function refreshDocker() {
  execFile('docker', ['ps', '--no-trunc', '--format', '{{.ID}} {{.Names}}'], { timeout: 5000 }, (err, out) => {
    if (err) return;
    const m = new Map();
    for (const l of out.trim().split('\n')) { const [id, name] = l.split(' '); if (id) m.set(id, name); }
    dockerNames = m;
  });
}
refreshDocker();
setInterval(refreshDocker, 30000).unref();

// ---------- CPU ----------
// ponytail: USER_HZ=100 -> per-core @100 ms beresolusi 10%; grafik dihaluskan di klien, diagnosa pakai jendela 1 s.
const cpuFast = { prev: null }, cpuSlow = { prev: null };
function sampleCpu(st) {
  const prevCpu = st.prev;
  const lines = (read('/proc/stat') || '').split('\n').filter((l) => l.startsWith('cpu'));
  const cur = lines.map((l) => l.trim().split(/\s+/).slice(1, 9).map(Number));
  let out = { total: 0, iowait: 0, steal: 0, cores: [] };
  if (prevCpu) {
    const calc = (a, b) => {
      const d = a.map((v, i) => v - b[i]);
      const tot = d.reduce((s, v) => s + v, 0) || 1;
      const idle = d[3], io = d[4], steal = d[7];
      return { busy: ((tot - idle - io) / tot) * 100, io: (io / tot) * 100, steal: (steal / tot) * 100 };
    };
    const all = calc(cur[0], prevCpu[0]);
    out = {
      total: all.busy, iowait: all.io, steal: all.steal,
      cores: cur.slice(1).map((c, i) => calc(c, prevCpu[i + 1]).busy),
    };
  }
  st.prev = cur;
  const la = (read('/proc/loadavg') || '0 0 0').split(' ').slice(0, 3).map(Number);
  out.load = la;
  return out;
}

// ---------- RAM ----------
function sampleMem() {
  const m = {};
  for (const l of (read('/proc/meminfo') || '').split('\n')) {
    const k = l.match(/^(\w+):\s+(\d+)/);
    if (k) m[k[1]] = Number(k[2]) * 1024;
  }
  const total = m.MemTotal || 1, avail = m.MemAvailable || 0;
  const swapUsed = (m.SwapTotal || 0) - (m.SwapFree || 0);
  return { total, used: total - avail, avail, free: m.MemFree || 0, buffers: m.Buffers || 0, cached: (m.Cached || 0) + (m.SReclaimable || 0), swapTotal: m.SwapTotal || 0, swapUsed };
}

// ---------- Disk usage (refresh 5 s) + IO ----------
let diskUsage = [];
function refreshDiskUsage() {
  const seen = new Set(), res = [];
  for (const l of (read('/proc/mounts') || '').split('\n')) {
    const [dev, mnt, type] = l.split(' ');
    if (!/^(ext[234]|xfs|btrfs|zfs|f2fs)$/.test(type) || seen.has(dev)) continue;
    if (mnt.startsWith('/snap') || mnt.startsWith('/var/lib/docker')) continue;
    seen.add(dev);
    try {
      const s = fs.statfsSync(mnt);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      res.push({ mount: mnt, total, used: total - free });
    } catch {}
  }
  diskUsage = res;
}
refreshDiskUsage();
setInterval(refreshDiskUsage, 5000).unref();

let prevDisk = null;
function sampleDiskIo(dt) {
  let rd = 0, wr = 0, busyMs = 0, n = 0;
  for (const l of (read('/proc/diskstats') || '').split('\n')) {
    const f = l.trim().split(/\s+/);
    if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+)$/.test(f[2] || '')) continue;
    rd += Number(f[5]) * 512; wr += Number(f[9]) * 512; busyMs = Math.max(busyMs, Number(f[12])); n++;
  }
  const cur = { rd, wr, busyMs };
  let out = { read: 0, write: 0, util: 0 };
  if (prevDisk && dt > 0) {
    out = {
      read: Math.max(0, (rd - prevDisk.rd) / dt),
      write: Math.max(0, (wr - prevDisk.wr) / dt),
      util: Math.min(100, Math.max(0, ((busyMs - prevDisk.busyMs) / (dt * 1000)) * 100)),
    };
  }
  prevDisk = cur;
  return out;
}

// ---------- Network (interface default route) ----------
function defaultIface() {
  for (const l of (read('/proc/net/route') || '').split('\n').slice(1)) {
    const f = l.split('\t');
    if (f[1] === '00000000') return f[0];
  }
  return null;
}
let iface = defaultIface();
let prevNet = null;
function sampleNet(dt) {
  let rx = 0, tx = 0;
  for (const l of (read('/proc/net/dev') || '').split('\n').slice(2)) {
    const [name, rest] = l.split(':');
    if (!rest || name.trim() !== iface) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx = f[0]; tx = f[8];
  }
  let out = { iface, rx: 0, tx: 0 };
  if (prevNet && dt > 0) out = { iface, rx: Math.max(0, (rx - prevNet.rx) / dt), tx: Math.max(0, (tx - prevNet.tx) / dt) };
  prevNet = { rx, tx };
  return out;
}

// ---------- Proses ----------
const SECRET_RE = /((?:--?|\b)(?:token|api[-_]?key|key|secret|password|passwd|pass|auth)[-_a-z]*[= ])(\S+)/gi;
function cleanCmd(raw, comm) {
  if (!raw) return `[${comm}]`;
  let c = raw.replace(/\0+$/, '').split('\0').join(' ');
  c = c.replace(SECRET_RE, (m, k, v) => (/\//.test(v) && /file/i.test(k) ? m : `${k}***`));
  c = c.replace(/(^|[\s=:])[A-Za-z0-9_\-+=]{40,}(?=\s|$)/g, '$1***'); // token panjang tunggal, bukan path
  return c.length > 160 ? c.slice(0, 157) + '...' : c;
}

function parentGroup(pid, depth) {
  if (depth > 6) return null;
  const st = read(`/proc/${pid}/stat`);
  if (!st) return null;
  const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
  if (ppid <= 1) return null;
  const pm = meta.get(ppid);
  return pm ? pm.group : groupOf(ppid, 0, depth + 1);
}

// Kelompok = "aplikasi pemilik" proses: container docker, app pm2, atau unit systemd.
// Anak proses (mis. Chromium milik app pm2) diwariskan ke kelompok induknya.
function groupOf(pid, uid, depth = 0) {
  const cg = (read(`/proc/${pid}/cgroup`) || '').trim().split('\n').pop() || '';
  const p = cg.split('::')[1] || cg;
  let m;
  if ((m = p.match(/docker-([0-9a-f]{64})\.scope/)) || (m = p.match(/\/docker\/([0-9a-f]{64})/))) {
    return 'docker:' + (dockerNames.get(m[1]) || m[1].slice(0, 12));
  }
  if (/app-[\w.\-]+-\d+\.scope$/.test(p)) return parentGroup(pid, depth) || p.split('/').pop();
  if (/pm2/.test(p)) {
    const env = read(`/proc/${pid}/environ`);
    const nm = env && env.split('\0').find((e) => e.startsWith('name='));
    if (nm) return 'pm2:' + nm.slice(5);
    if (/^PM2 /.test(read(`/proc/${pid}/comm`) || '')) return 'pm2:daemon';
    return parentGroup(pid, depth) || 'pm2:daemon';
  }
  if ((m = p.match(/([\w@.\-]+)\.service$/))) return m[1].replace(/@\d+$/, '');
  if (/session-\d+\.scope/.test(p)) return 'sesi-ssh';
  if (p === '/' || p === '') return uid === 0 ? 'kernel' : 'lainnya';
  if (/init\.scope/.test(p)) return 'systemd';
  return p.split('/').pop() || 'lainnya';
}

const meta = new Map();   // pid -> {start, cmd, name, user, group}
let prevTicks = new Map(); // pid -> ticks
let lastProcAt = 0;

function sampleProcs() {
  const now = Date.now();
  const dt = lastProcAt ? (now - lastProcAt) / 1000 : 0;
  lastProcAt = now;
  const ticks = new Map(), alive = new Set(), list = [];
  let names;
  try { names = fs.readdirSync('/proc'); } catch { names = []; }
  for (const d of names) {
    if (d.charCodeAt(0) > 57) continue;
    const pid = Number(d);
    if (!pid) continue;
    const st = read(`/proc/${pid}/stat`);
    if (!st) continue;
    const rp = st.lastIndexOf(')');
    const comm = st.slice(st.indexOf('(') + 1, rp);
    const r = st.slice(rp + 2).split(' ');
    const t = Number(r[11]) + Number(r[12]);
    const start = r[19];
    const rss = Number(r[21]) * PAGE;
    if (rss === 0 && r[0] !== 'R') { // kernel thread menganggur: lewati
      if (!(prevTicks.get(pid) < t)) { ticks.set(pid, t); continue; }
    }
    ticks.set(pid, t);
    alive.add(pid);
    let mt = meta.get(pid);
    if (!mt || mt.start !== start) {
      let uid = 0;
      try { uid = fs.statSync(`/proc/${pid}`).uid; } catch {}
      mt = { start, name: comm, user: users.get(uid) || String(uid), cmd: cleanCmd(read(`/proc/${pid}/cmdline`), comm), group: groupOf(pid, uid) };
      meta.set(pid, mt);
    }
    const pt = prevTicks.get(pid);
    const cpu = dt > 0 && pt !== undefined ? Math.max(0, ((t - pt) / (HZ * dt * NCPU)) * 100) : 0;
    list.push({ pid, name: mt.name, user: mt.user, group: mt.group, cmd: mt.cmd, cpu, rss, thr: Number(r[17]), state: r[0] });
  }
  for (const pid of meta.keys()) if (!alive.has(pid)) meta.delete(pid);
  prevTicks = ticks;

  const byCpu = [...list].sort((a, b) => b.cpu - a.cpu).slice(0, TOP_N);
  const byMem = [...list].sort((a, b) => b.rss - a.rss).slice(0, TOP_N);
  const g = new Map();
  for (const p of list) {
    const x = g.get(p.group) || { group: p.group, cpu: 0, rss: 0, n: 0 };
    x.cpu += p.cpu; x.rss += p.rss; x.n++;
    g.set(p.group, x);
  }
  const groups = [...g.values()].sort((a, b) => (b.cpu * 4 + b.rss / 2 ** 30) - (a.cpu * 4 + a.rss / 2 ** 30)).slice(0, TOP_N);
  return { count: list.length, byCpu, byMem, groups };
}

// ---------- Diagnosa bahasa awam ----------
const gb = (b) => (b / 2 ** 30).toFixed(1) + ' GB';
function diagnose(s) {
  const out = [];
  const memPct = (s.mem.used / s.mem.total) * 100;
  const topCpu = s.procs && s.procs.groups.slice().sort((a, b) => b.cpu - a.cpu)[0];
  const topMem = s.procs && s.procs.groups.slice().sort((a, b) => b.rss - a.rss)[0];
  let level = 'ok';
  if (s.cpu.total > 85) { level = 'hot'; out.push(`CPU hampir penuh (${s.cpu.total.toFixed(0)}%).`); }
  else if (s.cpu.total > 60) { level = 'warn'; out.push(`CPU sibuk (${s.cpu.total.toFixed(0)}%).`); }
  if (memPct > 90) { level = 'hot'; out.push(`RAM menipis, sisa ${gb(s.mem.avail)}.`); }
  else if (memPct > 75) { if (level === 'ok') level = 'warn'; out.push(`RAM terpakai ${memPct.toFixed(0)}%.`); }
  if (s.mem.swapTotal && s.mem.swapUsed / s.mem.swapTotal > 0.5) { if (level === 'ok') level = 'warn'; out.push(`Swap terpakai ${gb(s.mem.swapUsed)} — server mulai lambat karena RAM kurang.`); }
  if (s.cpu.iowait > 10 || s.disk.util > 80) { if (level === 'ok') level = 'warn'; out.push(`Disk jadi hambatan (iowait ${s.cpu.iowait.toFixed(0)}%, sibuk ${s.disk.util.toFixed(0)}%).`); }
  if (s.cpu.steal > 10) { if (level === 'ok') level = 'warn'; out.push(`CPU dipakai tetangga VPS (steal ${s.cpu.steal.toFixed(0)}%).`); }
  if (!out.length) out.push('Normal — tidak ada sumber daya yang tertekan.');
  if (topCpu && topCpu.cpu >= 1) out.push(`Pemakan CPU terbesar: ${topCpu.group} (${topCpu.cpu.toFixed(1)}% dari total ${NCPU} core).`);
  if (topMem) out.push(`Pemakan RAM terbesar: ${topMem.group} (${gb(topMem.rss)}).`);
  return { level, lines: out };
}

// ---------- Loop ----------
const history = [];
const clients = new Set();
let lastAt = 0, tickCost = 0, n = 0, lastProcs = null;

function tick() {
  const t0 = process.hrtime.bigint();
  const now = Date.now();
  const dt = lastAt ? (now - lastAt) / 1000 : 0;
  lastAt = now;
  const slow = n++ % PROC_EVERY === 0;
  const s = {
    t: now,
    cpu: sampleCpu(cpuFast),
    mem: sampleMem(),
    disk: { ...sampleDiskIo(dt), usage: diskUsage },
    net: sampleNet(dt),
  };
  if (!clients.size) lastProcAt = 0;
  if (slow) { // payload proses + diagnosa hanya 1x per detik agar SSE tetap ringan
    if (clients.size) lastProcs = s.procs = sampleProcs();
    s.diag = diagnose({ ...s, cpu: sampleCpu(cpuSlow), procs: lastProcs });
  }
  if (dt) history.push([now, +s.cpu.total.toFixed(1), +((s.mem.used / s.mem.total) * 100).toFixed(1), Math.round(s.net.rx), Math.round(s.net.tx), Math.round(s.disk.read + s.disk.write)]);
  if (history.length > HISTORY_MAX) history.shift();
  tickCost = Number(process.hrtime.bigint() - t0) / 1e6;
  s.cost = +tickCost.toFixed(1);
  if (clients.size) {
    const msg = `data: ${JSON.stringify(s)}\n\n`;
    for (const res of clients) res.write(msg);
  }
}
setInterval(tick, TICK_MS);
setInterval(() => { iface = defaultIface() || iface; }, 60000).unref();
tick();

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' };
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/monitor(?=\/|$)/, '') || '/';

  if (p === '/stream') {
    res.writeHead(200, { ...SEC, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    const info = { host: os.hostname(), cores: NCPU, memTotal: os.totalmem(), kernel: os.release(), uptime: os.uptime(), tickMs: TICK_MS, procMs: TICK_MS * PROC_EVERY, history: history.slice(-600) };
    res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify(info)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/tick') { // uji buffering proxy/Cloudflare: 6 event lalu tutup, tanpa data sensitif
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    let n = 0;
    const iv = setInterval(() => { res.write(`data: ${Date.now()}\n\n`); if (++n >= 6) { clearInterval(iv); res.end(); } }, TICK_MS);
    req.on('close', () => clearInterval(iv));
    return;
  }
  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, clients: clients.size, history: history.length, tickCostMs: +tickCost.toFixed(1), rssMB: +(process.memoryUsage().rss / 2 ** 20).toFixed(1) }));
  }
  const file = p === '/' ? 'index.html' : p.slice(1);
  if (!/^(fonts\/)?[\w.-]+\.(html|js|css|woff2)$/.test(file)) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(path.join(PUB, file), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { ...SEC, 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': file.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(buf);
  });
}).listen(PORT, HOST, () => console.log(`[vps-monitor] http://${HOST}:${PORT}/monitor/  tick=${TICK_MS}ms`));
