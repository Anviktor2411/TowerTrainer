// Radar canvas: ground radar (ASDE-X / vSMR style) for Ground, tower radar ~10 nm, approach/centre radar with
// range rings. Draws a world snapshot ({ac:[...], arrEnd}) so pop-out and multiplayer windows render without the sim.
// Aircraft: top-down silhouettes at real wingspan/length when zoomed in; radar symbology (position symbol,
// history dots, 1-minute speed vector, label on a draggable leader line) when zoomed out or on radar views.
import { dist } from "./airport.js";
import { AC_DIM } from "./data.js";

const NM = 1852;
const C = {
  bg: "#0a0f14", pave: "#1e252d", rwy: "#0d1013", rwyEdge: "#c9d1d9", taxiLine: "#6b5d1f", hold: "#d8b330",
  graph: "#2c5d8a", label: "#8fa3b5", stand: "#5d6f80", dep: "#7fd1ff", arr: "#ffd27f", ovf: "#c7a6ff", human: "#ff7fd8",
  sel: "#7CFC9A", route: "#3fb96d", warn: "#ff5d5d", ring: "#1c2833", sid: "#3d8f6a", star: "#9a7a3a", fix: "#6f8597",
};

export const VIEWS = { GND: "Ground", TWR: "Tower", APP: "Approach", CTR: "Centre" };

export class Radar {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.scale = 0.2; this.cx = 0; this.cy = 0;
    this.view = "GND";
    this.showGraph = false;
    this.showProcs = true;
    this.filter = { ground: true, air: true, maxAlt: 99999 };
    this.procs = [];
    this.history = new Map();     // id -> [{p, t}]
    this.labelOff = new Map();    // id -> [dx, dy] screen offset of the data block
    this.labelBoxes = [];
    this.onSelect = () => {};
    this.bindMouse();
    new ResizeObserver(() => { this.resize(); }).observe(canvas);
    this.watchDpr();
  }

  /** Crisp canvas on mixed-DPI monitors: re-measure when the window moves to a screen with another scale. */
  watchDpr() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const on = () => { this.resize(); this.watchDpr(); };
    if (mq.addEventListener) mq.addEventListener("change", on, { once: true });
    else if (mq.addListener) mq.addListener(on);
  }

  resize() {
    const r = this.cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(r.width * dpr)); this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr; this.w = r.width; this.h = r.height;
  }

  setAirport(apt) {
    this.apt = apt;
    const d = apt.d;
    const pave = new Path2D();
    for (const poly of d.pavement) for (const ring of poly) {
      ring.forEach((p, i) => i ? pave.lineTo(p[0], p[1]) : pave.moveTo(p[0], p[1])); pave.closePath();
    }
    this.pave = pave;
    const line = (list) => { const p = new Path2D(); for (const l of list) l.forEach((q, i) => i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])); return p; };
    this.taxiLines = line(d.lines);
    this.holdLines = line(d.holdLines);
    this.graph = line(apt.edges.map(e => [apt.nodes[e.a], apt.nodes[e.b]]));
    this.labels = [];
    for (const e of apt.edges) {
      if (!e.name || e.runway || e.len < 30) continue;
      const a = apt.nodes[e.a], b = apt.nodes[e.b];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (this.labels.some(l => l.t === e.name && dist(l.p, m) < 300)) continue;
      this.labels.push({ t: e.name, p: m });
    }
    this.history.clear();
    this.setView(this.view);
  }

  /** SID/STAR polylines from procs.js procLines() (lat/lon). */
  setProcs(lines) {
    this.procs = this.apt ? lines.map(l => ({ ...l, xy: l.pts.map(p => ({ ...p, p: this.apt.toXY(p.lat, p.lon) })) })) : [];
  }

  /** Frame the view for a position. */
  setView(view) {
    this.view = VIEWS[view] ? view : "GND";
    if (!this.apt) return;
    this.resize();
    const apt = this.apt;
    if (this.view === "GND") {
      const xs = [], ys = [];
      for (const r of apt.runways) for (const e of r.ends) { xs.push(e.pos[0]); ys.push(e.pos[1]); }
      for (const s of apt.stands) { xs.push(s.pos[0]); ys.push(s.pos[1]); }
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      this.cx = (x0 + x1) / 2; this.cy = (y0 + y1) / 2;
      this.scale = Math.min(this.w / (x1 - x0 + 400), this.h / (y1 - y0 + 400));
    } else {
      const R = { TWR: 10, APP: 30, CTR: 60 }[this.view] * NM;
      this.cx = 0; this.cy = 0;
      this.scale = Math.min(this.w, this.h) / (2 * R);
    }
  }
  getViewState() { return { view: this.view, cx: this.cx, cy: this.cy, scale: this.scale, filter: this.filter }; }
  setViewState(s) { if (!s) return; this.view = s.view || this.view; this.cx = s.cx; this.cy = s.cy; this.scale = s.scale; if (s.filter) this.filter = s.filter; }

  toScreen(p) { return [this.w / 2 + (p[0] - this.cx) * this.scale, this.h / 2 - (p[1] - this.cy) * this.scale]; }
  toWorld(x, y) { return [this.cx + (x - this.w / 2) / this.scale, this.cy - (y - this.h / 2) / this.scale]; }

  bindMouse() {
    let drag = null;
    const local = (e) => { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    this.cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      const before = this.toWorld(x, y);
      this.scale *= Math.exp(-e.deltaY * 0.0015);
      this.scale = Math.max(0.0005, Math.min(8, this.scale));
      const after = this.toWorld(x, y);
      this.cx += before[0] - after[0]; this.cy += before[1] - after[1];
    }, { passive: false });
    this.cv.addEventListener("mousedown", (e) => {
      const [x, y] = local(e);
      const box = this.labelBoxes.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      if (box) { drag = { label: box.id, x, y, off: [...(this.labelOff.get(box.id) || [14, -22])], moved: false }; return; }
      drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false };
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      if (drag.label != null) {
        const [x, y] = local(e);
        this.labelOff.set(drag.label, [drag.off[0] + x - drag.x, drag.off[1] + y - drag.y]);
        drag.moved = true;
        return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      this.cx = drag.cx - dx / this.scale; this.cy = drag.cy + dy / this.scale;
    });
    window.addEventListener("mouseup", (e) => {
      if (drag && !drag.moved && this.world && e.target === this.cv) {
        if (drag.label != null) { this.onSelect(drag.label); drag = null; return; }
        const [x, y] = local(e);
        let best = null, bd = 18;
        for (const a of this.world.ac) {
          const s = this.toScreen(a.pos); const d = Math.hypot(s[0] - x, s[1] - y);
          if (d < bd) { bd = d; best = a; }
        }
        this.onSelect(best ? best.id : null);
      }
      drag = null;
    });
  }

  /** world: { ac: snapshot[], arrEnd }  selectedId: aircraft id */
  draw(world, selectedId) {
    this.world = world;
    const ctx = this.ctx, apt = this.apt, k = this.scale, dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, this.w, this.h);
    if (!apt) return;
    ctx.setTransform(k * dpr, 0, 0, -k * dpr, (this.w / 2 - this.cx * k) * dpr, (this.h / 2 + this.cy * k) * dpr);
    const radarView = this.view !== "GND";
    if (radarView) {
      const step = { TWR: 2, APP: 5, CTR: 10 }[this.view] * NM;
      ctx.strokeStyle = C.ring; ctx.lineWidth = 1 / k;
      for (let r = step; r <= 80 * NM; r += step) { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke(); }
    }
    // procedures (SID green, STAR amber) with fixes
    if (this.showProcs && radarView && this.procs.length) {
      ctx.lineWidth = 1 / k; ctx.setLineDash([6 / k, 4 / k]);
      for (const l of this.procs) {
        ctx.strokeStyle = l.kind === "sid" ? C.sid : C.star;
        ctx.beginPath();
        if (l.kind === "sid") ctx.moveTo(0, 0);
        l.xy.forEach((p, i) => (i || l.kind === "sid") ? ctx.lineTo(...p.p) : ctx.moveTo(...p.p));
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.fillStyle = C.pave; ctx.fill(this.pave, "evenodd");
    for (const r of apt.runways) {
      const [e0, e1] = r.ends, n = [e0.v[1] * r.width / 2, -e0.v[0] * r.width / 2];
      ctx.beginPath();
      ctx.moveTo(e0.pos[0] + n[0], e0.pos[1] + n[1]); ctx.lineTo(e1.pos[0] + n[0], e1.pos[1] + n[1]);
      ctx.lineTo(e1.pos[0] - n[0], e1.pos[1] - n[1]); ctx.lineTo(e0.pos[0] - n[0], e0.pos[1] - n[1]); ctx.closePath();
      ctx.fillStyle = C.rwy; ctx.fill();
      ctx.strokeStyle = C.rwyEdge; ctx.lineWidth = Math.max(1.2 / k, radarView ? 2.5 / k : 0); ctx.stroke();
      ctx.setLineDash([30, 20]); ctx.lineWidth = 0.8 / k; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(...e0.pos); ctx.lineTo(...e1.pos); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      for (const e of r.ends) if (e.displaced > 0) {
        ctx.beginPath(); ctx.moveTo(e.thr[0] + n[0], e.thr[1] + n[1]); ctx.lineTo(e.thr[0] - n[0], e.thr[1] - n[1]);
        ctx.lineWidth = 2 / k; ctx.stroke();
      }
    }
    if (k > 0.03) {
      ctx.strokeStyle = C.taxiLine; ctx.lineWidth = 1 / k; ctx.stroke(this.taxiLines);
      ctx.strokeStyle = C.hold; ctx.lineWidth = 1.5 / k; ctx.stroke(this.holdLines);
    }
    if (this.showGraph) { ctx.strokeStyle = C.graph; ctx.lineWidth = 1 / k; ctx.stroke(this.graph); }
    // extended centreline with 1 nm ticks
    const ae = world.arrEnd;
    if (ae) {
      ctx.strokeStyle = "#2a3a48"; ctx.lineWidth = 1 / k; ctx.setLineDash([8 / k, 8 / k]);
      ctx.beginPath(); ctx.moveTo(...ae.thr); ctx.lineTo(ae.thr[0] - ae.v[0] * 25 * NM, ae.thr[1] - ae.v[1] * 25 * NM); ctx.stroke();
      ctx.setLineDash([]);
      for (let i = 1; i <= 25; i++) {
        const p = [ae.thr[0] - ae.v[0] * i * NM, ae.thr[1] - ae.v[1] * i * NM], t = (i % 5 ? 120 : 300) / Math.max(1, k * 4);
        ctx.beginPath(); ctx.moveTo(p[0] + ae.v[1] * t, p[1] - ae.v[0] * t); ctx.lineTo(p[0] - ae.v[1] * t, p[1] + ae.v[0] * t); ctx.stroke();
      }
    }
    const sel = world.ac.find(a => a.id === selectedId);
    if (sel && sel.path && sel.path.length && sel.onGround) {
      ctx.strokeStyle = C.route; ctx.lineWidth = 2.5 / k; ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(...sel.pos);
      for (const p of sel.path) ctx.lineTo(p[0], p[1]);
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // ---- screen-space overlays ----
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = "middle"; ctx.textAlign = "center";
    ctx.font = "600 11px ui-monospace, Consolas, monospace";
    for (const r of apt.runways) for (const e of r.ends) {
      const off = 40 / Math.min(1, k * 5 + 0.01);
      const s = this.toScreen([e.pos[0] - e.v[0] * off, e.pos[1] - e.v[1] * off]);
      ctx.fillStyle = C.rwyEdge; ctx.fillText(e.name, s[0], s[1]);
    }
    if (this.showProcs && radarView) {
      ctx.font = "9px ui-monospace, Consolas, monospace"; ctx.fillStyle = C.fix; ctx.strokeStyle = C.fix;
      const seen = new Set();
      for (const l of this.procs) for (const p of l.xy) {
        if (seen.has(p.id)) continue; seen.add(p.id);
        const s = this.toScreen(p.p);
        ctx.beginPath(); ctx.moveTo(s[0], s[1] - 4); ctx.lineTo(s[0] + 4, s[1] + 3); ctx.lineTo(s[0] - 4, s[1] + 3); ctx.closePath(); ctx.stroke();
        ctx.fillText(p.id, s[0], s[1] + 11);
      }
      ctx.textAlign = "left";
      for (const l of this.procs) { const last = l.xy[l.kind === "sid" ? l.xy.length - 1 : 0]; const s = this.toScreen(last.p); ctx.fillStyle = l.kind === "sid" ? C.sid : C.star; ctx.fillText(l.name, s[0] + 6, s[1] - 8); }
      ctx.textAlign = "center";
    }
    if (k > 0.12) {
      ctx.font = "10px ui-monospace, Consolas, monospace";
      for (const l of this.labels) {
        const s = this.toScreen(l.p);
        const w = ctx.measureText(l.t).width + 6;
        ctx.fillStyle = "#11161c"; ctx.fillRect(s[0] - w / 2, s[1] - 7, w, 14);
        ctx.fillStyle = "#d9c45a"; ctx.fillText(l.t, s[0], s[1]);
      }
    }
    if (k > 0.45) {
      ctx.fillStyle = C.stand; ctx.font = "9px ui-monospace, Consolas, monospace";
      for (const st of apt.stands) { const s = this.toScreen(st.pos); ctx.fillText(st.name, s[0], s[1] + 9); }
    }
    if (radarView) {
      ctx.fillStyle = "#3d4d5c"; ctx.font = "10px ui-monospace, Consolas, monospace";
      const step = { TWR: 2, APP: 5, CTR: 10 }[this.view];
      for (let r = step; r <= 80; r += step) { const s = this.toScreen([0, r * NM]); if (s[1] > 10) ctx.fillText(`${r}`, s[0] + 10, s[1] + 6); }
    }
    // arrivals sequence: distance to the threshold and spacing to the one ahead
    const finals = world.ac.filter(a => a.dthr != null).sort((a, b) => a.dthr - b.dthr);
    finals.forEach((a, i) => { a._gap = i ? (a.dthr - finals[i - 1].dthr) / NM : null; });
    this.recordHistory(world.ac);
    this.labelBoxes = [];
    for (const a of world.ac) {
      if (a.onGround ? !this.filter.ground : (!this.filter.air || a.alt > this.filter.maxAlt)) continue;
      this.drawAircraft(a, a.id === selectedId);
    }
  }

  recordHistory(list) {
    const now = performance.now();
    const ids = new Set();
    for (const a of list) {
      ids.add(a.id);
      let h = this.history.get(a.id);
      if (!h) { h = []; this.history.set(a.id, h); }
      if (!h.length || now - h[h.length - 1].t > 4000) { h.push({ p: [...a.pos], t: now }); if (h.length > 7) h.shift(); }
    }
    for (const id of [...this.history.keys()]) if (!ids.has(id)) { this.history.delete(id); this.labelOff.delete(id); }
  }

  /** Silhouette when it would be big enough on screen and we're on a ground/tower picture. */
  useSilhouette(a) {
    const dim = AC_DIM[a.type] || [35, 38, "airliner"];
    if (this.view === "APP" || this.view === "CTR") return false;
    if (!a.onGround && (a.alt || 0) > 300) return false;
    return dim[1] * this.scale >= 7;
  }

  drawAircraft(a, sel) {
    const ctx = this.ctx;
    const s = this.toScreen(a.pos);
    if (s[0] < -200 || s[1] < -200 || s[0] > this.w + 200 || s[1] > this.h + 200) return;
    if (this.view === "GND" && !a.onGround && (a.alt || 0) > 2500) return;
    const base = a.human ? C.human : a.kind === "dep" ? C.dep : a.kind === "ovf" ? C.ovf : C.arr;
    const col = sel ? C.sel : base;
    const blink = a.ident && Math.floor(performance.now() / 400) % 2;
    const silhouette = this.useSilhouette(a);
    ctx.save(); ctx.translate(s[0], s[1]);
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.5;
    if (silhouette) this.drawSilhouette(a, col);
    else this.drawRadarSymbol(a, col);
    if (blink) { ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
    this.drawLabel(a, s, col, sel, silhouette);
  }

  drawSilhouette(a, col) {
    const ctx = this.ctx;
    const [span, len, shape] = AC_DIM[a.type] || [35, 38, "airliner"];
    const k = this.scale;
    ctx.save();
    ctx.rotate(a.hdg * Math.PI / 180);
    ctx.scale(k, k);              // metres; nose towards -y on screen
    const L = len, S = span, fw = shape === "widebody" ? 6 : shape === "ga" ? 1.3 : shape === "heli" ? 2 : 4;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    if (shape === "heli") {
      ctx.ellipse(0, -L * 0.15, fw, L * 0.3, 0, 0, Math.PI * 2);
      ctx.rect(-0.4, -L * 0.05, 0.8, L * 0.55);
      ctx.fill();
      ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.arc(0, -L * 0.15, S / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      // fuselage
      ctx.ellipse(0, 0, fw / 2, L / 2, 0, 0, Math.PI * 2); ctx.fill();
      // wings
      const wy = shape === "ga" ? -L * 0.12 : shape === "turboprop" ? -L * 0.05 : L * 0.02;
      const sweep = shape === "ga" || shape === "turboprop" ? 0 : shape === "regional" ? L * 0.1 : L * 0.16;
      const chordRoot = shape === "ga" ? L * 0.18 : L * 0.2, chordTip = shape === "ga" ? L * 0.16 : L * 0.07;
      ctx.beginPath();
      ctx.moveTo(-fw / 2, wy - chordRoot / 2); ctx.lineTo(-S / 2, wy - chordRoot / 2 + sweep); ctx.lineTo(-S / 2, wy - chordRoot / 2 + sweep + chordTip);
      ctx.lineTo(-fw / 2, wy + chordRoot / 2); ctx.lineTo(fw / 2, wy + chordRoot / 2);
      ctx.lineTo(S / 2, wy - chordRoot / 2 + sweep + chordTip); ctx.lineTo(S / 2, wy - chordRoot / 2 + sweep); ctx.lineTo(fw / 2, wy - chordRoot / 2);
      ctx.closePath(); ctx.fill();
      // tail plane
      const ts = shape === "ga" ? S * 0.32 : S * 0.33, ty = L * 0.4, tc = L * 0.08;
      ctx.beginPath();
      ctx.moveTo(-fw / 4, ty - tc / 2); ctx.lineTo(-ts / 2, ty + (sweep ? tc * 0.6 : 0)); ctx.lineTo(-ts / 2, ty + tc / 2 + (sweep ? tc * 0.6 : 0));
      ctx.lineTo(ts / 2, ty + tc / 2 + (sweep ? tc * 0.6 : 0)); ctx.lineTo(ts / 2, ty + (sweep ? tc * 0.6 : 0)); ctx.lineTo(fw / 4, ty - tc / 2);
      ctx.closePath(); ctx.fill();
      // engines
      ctx.globalAlpha = 1; ctx.fillStyle = "#0a0f14";
      if (shape === "turboprop") for (const x of [-S * 0.22, S * 0.22]) ctx.fillRect(x - 0.7, wy - chordRoot / 2 - 2.5, 1.4, 4);
      else if (shape === "airliner" || shape === "widebody") for (const x of [-S * 0.18, S * 0.18]) ctx.fillRect(x - fw * 0.25, wy - chordRoot / 2 + sweep * 0.35 - 2.5, fw * 0.5, 4);
      else if (shape === "regional" && a.type.startsWith("CRJ")) for (const x of [-fw * 0.9, fw * 0.9]) ctx.fillRect(x - 0.8, L * 0.25, 1.6, 4);
      else if (shape === "regional") for (const x of [-S * 0.17, S * 0.17]) ctx.fillRect(x - 0.9, wy - chordRoot / 2 + sweep * 0.35 - 2, 1.8, 3.5);
    }
    ctx.restore();
    // nose marker (screen size so it's always visible)
    const v = [Math.sin(a.hdg * Math.PI / 180), -Math.cos(a.hdg * Math.PI / 180)];
    const nose = (L / 2) * k;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.arc(v[0] * nose, v[1] * nose, Math.max(1.5, Math.min(3, k * 1.2)), 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col;
  }

  drawRadarSymbol(a, col) {
    const ctx = this.ctx;
    // history dots
    const h = this.history.get(a.id) || [];
    ctx.save(); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = col; ctx.globalAlpha = 0.5;
    const me = this.toScreen(a.pos);
    for (let i = 0; i < h.length - 1; i++) { const s = this.toScreen(h[i].p); if (Math.hypot(s[0] - me[0], s[1] - me[1]) > 2) ctx.fillRect(s[0] - 1.2, s[1] - 1.2, 2.4, 2.4); }
    ctx.restore();
    ctx.globalAlpha = 1;
    // position symbol: square = mode C, circle = primary only, filled when on ground
    if (a.xpdr === "C" || a.human) { if (a.onGround) ctx.fillRect(-3.5, -3.5, 7, 7); else ctx.strokeRect(-3.5, -3.5, 7, 7); }
    else { ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, Math.PI * 2); ctx.stroke(); }
    // 1-minute speed vector
    if (a.spd > 1) {
      const v = [Math.sin(a.hdg * Math.PI / 180), -Math.cos(a.hdg * Math.PI / 180)];
      const lead = Math.max(6, a.spd * 60 * this.scale);
      ctx.beginPath(); ctx.moveTo(v[0] * 4, v[1] * 4); ctx.lineTo(v[0] * lead, v[1] * lead); ctx.stroke();
    }
  }

  drawLabel(a, s, col, sel, silhouette) {
    const ctx = this.ctx;
    const off = this.labelOff.get(a.id) || [14, -22];
    const kt = Math.round(a.spd / 0.5144);
    const lines = [a.cs];
    if (a.onGround) lines.push(`${a.type}/${a.wtc} ${kt}`, `${STATE_SHORT[a.state] || a.state}${a.rwy && a.kind === "dep" ? " " + a.rwy : ""}`);
    else {
      const alt = String(Math.round((a.alt || 0) / 100)).padStart(3, "0");
      const hdg = this.view === "APP" || this.view === "CTR" ? ` H${String(Math.round(a.hdg) % 360).padStart(3, "0")}` : "";
      lines.push(`${a.type}/${a.wtc}${hdg}`, `${alt} ${String(kt).padStart(3, "0")}${a.dthr != null ? " " + (a.dthr / NM).toFixed(1) + "nm" : ""}${a._gap != null ? " Δ" + a._gap.toFixed(1) : ""}`);
    }
    if (a.warn && a.warn.length) lines.push(a.warn.join(" "));
    ctx.save(); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const x = s[0] + off[0], y = s[1] + off[1];
    // leader line from the target to the data block
    ctx.strokeStyle = sel ? C.sel : "#5f7487"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(s[0] + Math.sign(off[0]) * (silhouette ? 0 : 5), s[1]); ctx.lineTo(x - (off[0] < 0 ? -2 : 2), y + 6); ctx.stroke();
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    let w = 0;
    lines.forEach((t, i) => {
      ctx.font = i === 0 ? `${sel ? "700" : "600"} 11px ui-monospace, Consolas, monospace` : i === 3 ? "700 10px ui-monospace, Consolas, monospace" : "10px ui-monospace, Consolas, monospace";
      ctx.fillStyle = i === 0 ? col : i === 3 ? C.warn : (sel ? C.sel : "#a9b8c6");
      const lx = off[0] < 0 ? x - ctx.measureText(t).width : x;
      ctx.fillText(t, lx, y + i * 11);
      w = Math.max(w, ctx.measureText(t).width);
    });
    this.labelBoxes.push({ id: a.id, x: off[0] < 0 ? x - w : x, y: y - 10, w, h: lines.length * 11 + 2 });
    ctx.restore();
  }
}

export const STATE_SHORT = {
  parked: "STAND", clr_req: "CLR REQ", cleared: "CLRD", push_req: "PUSH REQ", pushing: "PUSH", pushed: "PUSHED",
  taxi_req: "TAXI REQ", taxi: "TAXI", holding: "READY", lineup: "LUP", lining: "LUP", lined_up: "LUW",
  roll: "T/O", airborne: "AIRB", final: "FINAL", goaround: "G/A", rollout: "LAND", vacating: "VACATE",
  vacated: "VACATED", holding_short: "HLD SHT", cruise: "ENR", human: "LIVE",
};
