'use strict';

// Map is W x H units; 1 unit = 10 m, so the map is 10 km x 6.5 km.
const W = 1000, H = 650, UNIT_M = 10;
const COLORS = ['#e6194b', '#4363d8', '#f58231', '#3cb44b', '#911eb4', '#42b4d4', '#f032e6', '#9a6324', '#469990', '#808000'];

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');

const S = {
  mode: 'delivery',
  phase: 'setup',            // setup | running | paused
  orders: [], stores: [], drivers: [],
  ids: { order: 1, store: 1, driver: 1 },
  simTime: 0,
  metrics: null,
  replanning: false,
  replanQueued: false,
  version: 0,                // bumped on every setup edit; stale previews are discarded
  snapshot: null,
  spawnClock: 0,
  allDone: true,
  hover: null,
};

// ---------- helpers ----------

const num = (id, def) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : def; };
const fmtMin = (t) => `${t.toFixed(1)} min`;
const fmtKm = (units) => `${(units * UNIT_M / 1000).toFixed(1)} km`;
const orderById = (id) => S.orders.find((o) => o.id === id);
const storeById = (id) => S.stores.find((s) => s.id === id);
const driverById = (id) => S.drivers.find((d) => d.id === id);

function settings() {
  return {
    speed: Math.max(1, num('speed', 25)) * 1000 / 60 / UNIT_M, // map units per minute
    capacity: Math.max(1, Math.round(num('capacity', 3))),
    pickup_time: Math.max(0, num('pickup', 1)),
    dropoff_time: Math.max(0, num('dropoff', 0.5)),
    objective: $('objective').value,
  };
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function log(msg, cls) {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  li.innerHTML = `<span class="t">${S.phase === 'setup' ? 'setup' : 'T+' + S.simTime.toFixed(1)}</span>`;
  li.append(msg);
  const ol = $('log');
  ol.prepend(li);
  while (ol.children.length > 100) ol.lastChild.remove();
}

const randomPoint = (m = 30) => ({ x: m + Math.random() * (W - 2 * m), y: m + Math.random() * (H - 2 * m) });

// ---------- entities ----------

function addOrder(x, y) {
  const n = S.ids.order++;
  const o = { id: 'o' + n, label: '#' + n, x, y, created: S.simTime, status: 'pending', driver: null, eta: null, deliveredAt: null };
  S.orders.push(o);
  S.allDone = false;
  return o;
}
function addStore(x, y) {
  const n = S.ids.store++;
  const s = { id: 's' + n, label: 'S' + n, x, y };
  S.stores.push(s);
  return s;
}
function addDriver(x, y) {
  const n = S.ids.driver++;
  const d = { id: 'd' + n, label: 'D' + n, x, y, color: COLORS[(n - 1) % COLORS.length],
    onboard: [], plan: [], wait: 0, distance: 0, delivered: 0, finish: null, trail: [] };
  S.drivers.push(d);
  return d;
}

function randomize(kind) {
  if (kind === 'orders') { S.orders = []; S.ids.order = 1; for (let i = 0; i < num('nOrders', 20); i++) { const p = randomPoint(); addOrder(p.x, p.y); } }
  if (kind === 'stores') { S.stores = []; S.ids.store = 1; for (let i = 0; i < num('nStores', 3); i++) { const p = randomPoint(60); addStore(p.x, p.y); } }
  if (kind === 'drivers') { S.drivers = []; S.ids.driver = 1; for (let i = 0; i < num('nDrivers', 4); i++) { const p = randomPoint(); addDriver(p.x, p.y); } }
  invalidatePlan();
}

function invalidatePlan() {
  S.version++;
  S.metrics = null;
  for (const d of S.drivers) { d.plan = []; d.finish = null; }
  for (const o of S.orders) { o.status = 'pending'; o.driver = null; o.eta = null; }
}

function nearestEntity(p, maxDist = 16) {
  let best = null, bestD = maxDist;
  const check = (list, kind) => {
    for (const e of list) {
      const dd = Math.hypot(e.x - p.x, e.y - p.y);
      if (dd < bestD) { bestD = dd; best = { kind, e }; }
    }
  };
  check(S.orders, 'order'); check(S.stores, 'store'); check(S.drivers, 'driver');
  return best;
}

function takeSnapshot() {
  return JSON.parse(JSON.stringify({
    ids: S.ids,
    orders: S.orders.map(({ id, label, x, y }) => ({ id, label, x, y })),
    stores: S.stores,
    drivers: S.drivers.map(({ id, label, x, y, color }) => ({ id, label, x, y, color })),
  }));
}
function restoreSnapshot(snap) {
  S.ids = { ...snap.ids };
  S.stores = snap.stores;
  S.orders = snap.orders.map((o) => ({ ...o, created: 0, status: 'pending', driver: null, eta: null, deliveredAt: null }));
  S.drivers = snap.drivers.map((d) => ({ ...d, onboard: [], plan: [], wait: 0, distance: 0, delivered: 0, finish: null, trail: [] }));
}

// ---------- optimizer ----------

// The solver (optimizer.js) runs in a Web Worker. Browsers block workers on
// file:// pages, so if the worker can't start we solve on the main thread instead.
let worker = null;
let solveSeq = 0;
const pendingSolves = new Map();

function failoverToMainThread() {
  worker = null;
  for (const [id, p] of pendingSolves) {
    pendingSolves.delete(id);
    try { p.resolve(window.solveDispatch(p.payload)); } catch (err) { p.reject(err); }
  }
}

try {
  worker = new Worker('worker.js');
  worker.onmessage = (e) => {
    const p = pendingSolves.get(e.data.id);
    if (!p) return;
    pendingSolves.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
  };
  worker.onerror = (e) => { e.preventDefault(); failoverToMainThread(); };
} catch {
  worker = null;
}

function runSolver(payload) {
  if (!worker) {
    // Yield one frame first so the "Optimizing…" state paints before the main thread blocks.
    return new Promise((resolve) => setTimeout(resolve, 20)).then(() => window.solveDispatch(payload));
  }
  return new Promise((resolve, reject) => {
    const id = ++solveSeq;
    pendingSolves.set(id, { resolve, reject, payload });
    worker.postMessage({ id, payload });
  });
}

async function replan(timeLimit) {
  if (S.replanning) { S.replanQueued = true; return; }
  S.replanning = true;
  const version = S.version;
  const cfg = settings();
  const payload = {
    ...cfg,
    now: S.simTime,
    time_limit: timeLimit,
    stores: S.stores.map(({ id, x, y }) => ({ id, x, y })),
    drivers: S.drivers.map((d) => ({ id: d.id, x: d.x, y: d.y, onboard: d.onboard.slice(), delay: d.wait })),
    orders: S.orders.filter((o) => o.status !== 'delivered').map(({ id, x, y, created }) => ({ id, x, y, created })),
  };
  try {
    const data = await runSolver(payload);
    if (S.phase === 'setup' && version !== S.version) return; // setup changed meanwhile
    applyPlan(data);
  } catch (err) {
    toast(err.message);
    log('Optimizer error: ' + err.message, 'err');
  } finally {
    S.replanning = false;
    if (S.replanQueued) { S.replanQueued = false; replan(timeLimit); }
  }
}

function applyPlan(data) {
  const routes = new Map(data.routes.map((r) => [r.driver_id, r]));
  for (const o of S.orders) {
    if (o.status === 'pending' || o.status === 'assigned') { o.status = 'pending'; o.driver = null; }
    o.eta = null;
  }
  for (const d of S.drivers) {
    const r = routes.get(d.id);
    d.plan = r ? r.stops.map((s) => ({ ...s })) : [];
    d.finish = r ? r.finish : S.simTime;
    for (const s of d.plan) {
      if (s.type === 'pickup') {
        for (const oid of s.orders) { const o = orderById(oid); if (o) { o.status = 'assigned'; o.driver = d.id; } }
      } else {
        const o = orderById(s.order_id);
        if (o) o.eta = s.eta;
      }
    }
  }
  S.metrics = data.metrics;
  const m = data.metrics;
  log(`Plan for ${m.orders} open orders: all done by T+${m.makespan.toFixed(1)}, avg ${m.avg_delivery_time.toFixed(1)} min (${m.iterations} iterations, ${m.solve_ms} ms)`);
}

// ---------- simulation ----------

function step(dt) {
  const cfg = settings();
  const t0 = S.simTime;
  for (const d of S.drivers) advanceDriver(d, dt, t0, cfg);
  S.simTime += dt;

  if ($('autoSpawn').checked) {
    S.spawnClock += dt;
    if (S.spawnClock >= Math.max(0.25, num('spawnEvery', 3))) { S.spawnClock = 0; spawnRandomOrder(); }
  }
  if (!S.allDone && S.orders.length && S.orders.every((o) => o.status === 'delivered')) {
    S.allDone = true;
    log(`All ${S.orders.length} orders delivered at T+${S.simTime.toFixed(1)}`);
  }
}

function advanceDriver(d, dt, t0, cfg) {
  let used = 0;
  while (used < dt - 1e-9) {
    const rem = dt - used;
    if (d.wait > 0) { const w = Math.min(d.wait, rem); d.wait -= w; used += w; continue; }
    const stop = d.plan[0];
    if (!stop) break;
    const dx = stop.x - d.x, dy = stop.y - d.y, dist = Math.hypot(dx, dy);
    const reach = cfg.speed * rem;
    if (reach >= dist) {
      d.x = stop.x; d.y = stop.y; d.distance += dist; used += dist / cfg.speed;
      d.plan.shift();
      arrive(d, stop, t0 + used, cfg);
    } else {
      d.x += dx / dist * reach; d.y += dy / dist * reach; d.distance += reach; used = dt;
    }
  }
  const last = d.trail[d.trail.length - 1];
  if (!last || Math.hypot(last.x - d.x, last.y - d.y) > 4) {
    d.trail.push({ x: d.x, y: d.y });
    if (d.trail.length > 600) d.trail.shift();
  }
}

function arrive(d, stop, t, cfg) {
  if (stop.type === 'pickup') {
    let n = 0;
    for (const oid of stop.orders) {
      const o = orderById(oid);
      if (!o || o.status === 'delivered') continue;
      o.status = 'onboard'; o.driver = d.id; n++;
      if (!d.onboard.includes(oid)) d.onboard.push(oid);
    }
    d.wait = cfg.pickup_time;
    const s = storeById(stop.store_id);
    log(`${d.label} picked up ${n} order${n === 1 ? '' : 's'} at ${s ? s.label : 'store'}`);
  } else {
    const o = orderById(stop.order_id);
    if (o && o.status !== 'delivered') {
      o.status = 'delivered';
      o.deliveredAt = t + cfg.dropoff_time;
      d.delivered++;
      d.onboard = d.onboard.filter((x) => x !== o.id);
      log(`${d.label} delivered ${o.label} in ${(o.deliveredAt - o.created).toFixed(1)} min`);
    }
    d.wait = cfg.dropoff_time;
  }
}

function spawnRandomOrder() {
  const p = randomPoint();
  const o = addOrder(p.x, p.y);
  log(`New order ${o.label}`);
  replan(0.35);
}

// ---------- controls ----------

function setMode(mode) {
  S.mode = mode;
  document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}

async function start() {
  if (S.phase === 'paused') { S.phase = 'running'; return; }
  if (!S.drivers.length) return toast('Place at least one driver');
  if (!S.stores.length) return toast('Place at least one dark store');
  S.snapshot = takeSnapshot();
  S.simTime = 0;
  S.spawnClock = 0;
  S.phase = 'running';
  log('Simulation started');
  if (!S.metrics) await replan(1.0);
}

function reset() {
  if (S.snapshot) restoreSnapshot(S.snapshot);
  S.phase = 'setup';
  S.simTime = 0;
  S.allDone = true;
  invalidatePlan();
  log('Reset to initial setup');
}

function toMap(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
}

canvas.addEventListener('click', (e) => {
  const p = toMap(e);
  if (S.phase === 'setup') {
    if (S.mode === 'delivery') addOrder(p.x, p.y);
    else if (S.mode === 'store') addStore(p.x, p.y);
    else addDriver(p.x, p.y);
    invalidatePlan();
  } else {
    const o = addOrder(p.x, p.y);
    log(`New order ${o.label} placed`);
    replan(0.35);
  }
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (S.phase !== 'setup') return;
  const hit = nearestEntity(toMap(e));
  if (!hit) return;
  const list = { order: 'orders', store: 'stores', driver: 'drivers' }[hit.kind];
  S[list] = S[list].filter((x) => x !== hit.e);
  invalidatePlan();
});

canvas.addEventListener('mousemove', (e) => { S.hover = toMap(e); });
canvas.addEventListener('mouseleave', () => { S.hover = null; });

document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('[data-rand]').forEach((b) => b.addEventListener('click', () => randomize(b.dataset.rand)));
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select')) return;
  const mode = { 1: 'delivery', 2: 'store', 3: 'driver' }[e.key];
  if (mode) setMode(mode);
  if (e.key === ' ') { e.preventDefault(); if (S.phase === 'running') S.phase = 'paused'; else start(); }
});

$('randAll').onclick = () => { randomize('stores'); randomize('drivers'); randomize('orders'); };
$('clearAll').onclick = () => { S.orders = []; S.stores = []; S.drivers = []; S.ids = { order: 1, store: 1, driver: 1 }; invalidatePlan(); };
$('planBtn').onclick = () => {
  if (!S.drivers.length) return toast('Place at least one driver');
  if (!S.stores.length && S.orders.length) return toast('Place at least one dark store');
  replan(1.0);
};
$('startBtn').onclick = start;
$('pauseBtn').onclick = () => { if (S.phase === 'running') S.phase = 'paused'; else if (S.phase === 'paused') S.phase = 'running'; };
$('resetBtn').onclick = reset;
$('spawnBtn').onclick = spawnRandomOrder;
$('simSpeed').oninput = () => { $('simSpeedOut').textContent = `${$('simSpeed').value} min/s`; };

for (const id of ['speed', 'capacity', 'pickup', 'dropoff', 'objective']) {
  $(id).addEventListener('change', () => {
    if (S.phase === 'setup') invalidatePlan();
    else { log('Constraints changed, re-planning'); replan(0.5); }
  });
}

// ---------- rendering ----------

let theme = {};
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['map-bg', 'map-grid', 'map-grid-major', 'store', 'order', 'done', 'text', 'panel', 'muted']) {
    theme[k] = cs.getPropertyValue('--' + k).trim();
  }
}
readTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readTheme);

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
}
window.addEventListener('resize', resize);
resize();

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

function draw() {
  const sx = canvas.width / W, sy = canvas.height / H;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  ctx.fillStyle = theme['map-bg'];
  ctx.fillRect(0, 0, W, H);

  // grid: minor every 500 m, major every 1 km
  for (let x = 0; x <= W; x += 50) line(x, 0, x, H, x % 100 ? theme['map-grid'] : theme['map-grid-major']);
  for (let y = 0; y <= H; y += 50) line(0, y, W, y, y % 100 ? theme['map-grid'] : theme['map-grid-major']);

  // traveled trails
  for (const d of S.drivers) {
    if (d.trail.length < 2) continue;
    ctx.strokeStyle = withAlpha(d.color, 0.25);
    ctx.lineWidth = 3;
    ctx.beginPath();
    d.trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.lineTo(d.x, d.y);
    ctx.stroke();
  }

  // planned routes
  ctx.setLineDash([7, 5]);
  for (const d of S.drivers) {
    if (!d.plan.length) continue;
    ctx.strokeStyle = withAlpha(d.color, 0.85);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(d.x, d.y);
    for (const s of d.plan) ctx.lineTo(s.x, s.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // stores
  for (const s of S.stores) {
    ctx.fillStyle = theme.store;
    roundRect(s.x - 11, s.y - 11, 22, 22, 4);
    ctx.fill();
    ctx.fillStyle = theme['map-bg'];
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(s.label, s.x, s.y + 0.5);
  }

  // orders
  for (const o of S.orders) {
    const d = o.driver ? driverById(o.driver) : null;
    ctx.lineWidth = 2;
    if (o.status === 'delivered') {
      ctx.fillStyle = theme.done;
      circle(o.x, o.y, 4); ctx.fill();
      continue;
    }
    if (o.status === 'onboard' && d) {
      ctx.fillStyle = d.color; circle(o.x, o.y, 7); ctx.fill();
    } else if (o.status === 'assigned' && d) {
      ctx.fillStyle = theme['map-bg']; circle(o.x, o.y, 7); ctx.fill();
      ctx.strokeStyle = d.color; ctx.stroke();
    } else {
      ctx.fillStyle = theme['map-bg']; circle(o.x, o.y, 7); ctx.fill();
      ctx.strokeStyle = theme.order; ctx.stroke();
    }
    ctx.fillStyle = theme.muted;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(o.label, o.x + 10, o.y);
  }

  // drivers
  for (const d of S.drivers) {
    ctx.fillStyle = d.color;
    ctx.strokeStyle = theme['map-bg'];
    ctx.lineWidth = 3;
    circle(d.x, d.y, 11); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(d.label, d.x, d.y + 0.5);
    if (d.onboard.length) {
      ctx.fillStyle = theme.text;
      circle(d.x + 11, d.y - 11, 7); ctx.fill();
      ctx.fillStyle = theme.panel;
      ctx.fillText(String(d.onboard.length), d.x + 11, d.y - 10.5);
    }
  }

  drawScaleBar();
  drawTooltip();
}

function line(x1, y1, x2, y2, color) {
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

function drawScaleBar() {
  const x = 16, y = H - 16;
  ctx.strokeStyle = theme.text; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + 100, y); ctx.lineTo(x + 100, y - 5); ctx.stroke();
  ctx.fillStyle = theme.text; ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('1 km', x + 50, y - 3);
}

function drawTooltip() {
  if (!S.hover) return;
  const hit = nearestEntity(S.hover, 14);
  if (!hit) return;
  const e = hit.e;
  let lines;
  if (hit.kind === 'order') {
    lines = [`Order ${e.label}: ${e.status}`, `Placed T+${e.created.toFixed(1)}`];
    if (e.driver) lines.push(`Driver ${driverById(e.driver)?.label ?? '?'}`);
    if (e.status === 'delivered') lines.push(`Delivered in ${(e.deliveredAt - e.created).toFixed(1)} min`);
    else if (e.eta != null) lines.push(`ETA T+${e.eta.toFixed(1)}`);
  } else if (hit.kind === 'store') {
    lines = [`Dark store ${e.label}`];
  } else {
    lines = [`Driver ${e.label}`, driverStatus(e), `${e.onboard.length} on board, ${e.delivered} delivered`];
  }
  ctx.font = '12px system-ui, sans-serif';
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
  const h = lines.length * 16 + 10;
  let x = e.x + 16, y = e.y - h / 2;
  if (x + w > W) x = e.x - 16 - w;
  y = Math.min(H - h - 4, Math.max(4, y));
  ctx.fillStyle = theme.text;
  roundRect(x, y, w, h, 6); ctx.fill();
  ctx.fillStyle = theme.panel;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 6 + i * 16));
}

function driverStatus(d) {
  const next = d.plan[0];
  if (d.wait > 0) return 'Handing over…';
  if (!next) return 'Idle';
  if (next.type === 'pickup') return `→ ${storeById(next.store_id)?.label ?? 'store'} (pick ${next.orders.length})`;
  return `→ ${orderById(next.order_id)?.label ?? 'order'}`;
}

let lastUi = 0;
function updateUi(now) {
  if (now - lastUi < 120) return;
  lastUi = now;
  const delivered = S.orders.filter((o) => o.status === 'delivered');
  $('stClock').textContent = fmtMin(S.simTime);
  $('stDelivered').textContent = `${delivered.length} / ${S.orders.length}`;
  $('stAvg').textContent = delivered.length
    ? fmtMin(delivered.reduce((a, o) => a + o.deliveredAt - o.created, 0) / delivered.length) : '-';
  $('stFinish').textContent = S.metrics ? `T+${S.metrics.makespan.toFixed(1)}` : '-';
  $('stDist').textContent = S.metrics ? fmtKm(S.metrics.total_distance) : '-';

  const pill = $('stPhase');
  pill.textContent = S.replanning ? 'Optimizing…' : { setup: 'Setup', running: 'Running', paused: 'Paused' }[S.phase];
  pill.className = 'pill ' + (S.replanning ? 'busy' : S.phase);

  const setup = S.phase === 'setup';
  document.querySelectorAll('#setupPanel button, #setupPanel input').forEach((el) => { el.disabled = !setup; });
  $('planBtn').disabled = !setup;
  $('startBtn').disabled = S.phase === 'running';
  $('startBtn').textContent = S.phase === 'paused' ? 'Resume' : 'Start';
  $('pauseBtn').disabled = setup;
  $('pauseBtn').textContent = S.phase === 'paused' ? 'Resume' : 'Pause';
  $('resetBtn').disabled = setup;
  $('spawnBtn').disabled = setup;

  $('drivers').tBodies[0].innerHTML = S.drivers.map((d) => `
    <tr><td><span class="dot" style="background:${d.color}"></span>${d.label}</td>
    <td>${driverStatus(d)}</td><td>${d.onboard.length}</td><td>${d.delivered}</td>
    <td>${fmtKm(d.distance)}</td><td>${d.finish != null && d.plan.length ? 'T+' + d.finish.toFixed(1) : '-'}</td></tr>`).join('');
}

let lastFrame = performance.now();
function frame(now) {
  const dtReal = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  // The clock freezes while the optimizer runs so the returned plan matches driver state.
  if (S.phase === 'running' && !S.replanning) step(dtReal * num('simSpeed', 2));
  draw();
  updateUi(now);
  requestAnimationFrame(frame);
}

randomize('stores'); randomize('drivers'); randomize('orders');
log('Random scenario generated. Edit it, then press Start.');
requestAnimationFrame(frame);
