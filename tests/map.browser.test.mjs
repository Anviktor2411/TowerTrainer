// Headless-browser tests of the map and nav data in the real page:
//   F3: the search box (Ctrl+K) finds airports and shows a result on the map with its details
//   B1: every map symbol stays within ~20 px at Ground, Tower, Approach and Centre zoom (EETN, KORD)
//   B2: generated VFR placeholders are marked generic; a user file replaces them
//   node tests/map.browser.test.mjs [port]      (server.py must be running, default :8780)
import { launch, sleep } from "./cdp.mjs";

const PORT = +(process.argv[2] || 8780);
const BASE = `http://localhost:${PORT}`;
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fails++; };

const br = await launch({ port: 9341 });
try {
  const p = await br.newPage("about:blank");
  await p.eval(`localStorage.clear()`).catch(() => {});
  for (const icao of ["EETN", "KORD"]) {
    await p.send("Page.navigate", { url: `${BASE}/?icao=${icao}` });
    ok(await p.waitFor(`window.TT && TT.sim && TT.apt && TT.apt.icao === '${icao}'`, 60000), `page loads ${icao}`);
    await p.eval(`TT.radio.tts = false; TT.settings.voices = false`);
    // some traffic on the map, airborne and on the ground
    await p.eval(`(() => { const s = TT.sim; for (let i = 0; i < 600; i++) s.step(0.5); })()`);
    for (const view of ["GND", "TWR", "APP", "CTR"]) {
      await p.eval(`(() => { TT.radar.setView("${view}"); TT.radar.staticKey = null; })()`);
      await sleep(400);
      // zoomed fully out and fully in on each picture as well
      const sizes = [];
      for (const z of [1, 0.25, 4]) {
        sizes.push(await p.eval(`(() => { const r = TT.radar; r.setView("${view}"); r.scale *= ${z}; r.staticKey = null; r.draw(r.world, null); return r.symbolSizes(); })()`));
      }
      const all = sizes.flat();
      const big = all.filter(s => s.px > 20);
      ok(all.length > 0 && !big.length, `${icao} ${view}: ${all.length} symbols, largest ${Math.max(0, ...all.map(s => s.px)).toFixed(1)} px${big.length ? " — too big: " + JSON.stringify(big.slice(0, 3)) : ""}`);
    }
  }
  // VFR placeholders are marked generic when no real points exist
  await p.send("Page.navigate", { url: `${BASE}/?icao=EETN` });
  await p.waitFor(`window.TT && TT.sim && TT.apt && TT.apt.icao === 'EETN'`, 60000);
  await p.waitFor(`TT.navUi.vfr != null`, 10000);
  const generic = await p.eval(`TT.navUi.vfr.source === "generic" ? TT.radar.vfrPoints.every(v => v.generic) : null`);
  if (generic === null) console.log("note  real VFR points configured on this PC — generic check skipped");
  else ok(generic, "no real VFR points: the placeholders are marked (generic)");

  // F3: search
  ok(await p.waitFor(`TT.navUi.status && TT.navUi.status.state !== "building"`, 120000), "nav index ready: " + await p.eval(`JSON.stringify(TT.navUi.status && TT.navUi.status.state)`));
  if (await p.eval(`TT.navUi.status.state === "ready"`)) {
    await p.eval(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })); })()`);
    ok(await p.eval(`document.activeElement && document.activeElement.id === "navSearch"`), "Ctrl+K focuses the search box");
    await p.eval(`(() => { const b = document.getElementById("navSearch"); b.value = "tallinn"; b.dispatchEvent(new Event("input")); })()`);
    ok(await p.waitFor(`/EETN/.test(document.getElementById("navResults").innerText)`, 5000), "'tallinn' lists EETN");
    await p.eval(`(() => { const b = document.getElementById("navSearch"); b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); })()`);
    ok(await p.waitFor(`TT.radar.highlight && !document.getElementById("navDetail").classList.contains("hidden")`, 5000), "the result is highlighted on the map with its details");
    await p.waitFor(`/Load airport/.test(document.getElementById("navDetail").innerText)`, 3000);
    { const t = await p.eval(`document.getElementById("navDetail").innerText`); ok(/Load airport EETN/i.test(t), "airport details offer Load airport: " + t.slice(0, 160).split("\n").join(" / ")); }
    await p.eval(`(() => { const b = document.getElementById("navSearch"); b.value = "heathorw"; b.dispatchEvent(new Event("input")); })()`);
    ok(await p.waitFor(`/EGLL/.test(document.getElementById("navResults").innerText)`, 5000), "typo 'heathorw' finds EGLL");
  } else console.log("note  no nav database on this PC — search UI checks skipped");
  ok(p.errors.length === 0, "no JS errors " + p.errors.slice(0, 3).join(" | "));
} finally {
  br.close();
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
