"""Real traffic mix per airport from the OpenFlights route data (airlines, routes, airports).

Data: https://openflights.org/data (ODbL, © OpenFlights contributors). Downloaded once into cache/openflights/
and never committed. The result for an airport is cached in cache/<ICAO>.traffic.json:
  airlines: [{icao, iata, name, callsign, country, nat, routes}]   (sorted by number of routes)
  dests:    [{icao, name, city, country, lat, lon, routes}]
  pairs:    [[airlineIcao, destIcao, count], ...]                 (what really flies from here)
  cargo:    [airlineIcao, ...]
Everything degrades: no network -> {} and the simulator uses its built-in list.
"""
import csv
import io
import json
import time
import urllib.request
from pathlib import Path

BASE = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/"
FILES = ("airlines.dat", "airports.dat", "routes.dat")
UA = {"User-Agent": "TowerTrainer/0.2 (personal ATC practice tool)"}
CREDIT = "Routes and airlines © OpenFlights contributors (ODbL)"

# OpenFlights country -> crew nationality (ISO-ish, as used by the voices)
COUNTRY_NAT = {
    "Estonia": "EE", "Finland": "FI", "Latvia": "LV", "Lithuania": "LT", "Germany": "DE", "Austria": "AT", "Switzerland": "CH",
    "France": "FR", "Belgium": "BE", "Netherlands": "NL", "Denmark": "DK", "Sweden": "SE", "Norway": "NO", "Poland": "PL",
    "Spain": "ES", "Italy": "IT", "Portugal": "PT", "Hungary": "HU", "Romania": "RO", "Turkey": "TR", "Czech Republic": "CZ",
    "United Arab Emirates": "AE", "Qatar": "AE", "China": "CN", "United Kingdom": "GB", "Ireland": "IE", "United States": "US",
    "Canada": "CA", "Australia": "AU", "New Zealand": "NZ", "South Africa": "ZA", "Singapore": "SG", "India": "IN",
    "Iceland": "DK", "Luxembourg": "FR", "Greece": "IT", "Croatia": "HU", "Slovakia": "CZ", "Slovenia": "AT", "Bulgaria": "RO",
    "Serbia": "HU", "Ukraine": "PL", "Russia": "PL", "Belarus": "PL", "Israel": "GB", "Egypt": "AE", "Morocco": "FR",
    "Japan": "CN", "South Korea": "CN", "Thailand": "SG", "Malaysia": "SG", "Indonesia": "SG", "Mexico": "ES", "Brazil": "PT",
}
CARGO_WORDS = ("cargo", "freight", "express", "logistic", "fedex", "ups ", "dhl", "cargolux", "aerologic", "asl ")


def _download(name, cache_dir, max_age=30 * 86400):
    f = Path(cache_dir) / name
    if f.is_file() and time.time() - f.stat().st_mtime < max_age and f.stat().st_size > 1000:
        return f.read_text("utf-8", "replace")
    req = urllib.request.Request(BASE + name, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        text = r.read().decode("utf-8", "replace")
    Path(cache_dir).mkdir(parents=True, exist_ok=True)
    f.write_text(text, "utf-8")
    return text


def _rows(text):
    return csv.reader(io.StringIO(text))


def build(icao, cache_dir):
    """Compute the traffic mix for one airport from the three data files (downloaded if needed)."""
    cache_dir = Path(cache_dir)
    raw = {n: _download(n, cache_dir / "openflights") for n in FILES}
    airports = {}      # openflights id -> dict
    by_icao = {}
    for r in _rows(raw["airports.dat"]):
        if len(r) < 8:
            continue
        a = {"id": r[0], "name": r[1], "city": r[2], "country": r[3], "iata": r[4], "icao": r[5], "lat": float(r[6]), "lon": float(r[7])}
        if a["icao"] and a["icao"] != "\\N":
            airports[a["id"]] = a
            by_icao[a["icao"]] = a
    me = by_icao.get(icao.upper())
    if not me:
        return {"airlines": [], "dests": [], "pairs": [], "cargo": [], "credit": CREDIT, "error": f"{icao} not in OpenFlights"}
    airlines = {}      # openflights id -> dict
    for r in _rows(raw["airlines.dat"]):
        if len(r) < 8:
            continue
        aid, name, alias, iata, aicao, callsign, country, active = r[:8]
        if not aicao or aicao == "\\N" or len(aicao) != 3:
            continue
        airlines[aid] = {"icao": aicao, "iata": iata if iata != "\\N" else "", "name": name, "callsign": (callsign or "").title() if callsign != "\\N" else "",
                         "country": country, "nat": COUNTRY_NAT.get(country, ""), "active": active == "Y"}
    counts = {}        # (airline id, dest id) -> count
    for r in _rows(raw["routes.dat"]):
        if len(r) < 9:
            continue
        _al, al_id, _src, src_id, _dst, dst_id, _code, _stops, _equip = r[:9]
        if src_id != me["id"] or al_id not in airlines or dst_id not in airports:
            continue
        counts[(al_id, dst_id)] = counts.get((al_id, dst_id), 0) + 1
    al_routes, dest_routes, pairs = {}, {}, []
    for (al, ds), n in counts.items():
        al_routes[al] = al_routes.get(al, 0) + n
        dest_routes[ds] = dest_routes.get(ds, 0) + n
        pairs.append([airlines[al]["icao"], airports[ds]["icao"], n])
    out_airlines = [{**{k: v for k, v in airlines[a].items() if k != "active"}, "routes": n} for a, n in al_routes.items()]
    out_airlines.sort(key=lambda x: -x["routes"])
    out_dests = [{"icao": airports[d]["icao"], "name": airports[d]["name"], "city": airports[d]["city"], "country": airports[d]["country"],
                  "lat": airports[d]["lat"], "lon": airports[d]["lon"], "routes": n} for d, n in dest_routes.items()]
    out_dests.sort(key=lambda x: -x["routes"])
    cargo = [a["icao"] for a in out_airlines if any(w in (a["name"] + " " + a["callsign"]).lower() for w in CARGO_WORDS)]
    return {"icao": icao.upper(), "iata": me["iata"], "airlines": out_airlines[:60], "dests": out_dests[:120],
            "pairs": sorted(pairs, key=lambda p: -p[2])[:400], "cargo": cargo, "credit": CREDIT, "fetched": int(time.time())}


def load(icao, cache_dir, refresh=False):
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(exist_ok=True)
    f = cache_dir / f"{icao.upper()}.traffic.json"
    if f.is_file() and not refresh:
        try:
            return json.loads(f.read_text("utf-8"))
        except (OSError, ValueError):
            pass
    try:
        data = build(icao, cache_dir)
    except Exception as e:   # noqa: BLE001
        return {"airlines": [], "dests": [], "pairs": [], "cargo": [], "credit": CREDIT, "error": f"{type(e).__name__}: {e}", "offline": True}
    if not data.get("error"):
        f.write_text(json.dumps(data, separators=(",", ":")), "utf-8")
    return data
