# Tower Trainer

Offline practice for VATSIM Delivery / Ground / Tower at (almost) any airport in the world.
Airport layouts — runways, taxiways, taxi-route network, hold zones, stands, frequencies — are downloaded on demand
from the X-Plane Scenery Gateway and cached in `cache/`. Runway in use comes from the live METAR.

## Run

```
python server.py            # http://localhost:8780   (?icao=EGLL to open a specific airport)
```

Needs Python 3 (stdlib only) and Chrome or Edge (push-to-talk uses the browser's speech recognition).

## What you do

You work DEL/GND/TWR combined. Traffic calls in by voice (browser TTS with squelch/static):

- **Delivery** – airliners request IFR clearance: `BTI123 cleared to Riga via LAKUT1A departure, climb 4000 feet, squawk 4521`
  (wrong destination or missing squawk gets challenged)
- **Ground** – `push and start approved, facing east` · `taxi holding point runway 26 via S A` · `cross runway 08` ·
  `hold position` / `continue taxi` · arrivals `taxi to stand K2 via B A`
- **Tower** – `runway 26 line up and wait` · `cleared for takeoff` · `cleared to land` · `go around` · `contact radar 127.905`
- GA fields get VFR light aircraft with registration callsigns (`Echo Sierra Alpha Bravo Charlie`).

Aircraft stop short of **every** runway hold zone unless cleared to cross / line up. Arrivals without landing clearance go around at
~0.3 nm; departures need a frequency change. Flagged: runway conflicts, takeoff with traffic inside 2 nm, wake (2 min behind heavy),
ground proximity, aircraft leaving without handoff.

Type into the box (Enter) or hold **Ctrl+Space** / the mic button and speak. Callsign first (`BTI123` or `Air Baltic one two three`);
if omitted, the selected aircraft is assumed. Numbers and phonetic letters may be spoken or typed.

## Layout

| Path | |
|---|---|
| `server.py` | static server + `/api/airport/<ICAO>` (Gateway download, cached) + `/api/metar/<ICAO>` |
| `aptdat.py` | apt.dat → JSON (local metres around the airport datum) |
| `web/js/airport.js` | runways, taxi graph, routing (via-constrained Dijkstra), exits |
| `web/js/sim.js` | aircraft state machines, movement, pilots, safety checks |
| `web/js/commands.js` | phraseology parser (spoken numbers, phonetics, callsigns) |
| `web/js/radio.js` | single-frequency queue, TTS, radio noise |
| `web/js/render.js` | ground radar canvas |

## Tests

```
node tests/flow.test.mjs EGLL [RWY|-|-0] [SEED]   # headless departure + arrival + go-around at a cached airport
node tests/ui.mjs EETN [outDir]                    # drives the real page in headless Chrome (server must run)
```

Gateway data quality varies: wrong one-way flags are tolerated (reverse travel at high cost), exits into dead-end stubs are skipped,
and runways without usable exits make arrivals backtrack.

## Next steps

- Local Whisper speech recognition (offline, constrained to callsigns/phraseology) and Piper voices through a real radio filter
- Readback errors to catch, pilots who forget to call, frequency congestion, split DEL/GND/TWR positions with handoffs
- SIDs from CIFP / Navigraph, vACC sector files for local stand allocation and standard routes
