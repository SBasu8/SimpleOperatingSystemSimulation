/*
 * Dark-store delivery route optimizer (JavaScript port of ../optimizer.py).
 *
 * Model
 * -----
 * - Every order is picked up at a dark store (any store stocks everything) and
 *   then dropped off at its delivery location.
 * - A driver carries at most `capacity` orders at once, so a route is a series
 *   of trips: drive to a store, pick up a batch, deliver the batch in order.
 * - Orders already on board a driver (picked up before a re-plan) must be
 *   delivered by that driver before it starts new trips.
 * - Travel is straight-line at constant speed; pickup/drop-off take fixed time.
 *
 * Search
 * ------
 * A solution is, per driver, an ordered list of orders. Given that list, the
 * best way to cut it into trips -- and the best store for each trip -- is found
 * exactly by a dynamic program ("split"). Simulated annealing then searches over
 * which driver gets which order and in what sequence.
 *
 * Exposes `solveDispatch(data)` on the global object (page or Web Worker).
 */
(function (global) {
  'use strict';

  const INF = Infinity;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const now = () => (global.performance ? global.performance.now() : Date.now());

  function num(obj, key, def) {
    const raw = obj[key];
    if (raw === undefined || raw === null) return def;
    const v = Number(raw);
    return Number.isFinite(v) ? v : def;
  }

  // Seeded PRNG (mulberry32) so a `seed` makes runs reproducible.
  function makeRng(seed) {
    if (seed === undefined || seed === null) return Math.random;
    let a = (Number(seed) >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Instance {
    constructor(data) {
      this.speed = num(data, 'speed', 40);
      if (this.speed <= 0) throw new Error('Driver speed must be positive.');
      this.capacity = Math.max(1, Math.trunc(num(data, 'capacity', 3)));
      this.pickup = Math.max(0, num(data, 'pickup_time', 0));
      this.dropoff = Math.max(0, num(data, 'dropoff_time', 0));
      this.objective = data.objective || 'makespan';
      if (this.objective !== 'makespan' && this.objective !== 'average') {
        throw new Error('Unknown objective: ' + this.objective);
      }
      this.now = num(data, 'now', 0);
      this.timeLimit = Math.min(5, Math.max(0.05, num(data, 'time_limit', 0.8)));

      const stores = data.stores || [];
      const drivers = data.drivers || [];
      const orders = data.orders || [];
      if (!drivers.length) throw new Error('Place at least one delivery driver.');

      this.storeIds = stores.map((s) => s.id);
      this.stores = stores.map((s) => [Number(s.x), Number(s.y)]);
      this.driverIds = drivers.map((d) => d.id);
      this.delay = drivers.map((d) => Math.max(0, num(d, 'delay', 0)));
      this.orderIds = orders.map((o) => o.id);
      this.created = orders.map((o) => num(o, 'created', this.now));

      const index = new Map(this.orderIds.map((id, i) => [id, i]));
      const claimed = new Set();
      this.onboard = drivers.map((d) => {
        const ob = [];
        for (const oid of d.onboard || []) {
          const i = index.get(oid);
          if (i !== undefined && !claimed.has(i)) { claimed.add(i); ob.push(i); }
        }
        return ob;
      });
      this.free = [];
      for (let i = 0; i < orders.length; i++) if (!claimed.has(i)) this.free.push(i);
      if (this.free.length && !this.stores.length) throw new Error('Place at least one dark store.');

      // Point indices: orders are 0..n-1, driver start positions n..n+D-1.
      const n = (this.n = orders.length);
      const pts = (this.pts = orders.map((o) => [Number(o.x), Number(o.y)])
        .concat(drivers.map((d) => [Number(d.x), Number(d.y)])));
      this.dd = pts.map((p) => {
        const row = new Float64Array(n);
        for (let b = 0; b < n; b++) row[b] = dist(p, pts[b]);
        return row;
      });

      // via[a][b]: shortest detour from point a through some store to order b.
      const toStore = pts.map((p) => this.stores.map((s) => dist(p, s)));
      this.via = [];
      this.viaStore = [];
      for (let a = 0; a < pts.length; a++) {
        const row = new Float64Array(n);
        const srow = new Int32Array(n);
        for (let b = 0; b < n; b++) {
          let best = INF, bestS = -1;
          for (let si = 0; si < this.stores.length; si++) {
            const c = toStore[a][si] + toStore[b][si];
            if (c < best) { best = c; bestS = si; }
          }
          row[b] = best;
          srow[b] = bestS;
        }
        this.via.push(row);
        this.viaStore.push(srow);
      }
    }

    // Optimal trip split of queue `q` for driver `k`.
    // Returns [finishTime, sumOfCompletionTimes, predecessors], times relative to `now`.
    split(k, ob, q) {
      const inv = 1 / this.speed, drop = this.dropoff, dd = this.dd;
      let pos = this.n + k, t = this.delay[k], s = 0;
      for (const o of ob) {
        t += dd[pos][o] * inv + drop;
        s += t;
        pos = o;
      }
      const m = q.length;
      if (!m) return [t, s, null];

      const T = new Float64Array(m + 1).fill(INF);
      const S = new Float64Array(m + 1).fill(INF);
      const P = new Int32Array(m + 1);
      T[0] = t; S[0] = s;
      const cap = this.capacity, via = this.via, pick = this.pickup;
      for (let i = 0; i < m; i++) {
        const start = i === 0 ? pos : q[i - 1];
        let tt = T[i] + via[start][q[i]] * inv + pick + drop;
        let ss = S[i] + tt;
        const lim = Math.min(m, i + cap);
        let j = i + 1;
        for (;;) {
          if (tt < T[j] - 1e-9 || (tt <= T[j] + 1e-9 && ss < S[j])) { T[j] = tt; S[j] = ss; P[j] = i; }
          if (j >= lim) break;
          tt += dd[q[j - 1]][q[j]] * inv + drop;
          ss += tt;
          j++;
        }
      }
      return [T[m], S[m], P];
    }

    evaluate(k, ob, q) {
      const r = this.split(k, ob, q);
      return [r[0], r[1]];
    }

    score(res) {
      let makespan = -INF, total = 0, spread = 0;
      for (const r of res) {
        if (r[0] > makespan) makespan = r[0];
        total += r[1];
        spread += r[0]; // discourages pointless detours by idle drivers
      }
      const n = Math.max(1, this.n);
      if (this.objective === 'makespan') return makespan + 0.1 * total / n + 0.01 * spread;
      return total / n + 0.1 * makespan + 0.01 * spread;
    }

    buildRoute(k, ob, q) {
      const P = this.split(k, ob, q)[2];
      const inv = 1 / this.speed, pts = this.pts, base = this.now;
      let pos = this.n + k, t = this.delay[k], distance = 0;
      const stops = [];
      const dropoffStop = (o) => ({ type: 'dropoff', order_id: this.orderIds[o], x: pts[o][0], y: pts[o][1], eta: base + t });

      for (const o of ob) {
        const d = this.dd[pos][o];
        t += d * inv + this.dropoff;
        distance += d;
        stops.push(dropoffStop(o));
        pos = o;
      }

      const cuts = [];
      for (let j = q.length; j > 0; j = P[j]) cuts.push([P[j], j]);
      cuts.reverse();
      for (const [i, j] of cuts) {
        const si = this.viaStore[pos][q[i]];
        const store = this.stores[si];
        let d = dist(pts[pos], store);
        t += d * inv + this.pickup;
        distance += d;
        stops.push({ type: 'pickup', store_id: this.storeIds[si], x: store[0], y: store[1],
          orders: q.slice(i, j).map((o) => this.orderIds[o]), eta: base + t });
        let prev = store;
        for (const o of q.slice(i, j)) {
          d = dist(prev, pts[o]);
          t += d * inv + this.dropoff;
          distance += d;
          stops.push(dropoffStop(o));
          prev = pts[o];
        }
        pos = q[j - 1];
      }
      return { driver_id: this.driverIds[k], stops, finish: base + t, distance };
    }

    nearestNeighbour(k) {
      const left = new Set(this.onboard[k]);
      const out = [];
      let pos = this.n + k;
      while (left.size) {
        let best = -1, bestD = INF;
        for (const o of left) if (this.dd[pos][o] < bestD) { bestD = this.dd[pos][o]; best = o; }
        left.delete(best);
        out.push(best);
        pos = best;
      }
      return out;
    }
  }

  // Cheapest-insertion construction of the initial queues.
  function greedy(inst, ob, res) {
    const qs = ob.map(() => []);
    const order = inst.free.slice().sort((a, b) => inst.created[a] - inst.created[b] || a - b);
    for (const o of order) {
      let best = null;
      for (let k = 0; k < qs.length; k++) {
        const q = qs[k];
        for (let p = 0; p <= q.length; p++) {
          const nq = q.slice(0, p).concat([o], q.slice(p));
          const r = inst.evaluate(k, ob[k], nq);
          const trial = res.slice();
          trial[k] = r;
          const s = inst.score(trial);
          if (best === null || s < best[0]) best = [s, k, nq, r];
        }
      }
      const [, k, nq, r] = best;
      qs[k] = nq;
      res[k] = r;
    }
    return qs;
  }

  function anneal(inst, ob, qs, res, rng) {
    const D = qs.length;
    const copy = (lists) => lists.map((l) => l.slice());
    const randInt = (n) => Math.floor(rng() * n);
    const choice = (arr) => arr[randInt(arr.length)];
    const twoDistinct = (n) => { const i = randInt(n); let j = randInt(n - 1); if (j >= i) j++; return [i, j]; };

    let cur = inst.score(res);
    let best = { score: cur, ob: copy(ob), qs: copy(qs) };
    const hasFree = inst.free.length > 0;
    const multiOb = [];
    for (let k = 0; k < D; k++) if (ob[k].length >= 2) multiOb.push(k);
    if (!hasFree && !multiOb.length) return [best, 0];

    const accept = (s, temp) => s <= cur || rng() < Math.exp((cur - s) / temp);
    const t0 = Math.max(0.5, 0.03 * cur);
    let temp = t0;
    const start = now(), limitMs = inst.timeLimit * 1000;
    let it = 0;
    for (;;) {
      if (it % 100 === 0) {
        const elapsed = now() - start;
        if (elapsed >= limitMs) break;
        temp = t0 * Math.pow(0.001, elapsed / limitMs);
      }
      it++;

      const changes = new Map();
      const r = rng();
      const nonempty = [];
      if (hasFree) for (let k = 0; k < D; k++) if (qs[k].length) nonempty.push(k);

      if (nonempty.length && r < 0.4) { // relocate one order
        const k1 = choice(nonempty), q1 = qs[k1];
        const i = randInt(q1.length), o = q1[i];
        const nq1 = q1.slice(0, i).concat(q1.slice(i + 1));
        const k2 = randInt(D);
        if (k2 === k1) {
          nq1.splice(randInt(nq1.length + 1), 0, o);
          changes.set(k1, nq1);
        } else {
          const nq2 = qs[k2].slice();
          nq2.splice(randInt(nq2.length + 1), 0, o);
          changes.set(k1, nq1).set(k2, nq2);
        }
      } else if (nonempty.length && r < 0.6) { // swap two orders
        const k1 = choice(nonempty), k2 = choice(nonempty);
        const i = randInt(qs[k1].length), j = randInt(qs[k2].length);
        if (k1 === k2) {
          if (i === j) continue;
          const nq = qs[k1].slice();
          [nq[i], nq[j]] = [nq[j], nq[i]];
          changes.set(k1, nq);
        } else {
          const nq1 = qs[k1].slice(), nq2 = qs[k2].slice();
          [nq1[i], nq2[j]] = [nq2[j], nq1[i]];
          changes.set(k1, nq1).set(k2, nq2);
        }
      } else if (nonempty.length && r < 0.8) { // reverse a segment (2-opt)
        const k = choice(nonempty), q = qs[k];
        if (q.length < 2) continue;
        let [i, j] = twoDistinct(q.length);
        if (i > j) [i, j] = [j, i];
        changes.set(k, q.slice(0, i).concat(q.slice(i, j + 1).reverse(), q.slice(j + 1)));
      } else if (nonempty.length && D > 1 && r < 0.92) { // exchange route tails (2-opt*)
        const k1 = choice(nonempty);
        let k2 = randInt(D - 1);
        if (k2 >= k1) k2++;
        const q1 = qs[k1], q2 = qs[k2];
        const i = randInt(q1.length + 1), j = randInt(q2.length + 1);
        changes.set(k1, q1.slice(0, i).concat(q2.slice(j))).set(k2, q2.slice(0, j).concat(q1.slice(i)));
      } else if (multiOb.length) { // reorder on-board deliveries
        const k = choice(multiOb);
        const [i, j] = twoDistinct(ob[k].length);
        const nob = ob[k].slice();
        [nob[i], nob[j]] = [nob[j], nob[i]];
        const trial = res.slice();
        trial[k] = inst.evaluate(k, nob, qs[k]);
        const s = inst.score(trial);
        if (accept(s, temp)) {
          ob[k] = nob; res = trial; cur = s;
          if (cur < best.score - 1e-9) best = { score: cur, ob: copy(ob), qs: copy(qs) };
        }
        continue;
      } else {
        continue;
      }

      const trial = res.slice();
      for (const [k, nq] of changes) trial[k] = inst.evaluate(k, ob[k], nq);
      const s = inst.score(trial);
      if (accept(s, temp)) {
        for (const [k, nq] of changes) qs[k] = nq;
        res = trial; cur = s;
        if (cur < best.score - 1e-9) best = { score: cur, ob: copy(ob), qs: copy(qs) };
      }
    }
    return [best, it];
  }

  function solve(data) {
    const started = now();
    const inst = new Instance(data || {});
    const rng = makeRng(data && data.seed);
    const D = inst.driverIds.length;

    let ob = [];
    for (let k = 0; k < D; k++) ob.push(inst.nearestNeighbour(k));
    let res = ob.map((o, k) => inst.evaluate(k, o, []));
    let qs = greedy(inst, ob, res);
    res = qs.map((q, k) => inst.evaluate(k, ob[k], q));
    const greedyScore = inst.score(res);

    const [best, iterations] = anneal(inst, ob, qs, res, rng);
    ob = best.ob; qs = best.qs;
    const routes = qs.map((q, k) => inst.buildRoute(k, ob[k], q));

    const finish = new Map();
    for (const r of routes) for (const s of r.stops) if (s.type === 'dropoff') finish.set(s.order_id, s.eta);
    const waits = inst.orderIds.map((oid, i) => finish.get(oid) - inst.created[i]);
    const final = qs.map((q, k) => inst.evaluate(k, ob[k], q));

    return {
      routes,
      metrics: {
        orders: inst.n,
        makespan: Math.max(...routes.map((r) => r.finish)),
        avg_delivery_time: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
        max_delivery_time: waits.length ? Math.max(...waits) : 0,
        total_distance: routes.reduce((a, r) => a + r.distance, 0),
        iterations,
        greedy_score: greedyScore,
        score: inst.score(final),
        solve_ms: Math.round(now() - started),
      },
    };
  }

  global.solveDispatch = solve;
})(typeof self !== 'undefined' ? self : this);
