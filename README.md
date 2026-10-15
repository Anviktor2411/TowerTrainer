# Tower Trainer

Offline practice for VATSIM Delivery / Ground / Tower / Approach / Centre at (almost) any airport in the world.
Airport layouts come from the X-Plane Scenery Gateway (cached in `cache/`), the runway from the live METAR.

## Run

```
python server.py                       # http://localhost:8780  (?icao=EGLL), EuroScope/FSD on 127.0.0.1:6809
python server.py --fsd-port 0          # without the EuroScope bridge
python server.py --xradio 1.2.3.4:49100 --xradio-password word --xradio-callsign EETN_TWR
```

Python 3 (stdlib only) and Chrome or **Edge** (best "Natural" voices; push-to-talk uses the browser's speech recognition).

## What's in it

- **Positions**: Delivery, Ground, Tower, Approach, Centre with their own frequency (from apt.dat), login callsign
  (`EETN_TWR`, `EE_CTR`), strip board and frequency log. *Staffing*: work any combination; the rest are AI
  controllers with correct phraseology (grey). *Combined* keeps everything on one frequency.
  Pilots stay on a frequency until handed off ("contact Ground 131.905"); a wrong frequency sends them away
  until they come back with "no reply on …".
- **Pop-out windows** (⧉ on a position tab) for multi-monitor towers; BroadcastChannel, one sim in the main window.
- **Phraseology** by region (K…/C… = FAA, EG/EI = CAP 413, else ICAO): callsign-last readbacks (US mix),
  niner/tree/fife/tousand for strict crews, grouped flight numbers for native speakers, decimal vs point,
  spoken aircraft types, GA registrations abbreviated after ATC abbreviates, greetings by local time.
- **Pilot errors to catch**: readback errors (wrong squawk is really set), "say again", old ATIS letter,
  "confirm cleared for takeoff?" with traffic on the runway, missed-readback alert after 30 s.
- **Accents**: crews get a nationality from the airline/registration; non-native pilots speak English through their
  own language's voice with aviation words respelled (Estonian, Finnish, Latvian, Lithuanian, German tables).
  Settings → Accents Off / Natural / Strong, voice table shows what is installed.
- **Radio**: squelch click and tail, band-passed static + crackle during speech (louder far away), random reply
  delays, blocked transmissions with a heterodyne squeal.
- **Squawks**: local code blocks (data.js), never reserved/in-use codes, 10-min reuse delay, "Assign squawk";
  label warnings for wrong code / no mode C / duplicates; optional scripted 7600/7700 events.
- **Guide** (interactive tutorial, English/Estonian), **Coach** mode with ICAO/CAP 413/FAA references, **Debrief**.

## EuroScope

EuroScope → Connect → Connect type **Direct to VATSIM**, untick **Connect to VATSIM**, server `127.0.0.1`,
any callsign (e.g. `EETN_TWR`) and password, load a sector file, prime the tower frequency. Text on your
frequency (or private to a pilot) is handled exactly like typing in the trainer.

## XRadio (optional, off by default)

Settings → XRadio: server, port, password, ATC callsign/frequency, and toggles for AI traffic into X-Plane,
real pilots on the radar, text, voice both ways (WebCodecs Opus in the browser; AI pilots' speech is rendered
on the server and encoded with PyAV or opuslib when one is installed, text otherwise), weather from or to the
flight, ATIS on its own frequency and optional transcripts of the pilots (Vosk/Whisper, never acting on their
own). `xradio/protocol.py` is vendored from XRadio v0.6.0 (MIT, protocol 6); a v0.5.7 server still works with
the older feature set. The status pill shows `XR: v6 · 3 pilots · 12 AI`; the XRadio settings have a short
"how to fly with TowerTrainer ATC" text for the pilots.

## Several controllers, several screens

* **Windows** – any position, or a single panel of it (radar, strips, log, Delivery list, weather, sequence,
  chat), opens in its own window from the position tab's ⧉ or **Layout** (Alt+L). Presets put the windows on
  your monitors (Chrome/Edge ask once for the window-management permission; Firefox reopens them where you
  left them); every window has a ⛶ full-screen button. Audio only ever plays in the main window.
* **Multiplayer** – **Multiplayer** (Alt+M) → *Host a session*: you get a six-letter code and a link.
  Others on your network open the link (start the server with `python server.py --host 0.0.0.0`) and join
  as a controller, spectator or instructor with just a nickname. A controller claims a position by clicking
  its tab; the host's tab shows who works it, and a position whose controller drops goes back to the AI after
  30 s. Handoffs between positions must be accepted (the incoming strip flashes with ACCEPT), coordination
  requests (release / crossing / approval / point-out) go to whoever works the other position (an AI position
  answers in a few seconds), there is a text chat, private notes from the instructor, kick/ban, and an
  intercom (hold Alt+Shift or 🎧) over WebRTC between the controllers. Everything travels over one WebSocket
  relay in `server.py` (`ws.py`, stdlib only).
* **Strip board on a phone or tablet** – `http://<host>:8780/?join=CODE&role=board&pos=TWR`: big strips,
  tap a strip to move it between bays, tap ACCEPT for incoming ones.
* **Command line** – suggestions as you type (callsigns on your frequency, then the next instruction for that
  aircraft); Tab accepts, / focuses the line, Alt+1…5 switch views, Alt+Q/W/E/R/T positions. Clicking a
  taxiway on the map appends it to the taxi instruction you are typing. Push-to-talk works in Firefox too:
  the server's Vosk or Whisper recognises what you said, biased with the callsigns in use.

## Tests

```
node tests/unit.test.mjs                      # phraseology, voices, squawks, readback errors, positions, AI, coach
node tests/flow.test.mjs EGLL [RWY|-|-0] [SEED]   # full departure + arrival at a cached airport
python tests/fsd_test.py                      # EuroScope / FSD protocol
set XRADIO_DIR=...\xradio-0.5.7 && python tests/xradio_test.py   # against XRadio's own server + fake client
node tests/browser.test.mjs                   # real page in headless Chrome incl. pop-outs, a multiplayer session and the whole guide
node tests/ops.test.mjs                       # operations, weather, handoffs, autocomplete
python tests/ws_test.py                       # the multiplayer relay (WebSocket framing, roles, claims, kick/ban)
node tests/firefox.mjs                        # the same page in headless Firefox over WebDriver BiDi (TT_BROWSER=edge runs browser.test in Edge)
```
