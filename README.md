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
real pilots on the radar, text, and voice (WebCodecs Opus). `xradio/protocol.py` is vendored from
XRadio v0.5.7 (MIT). AI pilot speech is text-only on XRadio (no server-side TTS/Opus encoder installed).

## Tests

```
node tests/unit.test.mjs                      # phraseology, voices, squawks, readback errors, positions, AI, coach
node tests/flow.test.mjs EGLL [RWY|-|-0] [SEED]   # full departure + arrival at a cached airport
python tests/fsd_test.py                      # EuroScope / FSD protocol
set XRADIO_DIR=...\xradio-0.5.7 && python tests/xradio_test.py   # against XRadio's own server + fake client
node tests/browser.test.mjs                   # real page in headless Chrome incl. pop-out and the whole guide
```
