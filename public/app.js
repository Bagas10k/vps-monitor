'use strict';
// Telemetry VPS: SSE 100 ms dari /monitor/stream. Proses + diagnosa datang 1x per detik.
// Angka besar = rata-rata 1 dtk (agar terbaca); grafik = sampel mentah 100 ms.
const $ = (id) => document.getElementById(id);
const RM = matchMedia('(prefers-reduced-motion: reduce)');
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
function fb(b) { let i = 0; while (b >= 1024 && i < UNITS.length - 1) { b /= 1024; i++; } return (i === 0 || b >= 100 ? b.toFixed(0) : b.toFixed(1)) + '\u00a0' + UNITS[i]; }
const fr = (b) => fb(b) + '/s';
const f1 = (v) => v.toFixed(1);
const LEVEL = { ok: 'Aman', warn: 'Perlu perhatian', hot: 'Berat' };
const SPAN = 60000; // jendela grafik 60 dtk
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const css = getComputedStyle(document.documentElement);
const C = { paper: css.getPropertyValue('--paper').trim(), amber: css.getPropertyValue('--amber').trim() };

let es = null, retry = null, live = false, raf = 0;
let tickMs = 100, procMs = 1000, skew = null, hist = [], lastAt = 0;
let coreEls = [], coreEma = [], procs = null, sortBy = 'cpu', diagKey = '';

function setConn(state, text) { const el = $('conn'); el.className = 'dot ' + state; el.textContent = text; }

function connect() {
  clearTimeout(retry);
  if (es) es.close();
  es = new EventSource('/monitor/stream');
  setConn('wait', 'menghubungkan');
  es.addEventListener('hello', (e) => {
    const h = JSON.parse(e.data);
    tickMs = h.tickMs || 100; procMs = h.procMs || 1000;
    $('host').textContent = h.host;
    $('info').textContent = `${h.cores} core · RAM ${fb(h.memTotal)} · kernel ${h.kernel}`;
    $('rate').textContent = `sampel ${tickMs} ms`;
    hist = h.history.slice();
    let sm = null; for (const r of hist) r[6] = sm = sm == null ? r[1] : sm * 0.65 + r[1] * 0.35; // kolom 6 = CPU dihaluskan untuk grafik
    if (hist.length) skew = Date.now() - hist[hist.length - 1][0];
    buildCores(h.cores);
  });
  es.onopen = () => { live = true; setConn('on', 'live'); kick(); };
  es.onmessage = (e) => onSample(JSON.parse(e.data));
  es.onerror = () => {
    live = false;
    if (es.readyState === EventSource.CLOSED) { // mis. sesi login habis -> redirect HTML
      setConn('off', 'terputus, mencoba lagi (bila terus gagal, periksa akses dashboard)');
      retry = setTimeout(connect, 3000);
    } else setConn('wait', 'menyambung ulang');
  };
}

// Tab tersembunyi: putus stream agar server berhenti memindai proses dan loop gambar berhenti.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(retry); live = false; if (es) { es.close(); es = null; } setConn('wait', 'dijeda (tab tersembunyi)'); }
  else connect();
});
RM.addEventListener('change', () => { draw(); kick(); });

setInterval(() => {
  if (!lastAt) return;
  const a = Date.now() - lastAt, el = $('age');
  el.textContent = `data ${a < 1000 ? a + ' ms' : (a / 1000).toFixed(1) + ' dtk'} lalu`;
  el.classList.toggle('stale', a > 3000);
}, 250);

function buildCores(n) {
  $('core-n').textContent = n + ' core';
  coreEls = []; coreEma = [];
  $('cores').replaceChildren(...Array.from({ length: n }, (_, i) => {
    const root = document.createElement('div'), col = document.createElement('div'), bar = document.createElement('i');
    const val = document.createElement('span'), lab = document.createElement('span');
    root.className = 'core'; col.className = 'col'; val.className = 'v'; lab.className = 'k';
    val.textContent = '-'; lab.textContent = 'c' + i;
    col.append(bar); root.append(val, col, lab);
    coreEls.push({ root, bar, val });
    return root;
  }));
}

function avg(k, n = 10) { const m = Math.min(n, hist.length); let s = 0; for (let i = hist.length - m; i < hist.length; i++) s += hist[i][k]; return m ? s / m : 0; }
function setW(id, frac) { $(id).style.transform = `scaleX(${Math.min(1, Math.max(0, frac)).toFixed(4)})`; }

function onSample(s) {
  lastAt = Date.now();
  const d = lastAt - s.t; skew = skew == null ? d : skew * 0.9 + d * 0.1;
  const memPct = (s.mem.used / s.mem.total) * 100;
  const prev = hist.length ? hist[hist.length - 1][6] : s.cpu.total;
  hist.push([s.t, s.cpu.total, memPct, s.net.rx, s.net.tx, s.disk.read + s.disk.write, prev * 0.65 + s.cpu.total * 0.35]);
  const cut = s.t - SPAN - 2000; let k = 0;
  while (k < hist.length && hist[k][0] < cut) k++;
  if (k) hist.splice(0, k);

  // CPU
  $('cpu-val').textContent = f1(avg(1));
  $('cpu-sub').textContent = `rata-rata 1 dtk · iowait ${f1(s.cpu.iowait)}% · steal ${f1(s.cpu.steal)}%`;
  $('load').textContent = `load ${s.cpu.load.map((v) => v.toFixed(2)).join(' / ')}  (1 · 5 · 15 mnt)`;
  s.cpu.cores.forEach((v, i) => {
    const el = coreEls[i]; if (!el) return;
    const e = coreEma[i] = coreEma[i] == null ? v : coreEma[i] * 0.7 + v * 0.3; // halus: per-core @100 ms beresolusi 10%
    el.bar.style.transform = `scaleY(${Math.min(1, e / 100).toFixed(3)})`;
    el.val.textContent = e.toFixed(0);
    el.root.classList.toggle('hot', e >= 85);
  });

  // RAM
  const m = s.mem, app = Math.max(0, m.total - m.free - m.buffers - m.cached);
  $('mem-pct').textContent = f1(avg(2));
  $('mem-sub2').textContent = `tersedia ${fb(m.avail)} dari ${fb(m.total)}`;
  $('mem-total').textContent = fb(m.total);
  $('st-app').style.width = (app / m.total * 100).toFixed(2) + '%';
  $('st-buf').style.width = (m.buffers / m.total * 100).toFixed(2) + '%';
  $('st-cache').style.width = (m.cached / m.total * 100).toFixed(2) + '%';
  $('kv-app').textContent = fb(app);
  $('kv-buf').textContent = fb(m.buffers);
  $('kv-cache').textContent = fb(m.cached);
  $('kv-free').textContent = fb(m.free);
  $('kv-avail').textContent = fb(m.avail);
  $('kv-swap').textContent = m.swapTotal ? `${fb(m.swapUsed)} / ${fb(m.swapTotal)}` : 'tidak ada';
  setW('swap-bar', m.swapTotal ? m.swapUsed / m.swapTotal : 0);

  // Disk
  $('disk-val').textContent = fr(avg(5));
  $('disk-sub').textContent = `100 ms terakhir: baca ${fr(s.disk.read)} · tulis ${fr(s.disk.write)} · sibuk ${f1(s.disk.util)}%`;
  if (s.procs || !$('disk-usage').childElementCount) renderUsage(s.disk.usage);

  // Network
  $('iface').textContent = s.net.iface || '';
  $('rx').textContent = fr(avg(3));
  $('tx').textContent = fr(avg(4));

  if (s.procs) {
    procs = s.procs;
    renderProcs();
    flip($('tb-groups'), procs.groups.slice(0, 8), (g) => g.group,
      '<td class="grp"></td><td class="n"></td><td class="n"></td><td class="n"></td>',
      (td, g) => { td[0].textContent = g.group; td[0].title = g.group; td[1].textContent = g.n; td[2].textContent = f1(g.cpu); td[3].textContent = fb(g.rss); });
    $('foot').textContent = `${procs.count} proses dipindai tiap ${procMs} ms · biaya sampling server ${s.cost} ms · CPU % proses = persen dari total seluruh core.`;
  }
  if (s.diag) renderDiag(s.diag);
  if (RM.matches) draw(); else kick();
}

function renderUsage(list) {
  $('disk-usage').replaceChildren(...list.map((d) => {
    const row = document.createElement('div'), a = document.createElement('span'), b = document.createElement('span');
    const track = document.createElement('div'), fill = document.createElement('i'), pct = d.used / d.total * 100;
    row.className = 'du'; track.className = 'bar';
    a.textContent = d.mount; b.textContent = `${fb(d.used)} / ${fb(d.total)} · ${pct.toFixed(0)}%`;
    fill.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
    if (pct >= 90) row.classList.add('hot');
    track.append(fill); row.append(a, b, track);
    return row;
  }));
}

function renderDiag(d) {
  const key = d.level + d.lines.join('|');
  if (key === diagKey) return; // jangan spam aria-live tiap detik
  diagKey = key;
  $('diag').className = 'diag ' + d.level;
  $('diag-level').textContent = LEVEL[d.level] || d.level;
  $('diag-lines').replaceChildren(...d.lines.map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
}

// Baris tabel dikunci per kunci (pid/grup) lalu dianimasikan FLIP saat urutan berubah.
function flip(tb, items, key, cols, fill) {
  const anim = !RM.matches, before = new Map(), old = new Map();
  for (const tr of tb.children) { old.set(tr.dataset.k, tr); if (anim) before.set(tr.dataset.k, tr.getBoundingClientRect().top); }
  const els = items.map((it) => {
    const k = String(key(it));
    let tr = old.get(k);
    // cols = template statis milik kode ini (tanpa data); semua isi data lewat textContent.
    if (!tr) { tr = document.createElement('tr'); tr.dataset.k = k; tr.innerHTML = cols; }
    fill(tr.children, it);
    return tr;
  });
  tb.replaceChildren(...els);
  if (!anim) return;
  for (const tr of els) {
    const b = before.get(tr.dataset.k);
    if (b === undefined) { tr.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' }); continue; }
    const dy = b - tr.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) tr.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 480, easing: EASE });
  }
}

function renderProcs() {
  if (!procs) return;
  const byCpu = sortBy === 'cpu', list = byCpu ? procs.byCpu : procs.byMem;
  let max = 0; for (const p of list) max = Math.max(max, byCpu ? p.cpu : p.rss);
  max = max || 1;
  flip($('tb-proc'), list, (p) => p.pid,
    '<td class="n"></td><td class="grp"></td><td class="cmd hide-sm"></td><td class="n"></td><td class="n"></td><td class="share hide-sm"><div class="bar"><i></i></div></td>',
    (td, p) => {
      td[0].textContent = p.pid; td[1].textContent = p.group; td[1].title = p.group;
      td[2].textContent = p.cmd; td[2].title = p.cmd;
      td[3].textContent = f1(p.cpu); td[4].textContent = fb(p.rss);
      td[5].firstChild.firstChild.style.transform = `scaleX(${((byCpu ? p.cpu : p.rss) / max).toFixed(3)})`;
    });
}

for (const b of document.querySelectorAll('#seg button')) b.addEventListener('click', () => {
  sortBy = b.dataset.v;
  $('seg').dataset.v = sortBy;
  for (const x of document.querySelectorAll('#seg button')) x.setAttribute('aria-pressed', String(x === b));
  $('th-cpu').setAttribute('aria-sort', sortBy === 'cpu' ? 'descending' : 'none');
  $('th-mem').setAttribute('aria-sort', sortBy === 'mem' ? 'descending' : 'none');
  renderProcs();
});

// ---------- canvas ----------
function fit(c) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return null;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

function line(g, w, h, now, k, max, color, dash, fill) {
  let x0 = null, x1 = 0, y1 = 0;
  g.beginPath();
  for (const r of hist) {
    const x = w * (1 - (now - r[0]) / SPAN);
    if (x < -20) continue;
    const y = h - 1 - Math.min(1, r[k] / max) * (h - 2);
    if (x0 === null) { g.moveTo(x, y); x0 = x; } else g.lineTo(x, y);
    x1 = x; y1 = y;
  }
  if (x0 === null) return null;
  g.setLineDash(dash || []); g.strokeStyle = color; g.lineWidth = 1.5; g.lineJoin = 'round';
  g.stroke();
  if (fill) { g.lineTo(x1, h); g.lineTo(x0, h); g.closePath(); g.fillStyle = fill; g.fill(); }
  return [x1, y1];
}

function draw() {
  // Kepala grafik tertinggal 1 tick agar bergeser mulus di 60 FPS di antara sampel 100 ms.
  const now = Date.now() - (skew || 0) - (RM.matches ? 0 : tickMs);
  const a = fit($('wave'));
  if (a) {
    const { g, w, h } = a;
    g.strokeStyle = 'rgba(245,242,235,0.08)'; g.lineWidth = 1; g.setLineDash([]);
    for (const p of [0.25, 0.5, 0.75]) { const y = Math.round(h * (1 - p)) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(245,242,235,0.18)'); grad.addColorStop(1, 'rgba(245,242,235,0)');
    line(g, w, h, now, 2, 100, C.amber);
    const head = line(g, w, h, now, 6, 100, C.paper, null, grad);
    if (head && head[0] <= w) { g.beginPath(); g.arc(head[0], head[1], 3, 0, Math.PI * 2); g.fillStyle = C.paper; g.fill(); }
  }
  mini('net', now, [[3, C.paper], [4, C.amber, [4, 3]]]);
  mini('disk', now, [[5, C.paper]]);
}

function mini(id, now, series) {
  const a = fit($(id)); if (!a) return;
  let max = 1024;
  for (const r of hist) for (const [k] of series) if (r[k] > max) max = r[k];
  for (const [k, col, dash] of series) line(a.g, a.w, a.h, now, k, max * 1.15, col, dash);
}

// Loop gambar hanya hidup selama stream live & tab terlihat; reduced-motion = gambar per sampel saja.
function loop() { raf = 0; draw(); if (live && !document.hidden && !RM.matches) raf = requestAnimationFrame(loop); }
function kick() { if (!raf && !RM.matches) raf = requestAnimationFrame(loop); }
window.addEventListener('resize', () => { if (RM.matches) draw(); });

connect();
