// Interactive guide: a scripted scenario (fixed seed, one aircraft at a time, sim paused between steps)
// with an overlay that highlights the real UI element and waits until the step is actually done.
// Texts in English and Estonian; radio phraseology stays English.

const $ = (id) => document.getElementById(id);

/** Steps. Each: { id, target, title:{en,et}, text:{en,et}(ctx), setup?(ctx), phrase?(ctx), done?(ctx), speed? } */
// phase order, so a step counts as done once the aircraft has reached that phase or any later one
const DEP_ORDER = ["parked", "clr_req", "cleared", "push_req", "pushing", "pushed", "taxi_req", "taxi", "holding", "lineup", "lining", "lined_up", "roll", "airborne"];
const ARR_ORDER = ["final", "rollout", "vacating", "vacated", "holding_short", "taxi", "parked"];
const atLeast = (a, s, order = DEP_ORDER) => !!a && (a.gone || order.indexOf(a.state) >= order.indexOf(s));

export function guideSteps() {
  const dep = (c) => c.app.guideDep;
  const arr = (c) => c.app.guideArr;
  const cs = (a) => a ? `${a.tel} ${a.num}` : "";
  return [
    { id: "welcome", target: null,
      title: { en: "Welcome to Tower Trainer", et: "Tere tulemast Tower Traineri" },
      text: { en: () => "This guide walks one departure and one arrival through Delivery, Ground and Tower. The simulation pauses after each step — press Next when you're ready. \"Show me\" gives the correct phraseology; click it to type it.",
        et: () => "See juhend viib ühe väljuva ja ühe saabuva lennuki läbi Delivery, Groundi ja Toweri. Simulatsioon peatub iga sammu järel — vajuta Next, kui oled valmis. „Show me“ näitab õiget fraseoloogiat; klõpsa sellel, et see sisestada." } },
    { id: "airport", target: "#aptForm",
      title: { en: "1. Load an airport", et: "1. Lae lennujaam" },
      text: { en: () => "Type an ICAO code (e.g. EETN) and press Load. Layout, taxiways, stands and frequencies come from the X-Plane Scenery Gateway.",
        et: () => "Sisesta ICAO kood (nt EETN) ja vajuta Load. Paigutus, ruleerimisteed, seisukohad ja sagedused tulevad X-Plane Scenery Gatewayst." },
      done: (c) => !!c.app.apt },
    { id: "runway", target: "#rwySel",
      title: { en: "Pick the runway from the wind", et: "Vali rada tuule järgi" },
      text: { en: (c) => `Aircraft take off and land into the wind. The METAR wind is ${c.app.windText()}. Choose the runway whose heading is closest to the wind direction: ${c.app.bestRunway()}.`,
        et: (c) => `Õhusõidukid tõusevad ja maanduvad vastu tuult. METAR-i tuul on ${c.app.windText()}. Vali rada, mille kurss on tuule suunale kõige lähemal: ${c.app.bestRunway()}.` },
      done: (c) => $("rwySel").value === c.app.bestRunway() },
    { id: "delreq", target: "#log",
      setup: (c) => c.app.guideScenario(),
      title: { en: "2. Delivery: the pilot calls", et: "2. Delivery: piloot kutsub" },
      text: { en: (c) => `${cs(dep(c))} is on stand and asks for an IFR clearance. Read the request in the frequency log: stand, ATIS letter and destination.`,
        et: (c) => `${cs(dep(c))} on seisukohal ja palub IFR-luba. Loe päringut sageduse logist: seisukoht, ATIS-e täht ja sihtkoht.` },
      done: (c) => atLeast(dep(c), "clr_req") },
    { id: "squawk", target: "#assignSq",
      title: { en: "Assign a squawk", et: "Määra transponderikood" },
      text: { en: () => "Every IFR flight gets a unique code from the local block. Click \"Assign squawk\": it fills the next free code into a clearance for the selected aircraft.",
        et: () => "Iga IFR-lend saab kohalikust plokist unikaalse koodi. Klõpsa „Assign squawk“: see lisab järgmise vaba koodi valitud lennuki loale." },
      setup: (c) => c.app.select(dep(c)),
      done: () => /squawk [0-7]{4}/.test($("cmd").value) },
    { id: "clearance", target: "#cmd",
      title: { en: "Give the IFR clearance", et: "Anna IFR-luba" },
      text: { en: () => "Clearance limit, route, initial climb, squawk. Press Enter to transmit, then listen to the readback carefully.",
        et: () => "Loa piir, marsruut, algne tõus, kood. Vajuta Enter, et saata, ja kuula kordust tähelepanelikult." },
      setup: (c) => { c.app.sim.forceRbError = true; },
      phrase: (c) => $("cmd").value.includes("cleared to") ? $("cmd").value : c.app.clearanceText(dep(c)),
      done: (c) => atLeast(dep(c), "cleared") },
    { id: "readback", target: "#log",
      title: { en: "Catch the readback error", et: "Leia korduse viga" },
      text: { en: (c) => { const e = dep(c) && dep(c).rbError; return e ? `The pilot read back the ${e.label} wrong (${e.wrong}). Correct it with "negative" and the right value. If you don't within 30 s you'll get a "missed readback error" alert.` : "Check the readback against what you said."; },
        et: (c) => { const e = dep(c) && dep(c).rbError; return e ? `Piloot kordas ${e.label === "squawk" ? "koodi" : e.label === "altitude" ? "kõrguse" : e.label === "runway" ? "raja" : "sageduse"} valesti (${e.wrong}). Paranda sõnaga „negative“ ja õige väärtusega. Kui 30 s jooksul ei paranda, tuleb hoiatus „missed readback error“.` : "Võrdle kordust sellega, mida ütlesid."; } },
      phrase: (c) => { const a = dep(c), e = a && a.rbError; if (!e) return ""; return `${cs(a)} negative, ${e.label === "squawk" ? "squawk " + e.right : e.label === "altitude" ? "climb " + e.right + " feet" : e.label === "frequency" ? "contact " + e.right : "runway " + e.right}`; },
      done: (c) => { const e = dep(c) && dep(c).rbError; return !e || e.fixed; } },
    { id: "push", target: "#cmd", speed: 4,
      title: { en: "3. Ground: push and start", et: "3. Ground: tagasilükkamine ja käivitus" },
      text: { en: () => "Wait for the push request, then approve it. You may add a direction: \"facing east\".",
        et: () => "Oota tagasilükkamise palvet ja kinnita see. Võid lisada suuna: „facing east“." },
      phrase: (c) => `${cs(dep(c))} push and start approved`,
      done: (c) => atLeast(dep(c), "pushing") },
    { id: "taxi", target: "#cmd", speed: 4,
      title: { en: "Taxi to the holding point", et: "Ruleeri ootealale" },
      text: { en: () => "When the pilot asks for taxi, give the clearance limit (holding point / runway) and the route. The green line on the radar shows the route of the selected aircraft. Aircraft always stop short of every runway.",
        et: () => "Kui piloot palub ruleerimist, anna loa piir (ooteala / rada) ja marsruut. Roheline joon radaril näitab valitud lennuki marsruuti. Lennukid peatuvad alati iga raja ees." },
      phrase: (c) => c.app.taxiText(dep(c)),
      done: (c) => atLeast(dep(c), "taxi") },
    { id: "cross", target: "#radar", speed: 4,
      title: { en: "Runway crossings", et: "Raja ületamine" },
      text: { en: (c) => c.app.crossingOnRoute(dep(c)) ? "This route crosses a runway. When the pilot reports holding short, check the runway is free and say \"cross runway …\"." : "This route has no runway crossing. At airports where it does, the pilot stops and reports \"holding short\" — clear them with \"cross runway …\" only when the runway is free. Wait until the aircraft reaches the holding point.",
        et: (c) => c.app.crossingOnRoute(dep(c)) ? "See marsruut ületab rada. Kui piloot teatab „holding short“, kontrolli, et rada on vaba, ja ütle „cross runway …“." : "Sellel marsruudil pole raja ületamist. Kus on, peatub piloot ja teatab „holding short“ — luba „cross runway …“ ainult siis, kui rada on vaba. Oota, kuni lennuk jõuab ootealale." },
      phrase: (c) => dep(c) && dep(c).blockedRwy != null && dep(c).atStop ? `${cs(dep(c))} cross runway ${c.app.apt.runways[dep(c).blockedRwy].ends[0].name}` : "",
      done: (c) => atLeast(dep(c), "holding") },
    { id: "lineup", target: "#cmd",
      title: { en: "4. Tower: line up and wait", et: "4. Tower: sõida rajale ja oota" },
      text: { en: () => "The pilot is ready for departure. Put them on the runway: always state the runway.",
        et: () => "Piloot on väljumiseks valmis. Lase rajale: nimeta alati rada." },
      phrase: (c) => `${cs(dep(c))} runway ${dep(c).depEnd.name} line up and wait`,
      done: (c) => atLeast(dep(c), "lineup") },
    { id: "takeoff", target: "#cmd",
      title: { en: "Takeoff clearance", et: "Õhkutõusuluba" },
      text: { en: () => "Runway free and no arrival inside ~4 nm? Clear for takeoff — runway first, then \"cleared for takeoff\".",
        et: () => "Rada vaba ja ühtegi saabujat ~4 NM sees? Anna õhkutõusuluba — enne rada, siis „cleared for takeoff“." },
      phrase: (c) => `${cs(dep(c))} runway ${dep(c).depEnd.name} cleared for takeoff`,
      done: (c) => atLeast(dep(c), "roll") },
    { id: "handoff", target: "#cmd",
      title: { en: "Frequency change", et: "Sageduse vahetus" },
      text: { en: (c) => `Once airborne, hand the aircraft to Approach/Radar: "contact ${c.app.approachName()}". Don't wait for them to ask.`,
        et: (c) => `Kui lennuk on õhus, anna see üle Approachile/Radarile: „contact ${c.app.approachName()}“. Ära oota, kuni nad küsivad.` },
      phrase: (c) => `${cs(dep(c))} contact ${c.app.approachName()}`,
      done: (c) => !dep(c) || dep(c).gone || dep(c).handedOff || dep(c).freq === "APP" },
    { id: "landing", target: "#cmd",
      setup: (c) => c.app.guideArrival(),
      title: { en: "5. Arrival: landing clearance", et: "5. Saabuja: maandumisluba" },
      text: { en: (c) => `${cs(arr(c))} reports on final. Runway free? Give the landing clearance (runway first). Without it they go around at about 0.3 nm.`,
        et: (c) => `${cs(arr(c))} teatab lõpplähenemisest. Rada vaba? Anna maandumisluba (enne rada). Ilma selleta teevad nad ~0,3 NM juures kordusringi.` },
      phrase: (c) => `${cs(arr(c))} runway ${arr(c).end.name} cleared to land`,
      done: (c) => arr(c) && arr(c).landClr },
    { id: "vacate", target: "#radar", speed: 2,
      title: { en: "Vacate and hand off to Ground", et: "Raja vabastamine ja üleandmine Groundile" },
      text: { en: () => "After landing the pilot vacates and reports it. With split positions you now say \"contact Ground …\"; in combined mode they ask you directly for taxi.",
        et: () => "Pärast maandumist vabastab piloot raja ja teatab sellest. Jagatud positsioonidega ütled nüüd „contact Ground …“; kombineeritud režiimis küsivad nad otse sinult ruleerimist." },
      done: (c) => atLeast(arr(c), "vacated", ARR_ORDER) },
    { id: "taxiin", target: "#cmd",
      title: { en: "Taxi to the stand", et: "Ruleeri seisukohale" },
      text: { en: () => "Give the stand and the route.", et: () => "Anna seisukoht ja marsruut." },
      phrase: (c) => c.app.taxiInText(arr(c)),
      done: (c) => arr(c) && (arr(c).taxiTo === "stand" || arr(c).gone) },
    { id: "rcf", target: "#acInfo",
      title: { en: "Radio failure (RCF) and light signals", et: "Raadioside katkemine (RCF) ja valgussignaalid" },
      text: { en: () => "An aircraft squawking 7600 (label \"RCF\") cannot hear or answer you — only \"squawk ident\" shows on its label. Talk to it with the light gun: click the aircraft and use the buttons in its panel, or type \"FIN321 light green flashing\" (taxi / cross), \"light green steady\" (takeoff, or in the air: cleared to land), \"light red steady\" (stop / go around), \"light white flashing\" (return to the stand). \"Send follow-me\" dispatches the follow-me car, which leads the aircraft to its stand and asks you for runway crossings.",
        et: () => "7600 koodiga lennuk (sildil „RCF“) ei kuule sind ega vasta — ainult „squawk ident“ näitab sildil. Suhtle temaga valgussignaalidega: klõpsa lennukil ja kasuta paneeli nuppe või kirjuta „FIN321 light green flashing“ (ruleeri / ületa rada), „light green steady“ (õhkutõus; õhus: maandumisluba), „light red steady“ (peatu / mine kordusringile), „light white flashing“ (tagasi seisukohale). „Send follow-me“ saadab follow-me auto, mis juhatab lennuki seisukohale ja küsib sinult raja ületamist." } },
    { id: "popout", target: "#posTabs",
      title: { en: "6. Positions and pop-out windows", et: "6. Positsioonid ja eraldi aknad" },
      text: { en: () => "Each position has its own tab, frequency, strips and log. The ⧉ button pops a position into its own window — put Ground, Tower and the radar on different monitors. The layout is remembered.",
        et: () => "Igal positsioonil on oma sakk, sagedus, ribad ja logi. Nupp ⧉ avab positsiooni eraldi aknas — pane Ground, Tower ja radar eri monitoridele. Paigutus jäetakse meelde." } },
    { id: "staffing", target: "#staffBtn",
      title: { en: "Staffing", et: "Positsioonide valik" },
      text: { en: () => "Choose which positions you work (e.g. only Ground, or GND+TWR). The others are run by AI controllers with correct phraseology, so you can practise one position at a time — or everything combined on one frequency.",
        et: () => "Vali, milliseid positsioone sa töötad (nt ainult Ground või GND+TWR). Teisi juhivad AI-lennujuhid õige fraseoloogiaga, nii et saad harjutada ühte positsiooni korraga — või kõike koos ühel sagedusel." } },
    { id: "euroscope", target: "#esStatus",
      title: { en: "EuroScope", et: "EuroScope" },
      text: { en: () => "Use EuroScope as your radar: Connect → Direct to VATSIM, untick \"Connect to VATSIM\", server 127.0.0.1, any callsign/password. Text on your frequency reaches the pilots here. Details under \"Phraseology\".",
        et: () => "Kasuta EuroScope'i radarina: Connect → Direct to VATSIM, eemalda linnuke „Connect to VATSIM“, server 127.0.0.1, suvaline kutsung/parool. Sinu sageduse tekst jõuab siinsete pilootideni. Täpsemalt „Phraseology“ all." } },
    { id: "simbrief", target: "#ofpBtn",
      title: { en: "Your SimBrief flight", et: "Sinu SimBriefi lend" },
      text: { en: () => "OFP: fetch your latest SimBrief flight plan (username or Pilot ID in Settings), see the route on the map and the weather at both ends, and \"Add my flight\" to work it as traffic with the real route, level and EOBT. In X-Plane, XRadio imports the same OFP and files it to you.",
        et: () => "OFP: too oma viimane SimBriefi lennuplaan (kasutajanimi või Pilot ID seadetes), vaata marsruuti kaardil ja ilma mõlemas otsas ning „Add my flight“ paneb selle liiklusena radarile õige marsruudi, kõrguse ja EOBT-ga. X-Plane'is impordib XRadio sama OFP ja esitab selle sulle." } },
    { id: "aiatc", target: "#log",
      title: { en: "AI controllers for a real pilot", et: "AI-lennujuhid päris piloodile" },
      text: { en: () => "Fly the plan yourself in X-Plane with XRadio: the positions you do not staff answer you — clearance from the plan with a readback check, taxi watched against the real position, takeoff, climb, handoffs — and the Delivery panel's Debrief lists every call and deviation.",
        et: () => "Lenda plaani ise X-Plane'is XRadioga: positsioonid, mida sa ise ei tööta, vastavad sulle — luba plaanist koos korduse kontrolliga, ruleerimine päris asukoha järgi, start, tõus, üleandmised — ja Delivery paneeli Debrief loetleb iga kõne ja kõrvalekalde." } },
    { id: "xradio", target: "#settingsBtn",
      title: { en: "XRadio and settings", et: "XRadio ja seaded" },
      text: { en: () => "Settings: accents, readback-error and say-again rates, radio effect, voices per nationality, coach mode — and XRadio, to put the AI traffic into X-Plane and real XRadio pilots on your radar.",
        et: () => "Seaded: aktsendid, korduse vigade ja „say again“ sagedus, raadioefekt, häälte tabel rahvuste kaupa, coach-režiim — ja XRadio, et AI-liiklus jõuaks X-Plane'i ja päris XRadio piloodid sinu radarile." } },
    { id: "done", target: "#debriefBtn",
      title: { en: "Done!", et: "Valmis!" },
      text: { en: () => "Open the Debrief for a summary of this session. Turn on Coach mode for notes after every transmission. Have fun!",
        et: () => "Ava Debrief, et näha sessiooni kokkuvõtet. Lülita sisse Coach-režiim, et saada märkused iga saate järel. Head harjutamist!" } },
  ];
}

export class Guide {
  constructor(app) {
    this.app = app;
    this.steps = guideSteps();
    this.i = 0;
    this.active = false;
    this.doneAt = null;
    for (const [id, fn] of [["guideNext", () => this.next()], ["guideBack", () => this.back()], ["guideSkip", () => this.next(true)],
      ["guideClose", () => this.stop()], ["guideShow", () => this.show()]]) $(id).addEventListener("click", fn);
    $("guidePhrase").addEventListener("click", () => { const t = $("guidePhrase").textContent; $("cmd").value = t; $("cmd").focus(); });
    window.addEventListener("resize", () => this.place());
  }
  get lang() { return this.app.settings.lang || "en"; }
  ctx() { return { app: this.app }; }
  start() { this.active = true; this.i = 0; $("guideLayer").classList.remove("hidden"); this.enter(); this.timer = setInterval(() => this.tick(), 300); }
  stop() {
    this.active = false; clearInterval(this.timer); $("guideLayer").classList.add("hidden");
    this.app.endGuideScenario();
  }
  step() { return this.steps[this.i]; }
  enter() {
    const s = this.step();
    this.doneAt = null;
    $("guidePhrase").classList.add("hidden");
    try { if (s.setup) s.setup(this.ctx()); } catch (e) { console.error(e); }
    this.app.setSpeed(s.done ? (s.speed || 1) : 0);
    this.render();
  }
  render() {
    const s = this.step(), L = this.lang;
    $("guideStep").textContent = `${this.i + 1} / ${this.steps.length}`;
    $("guideTitle").textContent = s.title[L] || s.title.en;
    let txt = "";
    try { txt = (s.text[L] || s.text.en)(this.ctx()); } catch { txt = ""; }
    const done = this.doneAt != null;
    $("guideText").innerHTML = escape(txt) + (s.done ? `<div class="${done ? "done" : "muted small"}">${done ? (L === "et" ? "✓ Tehtud — vajuta Next" : "✓ Done — press Next") : (L === "et" ? "Ootan, kuni teed selle sammu…" : "Waiting for you to do this step…")}</div>` : "");
    $("guideShow").disabled = !s.phrase;
    $("guideBack").disabled = this.i === 0;
    $("guideNext").textContent = this.i === this.steps.length - 1 ? (L === "et" ? "Lõpeta" : "Finish") : "Next";
    this.place();
  }
  place() {
    if (!this.active) return;
    const s = this.step(), hole = $("guideHole"), card = $("guideCard");
    const el = s.target && document.querySelector(s.target);
    const vw = window.innerWidth, vh = window.innerHeight;
    if (el) {
      const r = el.getBoundingClientRect();
      Object.assign(hole.style, { display: "block", left: r.left - 4 + "px", top: r.top - 4 + "px", width: r.width + 8 + "px", height: r.height + 8 + "px" });
      let x = r.right + 14, y = r.top;
      if (x + 390 > vw) x = Math.max(10, r.left - 394);
      if (x < 10) { x = Math.min(vw - 390, Math.max(10, r.left)); y = r.bottom + 12; }
      y = Math.min(Math.max(10, y), vh - card.offsetHeight - 10);
      Object.assign(card.style, { left: x + "px", top: y + "px" });
    } else {
      hole.style.display = "none";
      Object.assign(card.style, { left: (vw - 380) / 2 + "px", top: vh / 3 + "px" });
    }
  }
  tick() {
    if (!this.active) return;
    const s = this.step();
    if (s.done && this.doneAt == null) {
      let ok = false;
      try { ok = s.done(this.ctx()); } catch { ok = false; }
      if (ok) { this.doneAt = Date.now(); this.app.setSpeed(0); this.render(); }
    }
    this.render();
  }
  isDone() { return this.doneAt != null; }
  next(skip = false) {
    if (this.i >= this.steps.length - 1) { this.stop(); this.app.openDebrief(); return; }
    this.i++; this.enter();
  }
  back() { if (this.i > 0) { this.i--; this.enter(); } }
  show() {
    const s = this.step();
    if (!s.phrase) return;
    let p = "";
    try { p = s.phrase(this.ctx()); } catch { p = ""; }
    if (!p) return;
    $("guidePhrase").textContent = p; $("guidePhrase").classList.remove("hidden"); this.place();
  }
}
const escape = (s) => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
