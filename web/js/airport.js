// Airport model built from the server's parsed apt.dat: runways, taxi graph, stand links, roads, routing.
//
// Every stand is connected to the taxi network: a stand that is not already on a taxi-route node gets a
// generated link edge (dashed in the Taxi-graph view) from the stand to the nearest taxilane, so routes go
// stand → taxilane → taxiway → holding point and arrivals taxi all the way onto the stand.

export const KT = 0.514444;
export const FT = 0.3048;

export const hdgOf = (dx, dy) => (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
export const angDiff = (a, b) => { let d = (b - a + 540) % 360 - 180; return d; };
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const vecFromHdg = (h) => [Math.sin(h * Math.PI / 180), Math.cos(h * Math.PI / 180)];

/** Midpoint, direction and length of a polyline: {p, v, len} (null when degenerate). */
function mid(pts) {
  if (!pts || pts.length < 2) return null;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  if (len < 1) return null;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (acc + d >= len / 2) {
      const t = (len / 2 - acc) / d;
      const p = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      const v = [(pts[i][0] - pts[i - 1][0]) / d, (pts[i][1] - pts[i - 1][1]) / d];
      return { p, v, len };
    }
    acc += d;
  }
  return null;
}

/** Nearest point on segment ab to p: {t, d, p}. */
export function projectOnSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  const q = [a[0] + t * dx, a[1] + t * dy];
  return { t, d: dist(p, q), p: q };
}

export class Airport {
  constructor(d) {
    this.d = d;
    this.icao = d.icao;
    this.name = d.name;
    this.stands = d.stands;
    this.nodes = d.nodes.map(p => [p[0], p[1]]);     // copied: stand links add nodes
    this.lead = d.leadLines || [];
    this.roadsRaw = d.roads || [];

    // --- runways ---
    this.runways = d.runways.map((r, i) => {
      const [e0, e1] = r.ends;
      const len = dist(e0.pos, e1.pos);
      const mk = (a, b) => {
        const hdg = hdgOf(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]);
        const v = vecFromHdg(hdg);
        return { name: a.name, pos: a.pos, hdg, v, rwy: i, displaced: a.displaced,
          thr: [a.pos[0] + v[0] * a.displaced, a.pos[1] + v[1] * a.displaced], far: b.pos };
      };
      return { id: i, width: r.width, len, ends: [mk(e0, e1), mk(e1, e0)], label: `${e0.name}/${e1.name}` };
    });
    this.rwyEnd = {};
    for (const r of this.runways) for (const e of r.ends) this.rwyEnd[e.name.toUpperCase()] = e;

    // --- taxi graph: raw edge list (mutable), then stand links, then adjacency ---
    const raw = d.edges.map(e => ({ a: e.a, b: e.b, oneway: !!e.oneway, runway: !!e.runway, name: e.name || "", zones: e.zones || {}, width: e.width || "" }));
    this.nodeStand = new Map();      // node index -> stand
    this.standLinks = [];            // generated [a, b] node pairs (for drawing)
    this.linkStands(raw);

    this.adj = this.nodes.map(() => []);
    this.edges = raw.map((e, i) => {
      const zones = new Set();
      for (const k of ["departure", "arrival"]) for (const n of (e.zones[k] || [])) {
        const re = this.rwyEnd[n.toUpperCase()]; if (re) zones.add(re.rwy);
      }
      let rwy = -1;
      if (e.runway) {
        for (const n of e.name.split("/")) { const re = this.rwyEnd[n.trim().toUpperCase()]; if (re) rwy = re.rwy; }
        if (rwy < 0) rwy = this.nearestRunway(this.nodes[e.a]);
        if (rwy >= 0) zones.add(rwy);
      }
      // ignore zone tags for runways that are far from this edge (data often tags whole areas)
      for (const r of [...zones]) {
        const R = this.runways[r];
        if (Math.min(this.distToRunway(this.nodes[e.a], R), this.distToRunway(this.nodes[e.b], R)) > R.width / 2 + 180) zones.delete(r);
      }
      const ed = { i, a: e.a, b: e.b, oneway: e.oneway, runway: e.runway, rwy, name: e.name.toUpperCase(),
        zones, len: dist(this.nodes[e.a], this.nodes[e.b]), generated: !!e.generated, width: e.width };
      this.adj[e.a].push({ to: e.b, e: ed });
      // one-way flags in Gateway data are often wrong: allow reverse travel, but at a high cost
      this.adj[e.b].push({ to: e.a, e: ed, rev: e.oneway });
      return ed;
    });
    this.taxiNames = new Set(this.edges.filter(e => e.name && !e.runway).map(e => e.name));
    // nodes that sit on a runway edge, per runway
    this.rwyNodes = this.runways.map(() => new Set());
    for (const e of this.edges) if (e.runway && e.rwy >= 0) { this.rwyNodes[e.rwy].add(e.a); this.rwyNodes[e.rwy].add(e.b); }

    // --- service roads (1206): same node ids, own adjacency; edges inside a runway zone are flagged ---
    this.roadAdj = this.nodes.map(() => []);
    this.roads = this.roadsRaw.filter(r => r.a < this.nodes.length && r.b < this.nodes.length).map((r, i) => {
      const a = this.nodes[r.a], b = this.nodes[r.b];
      const crossesRwy = this.runways.some(R => this.onRunway(a, R, 20) || this.onRunway(b, R, 20) ||
        this.onRunway([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], R, 20));
      const ed = { i, a: r.a, b: r.b, oneway: !!r.oneway, name: (r.name || "").toUpperCase(), len: dist(a, b), crossesRwy };
      this.roadAdj[r.a].push({ to: r.b, e: ed });
      if (!r.oneway) this.roadAdj[r.b].push({ to: r.a, e: ed });
      return ed;
    });

    this.freq = {};
    for (const f of d.freqs) if (!this.freq[f.kind]) this.freq[f.kind] = f;
    this.callName = Airport.unitName(d);
    this.stopBars = this.buildStopBars(d);
    this.ilsHolds = (d.ilsHoldLines || []).map(l => mid(l)).filter(Boolean);
  }

  /**
   * Stop bars: one per runway holding position marking (hold line within 150 m of a runway, roughly across the
   * taxiway). {id, p, v (bar direction), len, rwy, lit, node (nearest taxi node)}
   */
  buildStopBars(d) {
    const out = [];
    for (const l of [...(d.holdLines || []), ...(d.ilsHoldLines || [])]) {
      const m = mid(l);
      if (!m) continue;
      const r = this.runways[this.nearestRunway(m.p)];
      if (!r || this.distToRunway(m.p, r) > 150 || this.onRunway(m.p, r, 2)) continue;
      const node = this.nearestNode(m.p);
      if (node < 0 || dist(this.nodes[node], m.p) > 40) continue;
      if (out.some(b => dist(b.p, m.p) < 25)) continue;
      out.push({ id: out.length, p: m.p, v: m.v, len: Math.max(12, Math.min(60, m.len)), rwy: r.id, lit: false, node, cat2: d.ilsHoldLines && d.ilsHoldLines.includes(l) });
    }
    return out;
  }

  /** The stop bar sitting at node n (the holding point itself), or null. */
  stopBarAtNode(n) { return this.stopBars.find(b => b.node === n && dist(b.p, this.nodes[n]) < 25) || null; }
  /** The stop bar an aircraft would cross when going from node a to node b (within 20 m of the edge), or null. */
  stopBarOnEdge(a, b) {
    for (const bar of this.stopBars) {
      const pr = projectOnSeg(bar.p, this.nodes[a], this.nodes[b]);
      if (pr.d < 20 && pr.t > 0.02 && pr.t < 0.98) return bar;
      if (bar.node === b && dist(bar.p, this.nodes[b]) < 25) return bar;
    }
    return null;
  }

  /**
   * Connect every stand to the taxi network. A stand on (within 12 m of) a route node uses that node;
   * otherwise the nearest non-runway edge within 250 m is split at the projection and a link edge is
   * generated from a new node at the stand. Falls back to the nearest node within 400 m.
   */
  linkStands(raw) {
    const nodeCount0 = this.nodes.length;
    const deg = new Array(nodeCount0).fill(0);           // taxi-route degree: road-only / orphan nodes do not count
    for (const e of raw) { deg[e.a]++; deg[e.b]++; }
    for (const s of this.stands) {
      let best = -1, bd = 1e9;
      for (let i = 0; i < nodeCount0; i++) { if (!deg[i]) continue; const dd = dist(this.nodes[i], s.pos); if (dd < bd) { bd = dd; best = i; } }
      if (best >= 0 && bd < 12) { s.node = best; this.nodeStand.set(best, s); continue; }
      // nearest non-runway edge
      let be = -1, bp = null, bed = 1e9;
      for (let i = 0; i < raw.length; i++) {
        const e = raw[i];
        if (e.runway || e.generated) continue;      // never chain one stand's link through another's
        const a = this.nodes[e.a], b = this.nodes[e.b];
        if (Math.abs(a[0] - s.pos[0]) > 260 && Math.abs(b[0] - s.pos[0]) > 260) continue;
        if (Math.abs(a[1] - s.pos[1]) > 260 && Math.abs(b[1] - s.pos[1]) > 260) continue;
        const pr = projectOnSeg(s.pos, a, b);
        if (pr.d < bed) { bed = pr.d; be = i; bp = pr; }
      }
      const sn = this.nodes.length;
      this.nodes.push([s.pos[0], s.pos[1]]);
      s.node = sn; this.nodeStand.set(sn, s);
      if (be >= 0 && bed < 250) {
        const e = raw[be];
        let m;
        if (bp.t > 0.03 && bp.t < 0.97) {
          m = this.nodes.length; this.nodes.push([bp.p[0], bp.p[1]]);
          const tail = { ...e, a: m, b: e.b, zones: e.zones };
          e.b = m;
          raw.push(tail);
        } else m = bp.t <= 0.03 ? e.a : e.b;
        raw.push({ a: sn, b: m, oneway: false, runway: false, name: "", zones: {}, generated: true, width: e.width });
        this.standLinks.push([sn, m]);
      } else if (best >= 0 && bd < 400) {
        raw.push({ a: sn, b: best, oneway: false, runway: false, name: "", zones: {}, generated: true });
        this.standLinks.push([sn, best]);
      } else s.unlinked = true;
    }
  }

  /** Radio name of the airport\'s ATC units: "Heathrow" (Tower), from frequency names, else the city. */
  static unitName(d) {
    const UNIT = /\b(tower|twr|ground|gnd|delivery|del|clnc|clearance|apron|information|info|atis|awos|asos|handling|unicom|ctaf|north|south|east|west|centre|center|inner|outer|arrival|departure|\d+)\b/gi;
    const title = (s) => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    for (const kind of ["tower", "ground", "delivery", "atis"]) {
      for (const f of d.freqs.filter(f => f.kind === kind)) {
        const rest = f.name.replace(/\(.*?\)/g, " ").replace(/\S*\d\S*/g, " ").replace(UNIT, " ").replace(/\s+/g, " ").trim();
        if (/^[a-z]{2,}( [a-z]+)?$/i.test(rest) && rest.length >= 4 && !/\b(area|control|radar|approach|app|director)\b/i.test(rest)) return title(rest);
      }
    }
    return title((d.meta.city || d.name.split(" ")[0] || d.icao).split(/[-,/]/)[0].trim());
  }

  // local metres <-> lat/lon (same projection as aptdat.py: kx = cos(lat0)*111320, ky = 110540)
  get kx() { return Math.cos(this.d.lat * Math.PI / 180) * 111320; }
  toLatLon(p) { return [this.d.lat + p[1] / 110540, this.d.lon + p[0] / this.kx]; }
  toXY(lat, lon) { return [(lon - this.d.lon) * this.kx, (lat - this.d.lat) * 110540]; }

  /** Bounding box of runways and stands: [x0, y0, x1, y1]. */
  bounds(margin = 0) {
    const xs = [], ys = [];
    for (const r of this.runways) for (const e of r.ends) { xs.push(e.pos[0]); ys.push(e.pos[1]); }
    for (const s of this.stands) { xs.push(s.pos[0]); ys.push(s.pos[1]); }
    if (!xs.length) return [-1000, -1000, 1000, 1000];
    return [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin];
  }
  /** Bounding box of the stands (apron) only. */
  apronBounds(margin = 0) {
    const xs = this.stands.map(s => s.pos[0]), ys = this.stands.map(s => s.pos[1]);
    if (!xs.length) return this.bounds(margin);
    return [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin];
  }
  /** Where the tower stands: a frequency-named tower position is not in apt.dat, so the apron centroid. */
  towerPos() {
    if (this._tower) return this._tower;
    const b = this.apronBounds();
    this._tower = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    return this._tower;
  }

  nearestRunway(p) {
    let best = -1, bd = 1e9;
    for (const r of this.runways) {
      const d = this.distToRunway(p, r);
      if (d < bd) { bd = d; best = r.id; }
    }
    return best;
  }

  // lateral distance from runway centreline and along-track from end 0
  rwyCoords(p, r) {
    const e = r.ends[0];
    const dx = p[0] - e.pos[0], dy = p[1] - e.pos[1];
    return { along: dx * e.v[0] + dy * e.v[1], cross: dx * e.v[1] - dy * e.v[0] };
  }

  distToRunway(p, r) {
    const c = this.rwyCoords(p, r);
    const a = Math.max(0, Math.min(r.len, c.along));
    return Math.hypot(c.along - a, c.cross);
  }

  onRunway(p, r, margin = 0) {
    const c = this.rwyCoords(p, r);
    return c.along > -60 && c.along < r.len + 60 && Math.abs(c.cross) < r.width / 2 + margin;
  }

  findRunwayEnd(name) { return name ? this.rwyEnd[String(name).toUpperCase()] : null; }

  nearestNode(p, filter) {
    let best = -1, bd = 1e9;
    this.nodes.forEach((n, i) => {
      if (!this.adj[i].length || (filter && !filter(i))) return;
      const d = dist(n, p); if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Nearest road node (service vehicles). */
  nearestRoadNode(p) {
    let best = -1, bd = 1e9;
    this.nodes.forEach((n, i) => {
      if (!this.roadAdj[i].length) return;
      const d = dist(n, p); if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /**
   * Dijkstra over (node, viaIndex). via: list of taxiway names to follow in order.
   * Off-route named taxiways are only allowed (penalised) before the first / after the last via.
   * Returns Map of reachable state -> {cost, prev} and helper to rebuild paths.
   * opts.avoidRwy: runway id whose runway edges may not be used.
   * opts.firstAvoid: node the first step may not go to (no U-turn after pushback).
   * opts.blocked: Set of edge indices that may not be used (broken-down aircraft, closed taxiway).
   */
  search(start, via, opts = {}) {
    const m = via.length;
    const key = (n, k) => n * 64 + k;
    const best = new Map();
    const prev = new Map();
    const heap = [[0, start, 0]];
    best.set(key(start, 0), 0);
    const blocked = opts.blocked || null;
    while (heap.length) {
      let bi = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
      const [c, n, k] = heap[bi];
      heap[bi] = heap[heap.length - 1]; heap.pop();
      if (c > best.get(key(n, k))) continue;
      for (const { to, e, rev } of this.adj[n]) {
        if (n === start && to === opts.firstAvoid) continue;
        if (blocked && blocked.has(e.i)) continue;
        // a stand node is a dead end: only enter it when it is the goal
        if (this.nodeStand.has(to) && to !== opts.goal && to !== start) continue;
        let nk = k, w;
        if (e.runway) {
          if (e.rwy === opts.avoidRwy) continue;
          w = e.len * 3 + 200;
        } else if (!e.name) {
          w = e.len * 1.6;
        } else if (m === 0) {
          w = e.len;
        } else if (k > 0 && e.name === via[k - 1]) {
          w = e.len;
        } else if (k < m && e.name === via[k]) {
          nk = k + 1; w = e.len;
        } else if (k === 0) {
          w = e.len * 2.5; // leaving the apron before joining the first cleared taxiway
        } else if (k === m) {
          w = e.len * 4; // short connector after the last cleared taxiway
        } else continue;
        if (rev) w *= 6;
        const nc = c + w, kk = key(to, nk);
        if (nc < (best.get(kk) ?? Infinity)) {
          best.set(kk, nc); prev.set(kk, key(n, k)); heap.push([nc, to, nk]);
        }
      }
    }
    const path = (n) => {
      let kk = key(n, m);
      if (!best.has(kk)) return null;
      const out = [];
      while (kk !== undefined) { out.push(Math.floor(kk / 64)); kk = prev.get(kk); }
      return out.reverse();
    };
    return { cost: (n) => best.get(key(n, m)), path };
  }

  /** Route to the runway entry for departure end `end`. Returns node list ending ON the runway. */
  routeToRunway(start, end, via, firstAvoid, opts = {}) {
    const s = this.search(start, via, { avoidRwy: end.rwy, firstAvoid, blocked: opts.blocked });
    const r = this.runways[end.rwy];
    let bestN = -1, bestC = Infinity;
    for (const n of this.rwyNodes[r.id]) {
      const c = s.cost(n);
      if (c === undefined) continue;
      // prefer full-length entries: penalise distance from the departure threshold
      const dx = this.nodes[n][0] - end.pos[0], dy = this.nodes[n][1] - end.pos[1];
      const along = dx * end.v[0] + dy * end.v[1];
      if (opts.intersection != null && Math.abs(along - opts.intersection) > 120) continue;
      const score = c + Math.abs(along) * 1.5;
      if (score < bestC) { bestC = score; bestN = n; }
    }
    return bestN < 0 ? null : s.path(bestN);
  }

  /** Route to the reachable node closest to `pos` (a stand node when the stand is linked), honouring `via`. */
  routeToPos(start, pos, via, firstAvoid, opts = {}) {
    const st = this.stands.find(s => s.pos === pos || (s.pos[0] === pos[0] && s.pos[1] === pos[1]));
    const goal = st && st.node != null ? st.node : undefined;
    const s = this.search(start, via, { firstAvoid, goal, blocked: opts.blocked, avoidRwy: opts.avoidRwy });
    if (goal !== undefined && s.cost(goal) !== undefined) return s.path(goal);
    let best = -1, bd = Infinity;
    this.nodes.forEach((p, n) => {
      const c = s.cost(n);
      if (c === undefined) return;
      const d = dist(p, pos) * 4 + c * 0.05;
      if (d < bd) { bd = d; best = n; }
    });
    return best < 0 || dist(this.nodes[best], pos) > 400 ? null : s.path(best);
  }

  /** Route between two nodes with no via constraint (vehicles, tows). */
  routeNodes(start, goal, opts = {}) {
    const s = this.search(start, [], { goal, blocked: opts.blocked });
    return s.cost(goal) === undefined ? null : s.path(goal);
  }

  /** Shortest path on the service-road network (never through runway-crossing edges unless allowed). */
  roadRoute(start, goal, { allowRwy = false } = {}) {
    const best = new Map([[start, 0]]), prev = new Map(), heap = [[0, start]];
    while (heap.length) {
      let bi = 0;
      for (let i = 1; i < heap.length; i++) if (heap[i][0] < heap[bi][0]) bi = i;
      const [c, n] = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
      if (c > best.get(n)) continue;
      if (n === goal) break;
      for (const { to, e } of this.roadAdj[n]) {
        if (e.crossesRwy && !allowRwy) continue;
        const nc = c + e.len;
        if (nc < (best.get(to) ?? Infinity)) { best.set(to, nc); prev.set(to, n); heap.push([nc, to]); }
      }
    }
    if (!best.has(goal)) return null;
    const out = []; let k = goal;
    while (k !== undefined) { out.push(k); k = prev.get(k); }
    return out.reverse();
  }

  edgeBetween(a, b) {
    const x = this.adj[a].find(o => o.to === b);
    return x ? x.e : null;
  }

  /** After landing: from a runway node, find taxiway path until clear of that runway's zones. */
  exitRoute(fromNode, rwy, rwyHdg) {
    const p0 = this.nodes[fromNode];
    let best = null;
    for (const { to, e } of this.adj[fromNode]) {
      if (e.runway) continue;
      const h = hdgOf(this.nodes[to][0] - p0[0], this.nodes[to][1] - p0[1]);
      if (rwyHdg != null && Math.abs(angDiff(rwyHdg, h)) > 120) continue;
      // BFS/Dijkstra outward until a node with no zone/runway edges for rwy
      const seen = new Map([[fromNode, null], [to, fromNode]]);
      const q = [[to, e.len]];
      while (q.length) {
        q.sort((a, b) => a[1] - b[1]);
        const [n, c] = q.shift();
        const touches = this.adj[n].some(o => o.e.zones.has(rwy)) || this.rwyNodes[rwy].has(n);
        if (!touches && !this.reachesStands(n, rwy)) break; // dead-end stub (bad data)
        if (!touches) {
          const path = []; let k = n;
          while (k !== null && k !== undefined) { path.push(k); k = seen.get(k); }
          path.reverse();
          if (!best || c < best.c) best = { c, path };
          break;
        }
        for (const o of this.adj[n]) {
          if (o.e.runway || seen.has(o.to) || this.nodeStand.has(o.to)) continue;
          seen.set(o.to, n); q.push([o.to, c + o.e.len * (o.rev ? 6 : 1)]);
        }
      }
    }
    return best ? best.path : null;
  }

  /** Can node n reach the stand area without going back through runway rwy? (memoised) */
  reachesStands(n, rwy) {
    this._reach ??= new Map();
    const key = n * 16 + rwy;
    if (!this._reach.has(key)) {
      this._nearStand ??= new Set(this.nodes.map((p, i) => i).filter(i => this.nodeStand.has(i) || this.stands.some(s => dist(s.pos, this.nodes[i]) < 150)));
      if (!this._nearStand.size) return true;
      const seen = new Set([n]), st = [n];
      let ok = false;
      while (st.length && !ok) {
        const x = st.pop();
        if (this._nearStand.has(x)) ok = true;
        for (const { to, e } of this.adj[x]) {
          if (e.runway || e.zones.has(rwy) || seen.has(to)) continue;
          seen.add(to); st.push(to);
        }
      }
      this._reach.set(key, ok);
    }
    return this._reach.get(key);
  }

  /** Runway exits ahead of along-distance `along` (from end), as [{node, along}] sorted. */
  exitsAhead(end, along, behindOk = false) {
    const out = [];
    for (const n of this.rwyNodes[end.rwy]) {
      if (!this.adj[n].some(o => !o.e.runway)) continue;
      const p = this.nodes[n];
      const a = (p[0] - end.pos[0]) * end.v[0] + (p[1] - end.pos[1]) * end.v[1];
      if (behindOk || a > along) out.push({ node: n, along: a });
    }
    return out.sort((a, b) => a.along - b.along);
  }

  /** Runway entry points for departures: nodes on the runway with a taxiway attached, with the distance remaining (TORA from there). */
  entries(end) {
    return this.exitsAhead(end, -1e9, true).map(x => ({ node: x.node, along: x.along, remaining: this.runways[end.rwy].len - x.along }))
      .filter(x => x.remaining > 300);
  }

  /** Physical runway ids an edge's zone covers (empty set if none). */
  zonesOf(a, b) {
    const e = this.edgeBetween(a, b);
    return e ? e.zones : new Set();
  }

  /** Nearest taxiway edge to a world point (for click-to-instruct): {e, d} or null. */
  nearestEdge(p, maxD = 40, named = true) {
    let best = null, bd = maxD;
    for (const e of this.edges) {
      if (e.runway || (named && !e.name)) continue;
      const pr = projectOnSeg(p, this.nodes[e.a], this.nodes[e.b]);
      if (pr.d < bd) { bd = pr.d; best = e; }
    }
    return best ? { e: best, d: bd } : null;
  }
}
