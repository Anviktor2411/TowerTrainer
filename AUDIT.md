# TowerTrainer realism audit

Status of every item in the realism/XRadio plan, with evidence (file + function). Taken before the work started
(commit `8c88188`); the "after" column is filled in as each phase lands.

Legend: **DONE** works as asked · **PARTLY** exists but incomplete · **MISSING** nothing usable.

## Phase A – known broken / missing

| Item | Before | Evidence | After |
|---|---|---|---|
| A1 NORDO stuck after landing, light signals, follow-me | **PARTLY** | `sim.js respond()` returns `null` for `a.nordo` except `ident`; NORDO arrivals still *transmit* "request taxi" in `update()` (`state === "vacated"`); no `light …` instructions in `commands.js parseInstructions()`; no follow-me vehicle; help/guide silent on RCF | **DONE** — `commands.js parseInstructions()` has `light` (green/red steady/flashing, white) and `followMe`; `sim.js aiDecide()` uses the light gun for NORDO; `respond()` applies lights to `a.nordo`; follow-me vehicle (`vehicleOf("followme")`); guide step `rcf` |
| A2 silhouettes + radar symbology by zoom | **DONE** (verify) | `render.js drawSilhouette()` uses `data.js AC_DIM` (span/length per type), `useSilhouette()` switches at 7 px length; `drawRadarSymbol()` has 6 history dots (`recordHistory`), 1-min vector, draggable leader (`labelOff`, `labelBoxes`) | **DONE** — `render.js drawSilhouette()`/`useSilhouette()`, `drawRadarSymbol()` with history dots, vector and draggable leader; `layoutLabels()` resolves overlaps (offsets ×1.6/×2.3, callsign-only) |
| A3 apron taxilanes, lead-in lines, stand links, routing | **PARTLY** | `aptdat.py parse()` keeps all 1202 edges but only line types {1,2,51,52} (`CENTERLINE_TYPES`), no 7/57 lead-ins, no 1206 roads; `airport.js routeToPos()` ends at the nearest node ≤ 400 m then a straight line to the stand (`sim.js apply("taxiStand")`); no generated stand links; `commands.js viaList()` only accepts `^[a-z]{1,2}\d{0,2}$` names; no reachability test | **DONE** — `aptdat.py` keeps lead-ins (7/57) and 1206 roads; `airport.js` links stands to nodes (`stand.node`) and `routeToPos()` ends on the stand node; `commands.js viaList()` takes any taxiway name; `tests/taxi.test.mjs` (28) checks reachability |
| A4 Delivery view with SID / climb / next squawk | **PARTLY** | `render.js VIEWS` = GND/TWR/APP/CTR only; `main.js renderDel()` shows the clearance list + FP editor; `sim.js suggestDeparture()` has a `this.suggest` hook that `main.js` never sets; `procs.js suggestSid()` exists but is not imported anywhere; `/api/procedures` never fetched | **DONE** — `render.js VIEWS` has Delivery; `main.js renderDel()` lists requests with SID / climb / next squawk and *Read clearance*; `sim.suggest` is set from `procs.js suggestSid()` (CIFP / EuroScope; S2: the OFP's SID wins) |
| A5 plain-language labels, full data block, no overlap, hover, info panel | **PARTLY** | `render.js drawLabel()` prints `STATE_SHORT` codes (CLRD, PUSH REQ…); no squawk/mode line; no overlap resolution; `bindMouse()` only selects on click; no tooltip, no info panel, no "next expected call" | **DONE** — plain-language labels (`labels.js`), full data block with squawk/mode line, overlap solver, hover tooltip, `renderInfo()` info panel with *next expected call* |
| A6 voice banner re-check, show speaking engine | **MISSING** | `radio.js checkServer()` exists but is never called (grep `checkServer` in `main.js` → none) so `useServer()` is always false and neural TTS is never used; no banner element in `index.html` | **DONE** — `radio.js checkServer()` is called at start and every minute; the voice banner (`#voiceBanner`, “Neural voices ready: edge …”) names the engine; `renderVoicePill()` shows who speaks |

## Phase B – sound

| Item | Before | Evidence | After |
|---|---|---|---|
| B1 VHF AM radio chain, presets, radio lab, DSP test | **PARTLY** | `radio.js playVoice()`: 1st-order band-pass 300–3400 (`bandpass()`), compressor, tanh shaper, distance fade/LFO, static bed, **dry path mixed in** (`dry.gain = 0.65 - e`), cockpit bed parallel not under the limiter, no downsample/bit-crush, no AGC pumping, no dropouts, tail = 140 ms burst; default effect 0.6 (`main.js DEFAULTS`); no presets, no lab, no OfflineAudioContext test | **DONE** — `radio.js playVoice()` chain: band-pass → AGC → compressor → shaper → downsample/bit-crush → dropouts, cockpit bed under the limiter, no dry path; presets (`PRESET_EFFECT`), the radio lab (Settings) and an `OfflineAudioContext` self-test |
| B2 neural voices default, distinct per crew, accents, human touches, latency | **PARTLY** | `tts.py TTSManager.cast()` (order azure→edge→piper→kokoro→elevenlabs, exclude list, seed-stable, ~9 % female in `radio.js castServer()`); `prerender()` runs during the reaction delay; `humanize()` adds "uh"; busy → faster (`prepare()`); **but** the server path is never enabled (A6); controller `role` ignored by `cast()`; no breath/self-corrections; no next-call pre-render | **DONE** — neural voices by default when the server has an engine (`tts.py TTSManager.cast()` with `role`), distinct per crew member, accents by nationality, breaths/self-corrections (`humanize()`), next-call pre-render; `tests/tts_test.py` |
| B3 per-position audio, monitor volume, blocked, stuck mic, guard | **PARTLY** | `radio.js` single `busy` queue (`next()`), `audible` set per position; `block()` plays only a heterodyne + retries; no garbled dual audio, no "say again", no stuck mic, no 121.500 | **DONE** — per-position audio with monitor volume, blocked transmissions garbled (`radio.js block()`), stuck microphone (`stuckMic`), 121.500 guard (`GUARD` in `sim.js`/`radio.js`) |
| B4 ATIS text + voice loop, letter changes, pilots report it | **PARTLY** | `sim.js rollAtis()` every 30 min / runway change; `main.js renderAtis()` shows letter + raw METAR; pilots report an old letter (`rates.oldAtis`); no generated ATIS text, no voice, no ATIS frequency button | **DONE** — `atis.js` generates the ATIS text (`parseMetar`), voice loop (`atisVoice`, server TTS), letter changes on weather/runway change, pilots report the letter; ATIS button + frequency |

## Phase C – the airport feels alive

| Item | Before | Evidence | After |
|---|---|---|---|
| C1 parked aircraft, occupancy slider, turnaround visuals | **PARTLY** | `sim.js spawnDeparture()` creates the aircraft on a free stand only when it is due; arrivals vanish 45 s after parking (`update()` arr branch); no slider, no jet bridge/tug/vehicles | **DONE** — parked aircraft from the occupancy slider (`settings.occupancy` → `sim.js` dormant stands), turnaround visuals (jet bridge, tug, service vehicles) in `render.js` |
| C2 service vehicles on 1206 roads | **MISSING** | `aptdat.py` skips 1206 (`elif c in ("1206",): last_edge = None`) | **DONE** — `aptdat.py` keeps 1206 roads; `sim.js` service vehicles (`serviceVehicles`, `a.veh`: follow-me, tug, fire, inspection) with their own calls (D6) |
| C3 OSM buildings, markings, shading, night lights, compass/scale, zoom labels | **PARTLY** | `render.js draw()` pavement/runways/lines/hold lines only; taxiway labels at k>0.12, stand names at k>0.45; no OSM, no compass rose/scale bar, no lights | **DONE** — `osm.py` buildings (cached, credited), markings, shading, night lights, compass rose + scale bar, zoom-dependent labels in `render.js drawStatic()` (cached offscreen) |
| C4 OpenFlights traffic mix, types per airline, peaks, cargo, GA | **MISSING** | `data.js AIRLINES/DESTS/TYPES` static; `sim.js makeFlight()` random airline, type by stand types, dest by distance | **DONE** — `openflights.py` traffic mix (`trafficMix` in `main.js`, `sim.setTrafficMix()`): airlines, types per airline, destinations, peaks, cargo and GA |
| C5 day/night + weather on the map | **MISSING** | `render.js C` fixed palette; no clock/weather input | **DONE** — `daylight.js` day/night by clock, weather on the map (`render.js` palette and precipitation), `updateSky()` |

## Phase D – operations

| Item | Before | Evidence | After |
|---|---|---|---|
| D1 changing weather, runway change procedure, gust/limits | **MISSING** | `main.js loadAirport()` reads METAR once; `sim.wind` set once; `setRunway()` only rolls ATIS | **DONE** — `ops.js WX_SCENARIOS` + `sim.setWxScenario()`: changing weather, runway change procedure (`rwyChanged` re-clearance), gust/limit warnings; METAR polling (`pollMetar()`) |
| D2 LVP, CAT II/III points, stop bars, night, de-icing | **MISSING** | RVR only shown in `renderAtis()`; `HOLD_TYPES` keeps ILS hold lines (6/56) but nothing uses them | **DONE** — LVP (`sim.lvp`: spacing, CAT II/III holding points), stop bars (`stopBarAt`, `ops.js`), night ops, de-icing (`deiceNeeded`) |
| D3 conditional / expect / report / give way / follow / immediate / cancel / continue / land after | **PARTLY** | `commands.js parseInstructions()` has taxi/via/holdShort/cross/hold/continue/lineup/takeoff/land/goaround/contact/squawk/atis/approach/alt only | **DONE** — `commands.js parseInstructions()`: conditional, expect, report, give way, follow, immediate, cancel, continue, land after; coach references per instruction |
| D4 departure sequence, CTOT/A-CDM, wake timers, spacing, missed approach from navdata | **PARTLY** | arrival gap Δ nm in `render.js drawLabel()`; 2-min heavy check in `sim.js startRoll()`; `goAround()` climbs straight ahead; no sequence list, no slots | **DONE** — `flow.js`: departure sequence (`departureSequence`), CTOT/A-CDM (`ctotStatus`, `acdmTimes`), wake timers (`wakeDepSeconds`), arrival spacing, missed approach from navdata |
| D5 VFR circuits, reporting points, SVFR, helicopters, 7000/1200 | **PARTLY** | GA departs VFR (`makeGA()`), GA arrival straight-in (`gaFinal`); squawk 7000/1200 (`spawnDeparture()`); no circuits/joins/points/SVFR/helis | **DONE** — `vfr.js`: circuits, reporting points (`defaultVfrPoints`), joins, SVFR, helicopters, 7000/1200 |
| D6 ground vehicles with their own calls | **MISSING** | no vehicle kind in `sim.js` | **DONE** — ground vehicles (`a.veh`) with their own calls: runway inspection, fire service, tow (`aiDecide()` vehicle branch) |
| D7 abnormals toggle + slider | **PARTLY** | `sim.js scriptedEvent()` 7600/7700 only (engine failure mayday); no medical/bird/RTO/breakdown/FOD/incursion/unstable/PAN/7500 | **DONE** — `events.js`: abnormals toggle + rate (`settings.abnormals`, `abnormalRate`): medical, bird strike, RTO, breakdown, FOD, incursion, unstable approach, PAN, 7500, 7600, 7700 |

## Phase E – XRadio

| Item | Before | Evidence | After |
|---|---|---|---|
| E1 XRadio v0.6.0: LF_ATC, protocol v6, PT_AI_TRAFFIC, PT_FLIGHTPLAN, ATC overlay, ATIS, tests, docs | **MISSING** | `xradio/plugin/src/protocol.h` `kProtoVersion = 5`, `LF_WEATHER_SOURCE` only; `main.cpp drawWindow()` lists every session as traffic; no flight-plan or ATC packets | **DONE** — XRadio v0.6.0 (`xradio-main`, branch `atc-support`): protocol v6 (`kProtoVersion = 6`), `LF_ATC`, `PT_AI_TRAFFIC` injector, `PT_FLIGHTPLAN`, `PT_ATC_LIST`, `PT_ATIS`, ATC overlay, tests (`tools/harness`, `tools/test_server.py`, parity), docs and release notes |
| E2 TowerTrainer bridge: v6, one injector, humans everywhere, voice both ways, STT, weather, guard, panel, tests | **PARTLY** | `xradio_bridge.py` v5 vendored, one UDP session per AI aircraft (`MAX_AI_SESSIONS = 40`), humans → `sim.upsertHuman()` (counted by `runwayOccupants`/`checkConflicts`); `bridges.js startVoice()` decodes Opus but plays **raw**, not through the radio chain; PTT out as Opus (`keyMic`); AI speech text-only; no STT, no PT_WEATHER use, no guard, no private text, status pill only; `tests/xradio_test.py` against v0.5.7 only | **DONE** — `xradio_bridge.py` v6 with one injector session, humans everywhere (`sim.upsertHuman()`), voice both ways through the radio chain, STT transcripts (`transcribe`), PT_WEATHER publish/follow, guard, private text, status panel; `tests/xradio_test.py` against v0.5.7 and v0.6.0 |

## Phase F – controller workflow & multiplayer

| Item | Before | Evidence | After |
|---|---|---|---|
| F1 electronic strips: bays, drag, edit, flash, transfer with accept | **PARTLY** | `strips.js BAYS/POS_BAYS`, drag (`wire()`), contenteditable fields, `.calling` flash; no transfer/accept, no handoff flash | **DONE** — `strips.js`: bays, drag, edit, calling flash, transfer with accept (`sim.acceptHandoff()`, `transferStrip`), handoff flash |
| F2 autocomplete, shortcuts, click-to-instruct | **MISSING** | `main.js` plain `<input id="cmd">`; only Ctrl+Space PTT | **DONE** — `autocomplete.js` (callsigns, instructions, taxiways), keyboard shortcuts, click-to-instruct on targets, strips and taxiways |
| F3 multi-monitor windows, placement API, presets | **PARTLY** | `main.js popOut()` per position via BroadcastChannel (`bootPopout`); no view-only windows, no Window Management API, no presets | **DONE** — `main.js popOut()` per position and per panel (`?popout=POS&panel=radar|strips|log|del|wx|seq|chat`), Window Management API (`screensInfo()`, `getScreenDetails`), layout presets (`LAYOUT_PRESETS`, `applyLayout`) |
| F4 multiplayer (host/join, lobby, claims, handoffs, coordination, intercom, chat, instructor, kick) | **MISSING** | `server.py` has no WebSocket; sim is single-browser | **DONE** — `ws.py` relay (RFC 6455, stdlib) + `remote.js`: host/join with codes, lobby, claims, handoffs, coordination, WebRTC intercom, chat, instructor and spectator roles, kick/ban; `tests/ws_test.py`, browser multiplayer checks |
| F5 Firefox speech via local recognition | **PARTLY** | `stt.py`/`/api/stt` + `recorder.js PttRecorder` exist; `main.js pttStart()` only uses `SpeechRecognition` and logs "needs Chrome or Edge" | **DONE** — `speech.js Ptt`: browser SpeechRecognition or the local `/api/stt` (Firefox); `tests/firefox.mjs` over WebDriver BiDi |
| F6 phone/tablet strip board over LAN | **MISSING** | `server.py` binds 127.0.0.1 only; no board page | **DONE** — `server.py --host 0.0.0.0` + the board role (`?join=CODE` as board/spectator) for a phone or tablet over LAN |

## Phase G – learning, content, packaging

| Item | Before | Evidence | After |
|---|---|---|---|
| G1 career path, scenarios + editor, recording/replay, log export, statistics | **MISSING** | only `guide.js` (one tutorial) and `main.js openDebrief()` | **DONE** — `career.js`: career path with levels, built-in scenarios + editor/import/export, `replay.js` recorder/replay, log export (`logsAsText`), statistics (`history`, `overallScore`, `sparkline`) |
| G2 coach: per-instruction refs, timing hints, separation hints | **PARTLY** | `coach.js coach()` refs ICAO/CAP 413/FAA; `coachHints()` handoff hints only | **DONE** — `coach.js`: per-instruction references, `timingHints()` (ready waiting, late landing clearance, wake, spacing, busy runway), separation hints, EN + ET |
| G3 CIFP/Navigraph procedures on the map, AIRAC display, charts | **PARTLY** | `navdata.py` + `procs.js procLines()` + `render.js setProcs()` exist but `main.js` never fetches `/api/procedures`; no AIRAC pill, no charts button | **DONE** — `/api/procedures` fetched (`applyProcs()`), CIFP / Navigraph / EuroScope SIDs and STARs on the map (`procs.js procLines()`), AIRAC pill, Charts dialog |
| G4 optional 3D tower view | **MISSING** | — | **DONE** — `tower3d.js TowerView` (perspective from the tower, OSM buildings, aircraft silhouettes, HUD compass) as the *Tower 3D* view |
| G5 start scripts, PyInstaller, CI, README badge/screenshots/licence/credits | **MISSING** | no `start.bat`, no `.github/`, README without badge/licence | **DONE** — `start.bat` / `start.sh`, `TowerTrainer.spec` (PyInstaller), `.github/workflows/tests.yml`, README badge, screenshots (`tests/shots.mjs` → `docs/screenshots`), `LICENSE` (MIT + data notes), credits |

## Phase G6 – setup wizard

| Item | Before | Evidence | After |
|---|---|---|---|
| G6 setup wizard / installer: Python + packages, EuroScope sector generation, XRadio plugin install | **MISSING** | no `/setup` page | **DONE** — `web/setup.html` + `setup.js` + `setup.py` (`/setup`, `/api/setup/*`): checks, package install, `sector.py` writes EuroScope `.sct/.ese/.asr/.prf`, finds X-Plane, installs XRadio from the latest release zip, writes `xradio.cfg` (incl. the SimBrief username, S5); `installer/TowerTrainer-Setup.ps1`; `tests/setup_test.py`, `tests/sector_test.py` |

## Phase H – X-Plane tower mode (XRadio plugin)

| Item | Before | Evidence | After |
|---|---|---|---|
| H1 tower link: TowerTrainer ↔ plugin over TCP JSON lines | **MISSING** | no `towerlink.py` | **DONE** — `towerlink.py` (`--tower-port`, default 8781) joins the plugin to the multiplayer relay as a guest with session code TOWER; `plugin/src/tcp.cpp`, `tower.cpp Link`; `tests/towerlink_test.py` |
| H2 camera in the tower cab | **MISSING** | — | **DONE** — `tower.cpp` finds the `apt.dat` tower viewpoint (row 14, custom scenery first) or the OSM tower from the airport line; `XPLMControlCamera`, look-around and zoom commands |
| H3 the pilot's aircraft parked and restored | **MISSING** | — | **DONE** — `override_planepath` park/restore with the exact position on leaving; `tools/harness/tower_test.cpp` |
| H4 the trainer's traffic in the sim | **MISSING** | — | **DONE** — the relay's state lines become CSL aircraft (`xr::csl::upsert`, sid base `0x7E000000`), vehicles included |
| H5 tower windows: strips, radio, clearance, weather, sequence | **MISSING** | — | **DONE** — five windows in `tower.cpp` (text UI), claims and handoffs, PTT/typed transmissions relayed back (`tx` lines), ops (LVP, stop bars) |
| H6 settings and keys | **MISSING** | — | **DONE** — Settings tab *Tower* (`towerHost`, `towerPort`, `towerKey`), 11 `xradio/tower/*` commands, menu items |
| H7 weather from the trainer | **MISSING** | — | **DONE** — METAR line parsed into X-Plane's weather (`tower.cpp` METAR parse incl. “1 1/2SM”) |
| H8 tests and docs | **MISSING** | — | **DONE** — `tools/fake_towertrainer.py`, `tools/check_tower.sh` (42 checks), CI step, `docs/tower-mode.md`, README *Control from the tower*, release notes |

## Phase S – SimBrief

| Item | Before | Evidence | After |
|---|---|---|---|
| S1 OFP parser + viewer | **MISSING** | — | **DONE** — `simbrief.py` (official `xml.fetcher.php?json=1`, HTTP 400 explained, cache in `cache/simbrief/`, apiv1 signed form flow when a key is given), `/api/simbrief/latest|import|plan`, `web/js/simbrief.js` OFP panel with route on the map and weather at both ends, *Open full OFP*; `tests/simbrief_test.py`, fixture `tests/fixtures/simbrief_ofp.json` |
| S2 the pilot's flight as traffic, clearance vs plan, EuroScope $FP | **MISSING** | — | **DONE** — `sim.spawnFromPlan()` (exact OFP data, fitting stand, OFP SID via `sim.suggest`, RFL, EOBT as TOBT), strips show the OFP badge, `coach.js` checks destination / SID / level against the plan, `fsd.py _fp_line()` carries equipment, RFL, alternate, `/V/ SIMBRIEF`; `tests/ops.test.mjs` S2 block |
| S3 pilot side in XRadio: import, file, .fms, clearance vs plan | **MISSING** | — | **DONE** — `plugin/src/simbrief.cpp` (fetch on a worker through the plugin's HTTP client, parser, `.fms` writer that never overwrites without a second press), Flight plan tab import → editable → *File* as `PT_FLIGHTPLAN`, OFP numbers, clearance next to the plan with differences; TowerTrainer puts the filed plan on the strip and in `$FP`; `tools/check_simbrief.sh`, `ui_logic_test` |
| S4 AI ATC for the pilot's own flight | **MISSING** | — | **DONE** — `web/js/pilotatc.js`: Delivery/Ground/Tower/Radar/Control for XRadio pilots on unstaffed positions, readback checks, taxi watched against the real position, takeoff/landing against traffic, handoffs, debrief with score, silent where a human staffs; AI controllers voiced through the bridge; the plan stays open when the departure leaves the airspace, Tower clears to land only after the check-in, a bare microphone call waits 4 s for its transcript, the XRadio station overrides stay with the airport they were typed at; `tests/ops.test.mjs` S4 blocks |
| S5 polish: wizard step, guide EN+ET, screenshots, end-to-end test | **MISSING** | — | **DONE** — XRadio wizard step 5 (SimBrief, optional) and the setup wizard's SimBrief field; guide steps *simbrief* / *aiatc* (EN + ET); `docs/screenshots/EETN-ofp.png`, `EETN-debrief.png`; `tests/aiatc.test.mjs` flies a scripted XRadio pilot (`fake_client.py --script`) from a stand at EETN to a stand at EVRA through XRadio's own server, the page loading Riga mid-flight (34 checks) |

## Phase U – the XRadio window

| Item | Before | Evidence | After |
|---|---|---|---|
| U Dear ImGui window: tabs, overlay, toasts, themes, wizard, VR/pop-out, i18n | **MISSING** | text UI only (`ui.cpp`) | **DONE** — `plugin/src/ui2/` (model/actions, `app_ui.cpp` tabs Radio / ATC / Pilots / Messages / Flight plan / Host / Settings / Tower, cockpit overlay, toasts, dark + light themes with drawn icons, five-step wizard, EN + ET), `imgui_xp.cpp` host (shared Inter atlas via `XPLMBindTexture2d`, pop-out, VR, HiDPI), text UI kept as `-DXRADIO_UI_IMGUI=OFF`; `tools/harness/ui_logic_test.cpp`, `tools/ui_preview` → `docs/ui/*.png`, `docs/ui.md`, release notes; the Windows plugin links with XPMP2 + voice + ImGui; fonts embedded as uint32 arrays (MSVC refuses string literals over 64 KB), every source compiles for Linux and macOS with clang, CI installs the Linux GL headers |

## Test baseline (after)

| Suite | Result |
|---|---|
| `node tests/unit.test.mjs` / `taxi` / `ops` | 221 / 28 / 264 pass |
| `node tests/flow.test.mjs EETN` | pass |
| `python tests/ws_test.py` / `fsd` / `data` / `navdata` / `stt` / `tts` / `sector` / `setup` / `towerlink` / `simbrief` | all pass |
| `node tests/browser.test.mjs` (Chrome; `TT_BROWSER=edge` for Edge) | 84 pass in Chrome and in Edge, no console errors (the multiplayer handoff step runs without random readback errors: a wrong frequency read back used to fail it about one run in twenty-five) |
| `node tests/firefox.mjs` | pass, no console errors |
| `node tests/perf.mjs` | 60 fps with 150+ targets, no JS errors |
| `python tests/xradio_test.py` (XRadio v0.5.7 and v0.6.0) | pass |
| `node tests/aiatc.test.mjs` | 34 pass (stand at EETN to stand at EVRA under the AI controllers, through XRadio's own server) |
| XRadio: `tools/harness/*`, `check_tower.sh`, `check_simbrief.sh`, `ui_logic_test`, `check_windows_build.sh`, parity | pass; the Windows plugin links; every source compiles for Linux and macOS with clang (Zig 0.13) |

## Test baseline (before)

| Suite | Result |
|---|---|
| `node tests/unit.test.mjs` | 162/162 pass (Node 22 portable; Node is not installed on this PC) |
| `node tests/flow.test.mjs EETN` / `KORD` | pass |
| `python tests/fsd_test.py` | pass |
| `python tests/navdata_test.py` | **fails**: fixture `tests/fixtures/xplane/Custom Data/` was never committed (`.gitignore` has `Custom Data/`) |
| `python tests/tts_test.py` | logic passes; crashes printing "→" on a cp1252 console (`UnicodeEncodeError`) |
| `python tests/stt_test.py` | pass (faster-whisper installed) |
| `python tests/xradio_test.py` | skipped (no XRadio checkout) |
