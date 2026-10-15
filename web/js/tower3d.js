// Tower view in 3D (G4): the airport seen from the tower cab, drawn with a perspective projection on the
// ordinary 2D canvas — no WebGL, no libraries. Pavement, runways with markings and lights, taxiway lines,
// OpenStreetMap buildings extruded by their height, aircraft as silhouettes with labels, day/night and
// visibility. Drag to look around, wheel for binoculars, click an aircraft to select it.
import { AC_DIM } from "./data.js";
import { statePhrase } from "./labels.js";

const FT = 0.3048;
const KIND_H = { terminal: 14, pier: 9, hangar: 16, tower: 38, building: 8, apron: 0, parking: 0 };
const KIND_COL = { terminal: ["#6b7686", "#4b5563"], pier: ["#6b7686", "#4b5563"], hangar: ["#5f6670", "#444a52"], tower: ["#8a7a5a", "#5a4a2a"], building: ["#56606c", "#3b434c"] };

export class TowerView {
  constructor(radar) {
    this.r = radar;
    this.yaw = 0; this.pitch = -4; this.fov = 60;      // degrees; yaw 0 = looking north
    this.height = 32;                                   // cab height above the apron, metres
    this.eye = [0, 0];
    this.buildings = []; this.labelBoxes = []; this.screen = new Map();
    this.locked = null;                                 // aircraft id the view follows
  }
  setAirport(apt, osm) {
    this.apt = apt;
    this.eye = (osm && osm.tower) || apt.towerPos();
    const rwyLen = Math.max(...apt.runways.map(r => r.len), 1500);
    this.height = Math.max(25, Math.min(60, rwyLen / 80));
    this.buildings = [];
    for (const b of (osm && osm.buildings) || []) {
      if (!b.pts || b.pts.length < 3 || b.kind === "apron" || b.kind === "parking") continue;
      const h = b.height ? parseFloat(b.height) : b.levels ? parseFloat(b.levels) * 3.2 : KIND_H[b.kind] || 8;
      const near = b.pts.some(p => Math.hypot(p[0] - this.eye[0], p[1] - this.eye[1]) < 60);
      if (near && b.kind !== "tower") continue;        // the building the cab sits on would hide everything
      this.buildings.push({ pts: b.pts, h: isFinite(h) ? h : 8, kind: b.kind, c: b.c || [0, 0] });
    }
    // look along the longest runway at first
    const r = apt.runways.slice().sort((a, b) => b.len - a.len)[0];
    if (r) { const mid = [(r.ends[0].pos[0] + r.ends[1].pos[0]) / 2, (r.ends[0].pos[1] + r.ends[1].pos[1]) / 2]; this.yaw = Math.atan2(mid[0] - this.eye[0], mid[1] - this.eye[1]) * 180 / Math.PI; }
    this.cache = null;
  }
  // ---------- projection: world x east, y north, z up (metres) ----------
  camera() {
    const y = this.yaw * Math.PI / 180, p = this.pitch * Math.PI / 180;
    return { ex: this.eye[0], ey: this.eye[1], ez: this.height, fx: Math.sin(y), fy: Math.cos(y), rx: Math.cos(y), ry: -Math.sin(y), cp: Math.cos(p), sp: Math.sin(p),
      F: (this.r.w / 2) / Math.tan(this.fov * Math.PI / 360), cx: this.r.w / 2, cy: this.r.h / 2 };
  }
  /** Camera space: [right, up, depth]. */
  toCam(c, x, y, z) {
    const dx = x - c.ex, dy = y - c.ey, dz = z - c.ez;
    const f = dx * c.fx + dy * c.fy, r = dx * c.rx + dy * c.ry;
    return [r, dz * c.cp - f * c.sp, f * c.cp + dz * c.sp];
  }
  proj(c, v) { return [c.cx + v[0] * c.F / v[2], c.cy - v[1] * c.F / v[2]]; }
  /** Clip a camera-space polygon against the near plane and project it (Sutherland–Hodgman on depth). */
  polygon(c, pts3) {
    const near = 2, out = [];
    for (let i = 0; i < pts3.length; i++) {
      const a = pts3[i], b = pts3[(i + 1) % pts3.length];
      const ina = a[2] >= near, inb = b[2] >= near;
      if (ina) out.push(a);
      if (ina !== inb) { const t = (near - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near]); }
    }
    return out.length >= 3 ? out.map(v => this.proj(c, v)) : null;
  }
  fillWorld(ctx, c, pts, z = 0) {
    const poly = this.polygon(c, pts.map(p => this.toCam(c, p[0], p[1], z)));
    if (!poly) return false;
    ctx.beginPath(); poly.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.fill();
    return true;
  }
  strokeWorld(ctx, c, pts, z = 0) {
    const near = 2; let open = false;
    ctx.beginPath();
    for (let i = 0; i + 1 < pts.length; i++) {
      let a = this.toCam(c, pts[i][0], pts[i][1], z), b = this.toCam(c, pts[i + 1][0], pts[i + 1][1], z);
      if (a[2] < near && b[2] < near) { open = false; continue; }
      if (a[2] < near) { const t = (near - a[2]) / (b[2] - a[2]); a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near]; open = false; }
      if (b[2] < near) { const t = (near - a[2]) / (b[2] - a[2]); b = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near]; }
      const pa = this.proj(c, a), pb = this.proj(c, b);
      if (!open) ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pb[0], pb[1]); open = b[2] >= near;
    }
    ctx.stroke();
  }
  // ---------- the frame ----------
  draw(world, selectedId) {
    const r = this.r, ctx = r.ctx, apt = r.apt, night = r.night, dpr = r.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.locked != null) { const a = world.ac.find(x => x.id === this.locked); if (a) this.lookAt(a.pos, (a.alt || 0) * FT); else this.locked = null; }
    const c = this.camera();
    const vis = r.wx && r.wx.vis != null ? r.wx.vis : 10000;
    const fog = vis < 8000;
    // sky and ground
    const horizon = c.cy + Math.tan(this.pitch * Math.PI / 180) * c.F;
    const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, horizon));
    if (night) { sky.addColorStop(0, "#03050a"); sky.addColorStop(1, "#101620"); } else if (fog) { sky.addColorStop(0, "#8d9499"); sky.addColorStop(1, "#b9bfc3"); } else { sky.addColorStop(0, "#4f8ad0"); sky.addColorStop(1, "#b9d4ee"); }
    ctx.fillStyle = sky; ctx.fillRect(0, 0, r.w, Math.max(0, horizon));
    ctx.fillStyle = night ? "#07090c" : fog ? "#6f7572" : "#3f5a34"; ctx.fillRect(0, Math.max(0, horizon), r.w, r.h);
    // pavement and runways (flat, far first is not needed: painter order by layer)
    ctx.fillStyle = night ? "#15191f" : fog ? "#787d82" : "#6d7278";
    for (const rings of apt.d.pavement || []) for (const ring of rings) this.fillWorld(ctx, c, ring);
    for (const R of apt.runways) {
      const [e0, e1] = R.ends, n = [e0.v[1] * R.width / 2, -e0.v[0] * R.width / 2];
      ctx.fillStyle = night ? "#0d1014" : fog ? "#5f6468" : "#4a4f55";
      this.fillWorld(ctx, c, [[e0.pos[0] + n[0], e0.pos[1] + n[1]], [e1.pos[0] + n[0], e1.pos[1] + n[1]], [e1.pos[0] - n[0], e1.pos[1] - n[1]], [e0.pos[0] - n[0], e0.pos[1] - n[1]]]);
      ctx.strokeStyle = night ? "#2a2e34" : "#d8dde2"; ctx.lineWidth = 1.2; ctx.setLineDash([]);
      this.strokeWorld(ctx, c, [e0.pos, e1.pos]);
      // threshold bars and designators as lines across the runway
      for (const e of R.ends) {
        for (const s of [8, 16, 24]) { const p = [e.thr[0] + e.v[0] * s, e.thr[1] + e.v[1] * s]; this.strokeWorld(ctx, c, [[p[0] + n[0] * 0.9, p[1] + n[1] * 0.9], [p[0] - n[0] * 0.9, p[1] - n[1] * 0.9]]); }
      }
    }
    // taxiway centre lines and holding positions
    ctx.strokeStyle = night ? "#3a3418" : "#c9b23a"; ctx.lineWidth = 1;
    for (const l of apt.d.lines || []) this.strokeWorld(ctx, c, l);
    ctx.strokeStyle = "#e0b040"; ctx.lineWidth = 2;
    for (const l of apt.d.holdLines || []) this.strokeWorld(ctx, c, l);
    // stop bars
    for (const b of r.stopBars) { ctx.strokeStyle = b.lit ? "#ff2d2d" : "#5a2a2a"; ctx.lineWidth = b.lit ? 3 : 1.5; this.strokeWorld(ctx, c, [[b.p[0] - b.v[1] * b.len / 2, b.p[1] + b.v[0] * b.len / 2], [b.p[0] + b.v[1] * b.len / 2, b.p[1] - b.v[0] * b.len / 2]], 0.3); }
    // lights at night: runway edge (white), taxiway centre (green) as points that shrink with distance
    if (night) this.drawLights(ctx, c, apt);
    // buildings and aircraft: painter's algorithm, far to near
    const items = [];
    for (const b of this.buildings) items.push({ d: Math.hypot(b.c[0] - c.ex, b.c[1] - c.ey), b });
    for (const a of world.ac) { if (!(a.veh && a.state === "idle")) items.push({ d: Math.hypot(a.pos[0] - c.ex, a.pos[1] - c.ey), a }); }
    items.sort((p, q) => q.d - p.d);
    this.labelBoxes = []; this.screen = new Map();
    const labels = [];
    for (const it of items) {
      const alpha = fog ? Math.max(0.05, 1 - it.d / (vis * 1.3)) : it.d > 12000 ? 0.4 : 1;
      ctx.globalAlpha = alpha;
      if (it.b) this.drawBuilding(ctx, c, it.b, night);
      else { const s = this.drawAircraft(ctx, c, it.a, it.a.id === selectedId, night); if (s) labels.push({ a: it.a, s, d: it.d, alpha }); }
    }
    ctx.globalAlpha = 1;
    // labels: callsign and state, nearest first, skipping ones that would overlap
    labels.sort((p, q) => p.d - q.d);
    ctx.font = "11px ui-monospace, Consolas, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    for (const l of labels) {
      const a = l.a, sel = a.id === selectedId;
      if (l.d > 15000 && !sel) continue;
      const txt = l.d < 4000 || sel ? `${a.cs} ${a.type || ""}` : a.cs;
      const w = ctx.measureText(txt).width + 8, h = 14, x = l.s[0] - w / 2, y = l.s[1] - 10 - h;
      if (!sel && this.labelBoxes.some(b => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y)) continue;
      ctx.globalAlpha = l.alpha;
      ctx.fillStyle = sel ? "rgba(40,80,50,0.85)" : "rgba(10,15,20,0.7)"; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = sel ? "#c8ffd0" : a.human ? "#9ad0ff" : a.veh ? "#ffd04a" : "#e8eef4"; ctx.fillText(txt, l.s[0], y + h - 2);
      if (l.d < 2500 || sel) { ctx.fillStyle = "#b8c4d0"; ctx.fillText(statePhrase(a), l.s[0], y - 1); }
      this.labelBoxes.push({ id: a.id, x, y, w, h });
      this.screen.set(a.id, l.s);
    }
    ctx.globalAlpha = 1;
    // compass strip and the cab info
    this.drawHud(ctx, c, night);
    r.labelBoxes = this.labelBoxes;
  }
  drawLights(ctx, c, apt) {
    const dot = (p, z, col) => { const v = this.toCam(c, p[0], p[1], z); if (v[2] < 2 || v[2] > 9000) return; const s = this.proj(c, v); const sz = Math.max(1, Math.min(3, 600 / v[2])); ctx.fillStyle = col; ctx.fillRect(s[0] - sz / 2, s[1] - sz / 2, sz, sz); };
    for (const R of apt.runways) {
      const [e0] = R.ends, n = [e0.v[1] * R.width / 2, -e0.v[0] * R.width / 2];
      for (let s = 0; s <= R.len; s += 60) for (const sgn of [1, -1]) dot([e0.pos[0] + e0.v[0] * s + sgn * n[0], e0.pos[1] + e0.v[1] * s + sgn * n[1]], 0.3, "#f0f0d8");
      for (const e of R.ends) for (let i = -4; i <= 4; i++) dot([e.thr[0] + (e.v[1] * i * R.width / 9), e.thr[1] - (e.v[0] * i * R.width / 9)], 0.3, "#5bff6a");
    }
    for (const q of this.r.centrePts || []) dot(q, 0.2, "#4dff7a");
    for (const q of this.r.edgePts || []) dot(q, 0.2, "#4f7dff");
  }
  drawBuilding(ctx, c, b, night) {
    const [top, wall] = KIND_COL[b.kind] || KIND_COL.building;
    const h = b.h;
    // walls: each edge as a quad, those facing away are still drawn (painter's within the building: far edges first)
    const edges = b.pts.map((p, i) => { const q = b.pts[(i + 1) % b.pts.length]; return { p, q, d: Math.hypot((p[0] + q[0]) / 2 - c.ex, (p[1] + q[1]) / 2 - c.ey) }; }).sort((u, v) => v.d - u.d);
    for (const e of edges) {
      const poly = this.polygon(c, [this.toCam(c, e.p[0], e.p[1], 0), this.toCam(c, e.q[0], e.q[1], 0), this.toCam(c, e.q[0], e.q[1], h), this.toCam(c, e.p[0], e.p[1], h)]);
      if (!poly) continue;
      ctx.fillStyle = night ? "#1a1e24" : wall;
      ctx.beginPath(); poly.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.fill();
      if (night && b.kind !== "hangar") { // lit windows
        ctx.fillStyle = "rgba(255,230,160,0.35)";
        const n = Math.min(12, Math.round(Math.hypot(e.q[0] - e.p[0], e.q[1] - e.p[1]) / 6));
        for (let i = 1; i < n; i += 2) { const t = i / n; const v = this.toCam(c, e.p[0] + (e.q[0] - e.p[0]) * t, e.p[1] + (e.q[1] - e.p[1]) * t, h * 0.6); if (v[2] > 2) { const s = this.proj(c, v); ctx.fillRect(s[0] - 1, s[1] - 1, 2, 2); } }
      }
    }
    ctx.fillStyle = night ? "#22272e" : top;
    this.fillWorld(ctx, c, b.pts, h);
  }
  /** The aircraft as its top-view silhouette placed in the world at its altitude; returns the screen point of the nose for the label. */
  drawAircraft(ctx, c, a, sel, night) {
    const [span, len, shape] = AC_DIM[a.type] || (a.veh ? [2.2, 5, "veh"] : [35, 38, "airliner"]);
    const z = a.onGround ? 1.5 : Math.max(2, (a.alt || 0) * FT);
    const h = (a.hdg || 0) * Math.PI / 180, fx = Math.sin(h), fy = Math.cos(h), rx = Math.cos(h), ry = -Math.sin(h);
    const W = (u, v) => [a.pos[0] + fx * v + rx * u, a.pos[1] + fy * v + ry * u];     // u right, v forward (metres)
    const col = sel ? "#8dffa6" : a.veh ? "#ffd04a" : a.human ? "#9ad0ff" : a.mayday ? "#ff8a8a" : night ? "#9aa4b0" : "#e9eef3";
    ctx.fillStyle = col;
    const camC = this.toCam(c, a.pos[0], a.pos[1], z);
    if (camC[2] < 2) return null;
    const px = Math.max(span, len) * c.F / camC[2];
    const nose = this.proj(c, this.toCam(c, ...W(0, len / 2), z));
    if (px < 3) { const s = this.proj(c, camC); ctx.fillRect(s[0] - 1.5, s[1] - 1.5, 3, 3); return s; }   // far away: a dot
    const fw = shape === "widebody" ? 6 : shape === "ga" ? 1.3 : shape === "veh" ? 2.2 : 4;
    const body = [W(-fw / 2, len / 2), W(fw / 2, len / 2), W(fw / 2, -len / 2), W(-fw / 2, -len / 2)];
    this.fillWorld(ctx, c, body, z);
    if (shape !== "veh") {
      const wy = shape === "ga" ? len * 0.12 : -len * 0.02, sweep = shape === "ga" || shape === "turboprop" ? 0 : len * 0.14, chord = len * 0.18;
      this.fillWorld(ctx, c, [W(-fw / 2, wy + chord / 2), W(-span / 2, wy + chord / 2 - sweep), W(-span / 2, wy - chord / 2 - sweep), W(-fw / 2, wy - chord / 2)], z);
      this.fillWorld(ctx, c, [W(fw / 2, wy + chord / 2), W(span / 2, wy + chord / 2 - sweep), W(span / 2, wy - chord / 2 - sweep), W(fw / 2, wy - chord / 2)], z);
      const ts = span * 0.3, ty = -len * 0.42;
      this.fillWorld(ctx, c, [W(-ts / 2, ty - len * 0.03), W(ts / 2, ty - len * 0.03), W(ts / 2, ty + len * 0.05), W(-ts / 2, ty + len * 0.05)], z);
      // the fin: a vertical triangle at the tail
      const finPoly = this.polygon(c, [this.toCam(c, ...W(0, ty), z), this.toCam(c, ...W(0, ty + len * 0.12), z), this.toCam(c, ...W(0, ty - len * 0.02), z + len * 0.09)]);
      if (finPoly) { ctx.beginPath(); finPoly.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath(); ctx.fill(); }
    }
    if (night || a.onGround) { const s = this.proj(c, camC); ctx.fillStyle = "#ff4040"; ctx.fillRect(s[0] - 1, s[1] - 1, 2, 2); }   // beacon
    return nose;
  }
  drawHud(ctx, c, night) {
    const w = this.r.w;
    ctx.fillStyle = "rgba(8,12,16,0.55)"; ctx.fillRect(0, 0, w, 22);
    ctx.font = "11px ui-monospace, Consolas, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const span = this.fov;
    for (let deg = -180; deg < 540; deg += 10) {
      const rel = ((deg - this.yaw + 540) % 360) - 180;
      if (Math.abs(rel) > span / 2) continue;
      const x = c.cx + Math.tan(rel * Math.PI / 180) * c.F;
      const major = deg % 30 === 0, d = ((deg % 360) + 360) % 360;
      ctx.fillStyle = major ? "#e8eef4" : "#8a96a2";
      ctx.fillRect(x - 0.5, major ? 14 : 17, 1, major ? 8 : 5);
      if (major) ctx.fillText(d === 0 ? "N" : d === 90 ? "E" : d === 180 ? "S" : d === 270 ? "W" : String(d).padStart(3, "0"), x, 7);
    }
    ctx.textAlign = "left"; ctx.fillStyle = "#9aa7b4";
    ctx.fillText(`3D tower · drag to look · wheel = binoculars (${Math.round(this.fov)}°) · click an aircraft to select, double-click to follow${this.locked != null ? " · following" : ""}${night ? " · night" : ""}`, 8, this.r.h - 10);
  }
  lookAt(pos, z = 0) {
    const dx = pos[0] - this.eye[0], dy = pos[1] - this.eye[1], d = Math.hypot(dx, dy);
    this.yaw = Math.atan2(dx, dy) * 180 / Math.PI;
    this.pitch = Math.atan2(z - this.height, d) * 180 / Math.PI;
  }
  /** Mouse handling while the 3D view is active: drag = look, wheel = zoom; returns true when it consumed the event. */
  wheel(e) { this.fov = Math.max(8, Math.min(90, this.fov * Math.exp(e.deltaY * 0.001))); return true; }
  dragStart(x, y) { this.drag = { x, y, yaw: this.yaw, pitch: this.pitch }; }
  dragMove(x, y) {
    if (!this.drag) return false;
    const degPerPx = this.fov / this.r.w;
    this.yaw = this.drag.yaw + (x - this.drag.x) * degPerPx; this.pitch = Math.max(-60, Math.min(45, this.drag.pitch - (y - this.drag.y) * degPerPx));
    this.locked = null;
    return Math.abs(x - this.drag.x) + Math.abs(y - this.drag.y) > 3;
  }
  dragEnd() { this.drag = null; }
  targetAt(x, y) {
    const box = this.labelBoxes.find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    if (box) return this.r.world.ac.find(a => a.id === box.id) || null;
    let best = null, bd = 16;
    for (const [id, s] of this.screen) { const d = Math.hypot(s[0] - x, s[1] - y); if (d < bd) { bd = d; best = this.r.world.ac.find(a => a.id === id); } }
    return best;
  }
}
