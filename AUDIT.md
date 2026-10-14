# TowerTrainer realism audit

Status of every item in the realism/XRadio plan, with evidence (file + function). Taken before the work started
(commit `8c88188`); the "after" column is filled in as each phase lands.

Legend: **DONE** works as asked · **PARTLY** exists but incomplete · **MISSING** nothing usable.

## Phase A – known broken / missing

| Item | Before | Evidence | After |
|---|---|---|---|
| A1 NORDO stuck after landing, light signals, follow-me | **PARTLY** | `sim.js respond()` returns `null` for `a.nordo` except `ident`; NORDO arrivals still *transmit* "request taxi" in `update()` (`state === "vacated"`); no `light …` instructions in `commands.js parseInstructions()`; no follow-me vehicle; help/guide silent on RCF | |
| A2 silhouettes + radar symbology by zoom | **DONE** (verify) | `render.js drawSilhouette()` uses `data.js AC_DIM` (span/length per type), `useSilhouette()` switches at 7 px length; `drawRadarSymbol()` has 6 history dots (`recordHistory`), 1-min vector, draggable leader (`labelOff`, `labelBoxes`) | |
| A3 apron taxilanes, lead-in lines, stand links, routing | **PARTLY** | `aptdat.py parse()` keeps all 1202 edges but only line types {1,2,51,52} (`CENTERLINE_TYPES`), no 7/57 lead-ins, no 1206 roads; `airport.js routeToPos()` ends at the nearest node ≤ 400 m then a straight line to the stand (`sim.js apply("taxiStand")`); no generated stand links; `commands.js viaList()` only accepts `^[a-z]{1,2}\d{0,2}$` names; no reachability test | |
| A4 Delivery view with SID / climb / next squawk | **PARTLY** | `render.js VIEWS` = GND/TWR/APP/CTR only; `main.js renderDel()` shows the clearance list + FP editor; `sim.js suggestDeparture()` has a `this.suggest` hook that `main.js` never sets; `procs.js suggestSid()` exists but is not imported anywhere; `/api/procedures` never fetched | |
| A5 plain-language labels, full data block, no overlap, hover, info panel | **PARTLY** | `render.js drawLabel()` prints `STATE_SHORT` codes (CLRD, PUSH REQ…); no squawk/mode line; no overlap resolution; `bindMouse()` only selects on click; no tooltip, no info panel, no "next expected call" | |
| A6 voice banner re-check, show speaking engine | **MISSING** | `radio.js checkServer()` exists but is never called (grep `checkServer` in `main.js` → none) so `useServer()` is always false and neural TTS is never used; no banner element in `index.html` | |

## Phase B – sound

| Item | Before | Evidence | After |
|---|---|---|---|
| B1 VHF AM radio chain, presets, radio lab, DSP test | **PARTLY** | `radio.js playVoice()`: 1st-order band-pass 300–3400 (`bandpass()`), compressor, tanh shaper, distance fade/LFO, static bed, **dry path mixed in** (`dry.gain = 0.65 - e`), cockpit bed parallel not under the limiter, no downsample/bit-crush, no AGC pumping, no dropouts, tail = 140 ms burst; default effect 0.6 (`main.js DEFAULTS`); no presets, no lab, no OfflineAudioContext test | |
| B2 neural voices default, distinct per crew, accents, human touches, latency | **PARTLY** | `tts.py TTSManager.cast()` (order azure→edge→piper→kokoro→elevenlabs, exclude list, seed-stable, ~9 % female in `radio.js castServer()`); `prerender()` runs during the reaction delay; `humanize()` adds "uh"; busy → faster (`prepare()`); **but** the server path is never enabled (A6); controller `role` ignored by `cast()`; no breath/self-corrections; no next-call pre-render | |
| B3 per-position audio, monitor volume, blocked, stuck mic, guard | **PARTLY** | `radio.js` single `busy` queue (`next()`), `audible` set per position; `block()` plays only a heterodyne + retries; no garbled dual audio, no "say again", no stuck mic, no 121.500 | |
| B4 ATIS text + voice loop, letter changes, pilots report it | **PARTLY** | `sim.js rollAtis()` every 30 min / runway change; `main.js renderAtis()` shows letter + raw METAR; pilots report an old letter (`rates.oldAtis`); no generated ATIS text, no voice, no ATIS frequency button | |

## Phase C – the airport feels alive

| Item | Before | Evidence | After |
|---|---|---|---|
| C1 parked aircraft, occupancy slider, turnaround visuals | **PARTLY** | `sim.js spawnDeparture()` creates the aircraft on a free stand only when it is due; arrivals vanish 45 s after parking (`update()` arr branch); no slider, no jet bridge/tug/vehicles | |
| C2 service vehicles on 1206 roads | **MISSING** | `aptdat.py` skips 1206 (`elif c in ("1206",): last_edge = None`) | |
| C3 OSM buildings, markings, shading, night lights, compass/scale, zoom labels | **PARTLY** | `render.js draw()` pavement/runways/lines/hold lines only; taxiway labels at k>0.12, stand names at k>0.45; no OSM, no compass rose/scale bar, no lights | |
| C4 OpenFlights traffic mix, types per airline, peaks, cargo, GA | **MISSING** | `data.js AIRLINES/DESTS/TYPES` static; `sim.js makeFlight()` random airline, type by stand types, dest by distance | |
| C5 day/night + weather on the map | **MISSING** | `render.js C` fixed palette; no clock/weather input | |

## Phase D – operations

| Item | Before | Evidence | After |
|---|---|---|---|
| D1 changing weather, runway change procedure, gust/limits | **MISSING** | `main.js loadAirport()` reads METAR once; `sim.wind` set once; `setRunway()` only rolls ATIS | |
| D2 LVP, CAT II/III points, stop bars, night, de-icing | **MISSING** | RVR only shown in `renderAtis()`; `HOLD_TYPES` keeps ILS hold lines (6/56) but nothing uses them | |
| D3 conditional / expect / report / give way / follow / immediate / cancel / continue / land after | **PARTLY** | `commands.js parseInstructions()` has taxi/via/holdShort/cross/hold/continue/lineup/takeoff/land/goaround/contact/squawk/atis/approach/alt only | |
| D4 departure sequence, CTOT/A-CDM, wake timers, spacing, missed approach from navdata | **PARTLY** | arrival gap Δ nm in `render.js drawLabel()`; 2-min heavy check in `sim.js startRoll()`; `goAround()` climbs straight ahead; no sequence list, no slots | |
| D5 VFR circuits, reporting points, SVFR, helicopters, 7000/1200 | **PARTLY** | GA departs VFR (`makeGA()`), GA arrival straight-in (`gaFinal`); squawk 7000/1200 (`spawnDeparture()`); no circuits/joins/points/SVFR/helis | |
| D6 ground vehicles with their own calls | **MISSING** | no vehicle kind in `sim.js` | |
| D7 abnormals toggle + slider | **PARTLY** | `sim.js scriptedEvent()` 7600/7700 only (engine failure mayday); no medical/bird/RTO/breakdown/FOD/incursion/unstable/PAN/7500 | |

## Phase E – XRadio

| Item | Before | Evidence | After |
|---|---|---|---|
| E1 XRadio v0.6.0: LF_ATC, protocol v6, PT_AI_TRAFFIC, PT_FLIGHTPLAN, ATC overlay, ATIS, tests, docs | **MISSING** | `xradio/plugin/src/protocol.h` `kProtoVersion = 5`, `LF_WEATHER_SOURCE` only; `main.cpp drawWindow()` lists every session as traffic; no flight-plan or ATC packets | |
| E2 TowerTrainer bridge: v6, one injector, humans everywhere, voice both ways, STT, weather, guard, panel, tests | **PARTLY** | `xradio_bridge.py` v5 vendored, one UDP session per AI aircraft (`MAX_AI_SESSIONS = 40`), humans → `sim.upsertHuman()` (counted by `runwayOccupants`/`checkConflicts`); `bridges.js startVoice()` decodes Opus but plays **raw**, not through the radio chain; PTT out as Opus (`keyMic`); AI speech text-only; no STT, no PT_WEATHER use, no guard, no private text, status pill only; `tests/xradio_test.py` against v0.5.7 only | |

## Phase F – controller workflow & multiplayer

| Item | Before | Evidence | After |
|---|---|---|---|
| F1 electronic strips: bays, drag, edit, flash, transfer with accept | **PARTLY** | `strips.js BAYS/POS_BAYS`, drag (`wire()`), contenteditable fields, `.calling` flash; no transfer/accept, no handoff flash | |
| F2 autocomplete, shortcuts, click-to-instruct | **MISSING** | `main.js` plain `<input id="cmd">`; only Ctrl+Space PTT | |
| F3 multi-monitor windows, placement API, presets | **PARTLY** | `main.js popOut()` per position via BroadcastChannel (`bootPopout`); no view-only windows, no Window Management API, no presets | |
| F4 multiplayer (host/join, lobby, claims, handoffs, coordination, intercom, chat, instructor, kick) | **MISSING** | `server.py` has no WebSocket; sim is single-browser | |
| F5 Firefox speech via local recognition | **PARTLY** | `stt.py`/`/api/stt` + `recorder.js PttRecorder` exist; `main.js pttStart()` only uses `SpeechRecognition` and logs "needs Chrome or Edge" | |
| F6 phone/tablet strip board over LAN | **MISSING** | `server.py` binds 127.0.0.1 only; no board page | |

## Phase G – learning, content, packaging

| Item | Before | Evidence | After |
|---|---|---|---|
| G1 career path, scenarios + editor, recording/replay, log export, statistics | **MISSING** | only `guide.js` (one tutorial) and `main.js openDebrief()` | |
| G2 coach: per-instruction refs, timing hints, separation hints | **PARTLY** | `coach.js coach()` refs ICAO/CAP 413/FAA; `coachHints()` handoff hints only | |
| G3 CIFP/Navigraph procedures on the map, AIRAC display, charts | **PARTLY** | `navdata.py` + `procs.js procLines()` + `render.js setProcs()` exist but `main.js` never fetches `/api/procedures`; no AIRAC pill, no charts button | |
| G4 optional 3D tower view | **MISSING** | — | |
| G5 start scripts, PyInstaller, CI, README badge/screenshots/licence/credits | **MISSING** | no `start.bat`, no `.github/`, README without badge/licence | |

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
