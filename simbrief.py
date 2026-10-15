"""SimBrief flight planning (Phase S1): fetch the pilot's latest OFP the official way and turn it into one clean object.

Only the documented API is used (developers.navigraph.com/docs/simbrief):
  * the latest OFP:  https://www.simbrief.com/api/xml.fetcher.php?username=<name>&json=1   (or ?userid=<pilot id>)
    HTTP 400 = unknown user or no flight planned yet -> a clear message, never a retry loop;
  * a new flight plan without an API key: the pilot plans on https://www.simbrief.com/system/dispatch.php?newflight=1
    in the browser and fetches the result afterwards;
  * with an API key (from SimBrief support): the official apiv1 form flow -- the request is signed the way
    simbrief.apiv1.php does it (api code = md5(key + timestamp)) and opened on SimBrief's own page.
Nothing is scraped, no login is bypassed, nothing is fetched unless asked (the page fetches on a button, plus at
most one automatic fetch when a session starts). The last OFP is cached in cache/simbrief/ (not committed).
Stdlib only.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

FETCH_URL = "https://www.simbrief.com/api/xml.fetcher.php"
NEW_FLIGHT_URL = "https://www.simbrief.com/system/dispatch.php?newflight=1"
API_FORM_URL = "https://www.simbrief.com/ofp/ofp.loader.api.php"
UA = {"User-Agent": "TowerTrainer/1.0 (SimBrief OFP viewer; personal ATC practice)"}
USER_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,64}$")

WTC_BY_TYPE = {"A388": "J", "A124": "H", "A225": "H", "A332": "H", "A333": "H", "A339": "H", "A342": "H", "A343": "H", "A345": "H", "A346": "H", "A359": "H", "A35K": "H",
               "B742": "H", "B743": "H", "B744": "H", "B748": "H", "B752": "M", "B753": "M", "B762": "H", "B763": "H", "B764": "H", "B772": "H", "B773": "H", "B77L": "H", "B77W": "H",
               "B788": "H", "B789": "H", "B78X": "H", "MD11": "H", "DC10": "H", "IL96": "H", "C17": "H", "A306": "H", "A310": "H",
               "C172": "L", "C152": "L", "C182": "L", "P28A": "L", "DA40": "L", "DA42": "L", "SR22": "L", "PA34": "L", "BE58": "L", "C208": "L", "PC12": "L"}


def _f(v, default=0.0):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return default


def _i(v, default=0):
    try:
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return default


def _s(v):
    return "" if v is None else str(v).strip()


def _ts(v):
    """Epoch seconds -> 'HHMM' zulu and ISO; SimBrief gives epoch strings."""
    t = _i(v, 0)
    if t <= 0:
        return {"epoch": 0, "hhmm": "", "iso": ""}
    g = time.gmtime(t)
    return {"epoch": t, "hhmm": time.strftime("%H%M", g), "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", g)}


def wake_category(ofp_text: str, actype: str) -> str:
    """The WTC letter from the ICAO flight-plan string (-A320/M-), else a table, else M."""
    m = re.search(r"-([A-Z0-9]{2,4})/([LMHJ])-", ofp_text or "")
    if m:
        return m.group(2)
    return WTC_BY_TYPE.get(actype.upper(), "M")


def parse(ofp: dict) -> dict:
    """The OFP JSON (xml.fetcher.php ... &json=1) -> one flat, typed object the trainer and the plugin use."""
    if not isinstance(ofp, dict):
        raise ValueError("not an OFP object")
    fetch = ofp.get("fetch") or {}
    if _s(fetch.get("status")) and _s(fetch.get("status")).lower() not in ("success", "ok"):
        raise ValueError(f"SimBrief: {fetch.get('status')}")
    g = ofp.get("general") or {}
    o, d, a = ofp.get("origin") or {}, ofp.get("destination") or {}, ofp.get("alternate") or {}
    if isinstance(a, list):
        a = a[0] if a else {}
    atc = ofp.get("atc") or {}
    ac = ofp.get("aircraft") or {}
    fuel, w, t = ofp.get("fuel") or {}, ofp.get("weights") or {}, ofp.get("times") or {}
    wx, params = ofp.get("weather") or {}, ofp.get("params") or {}
    files, fms = ofp.get("files") or {}, ofp.get("fms_downloads") or {}
    airline, fltnum = _s(g.get("icao_airline")), _s(g.get("flight_number"))
    callsign = _s(atc.get("callsign")) or (airline + fltnum)
    actype = _s(ac.get("icaocode") or ac.get("icao_code") or ac.get("base_type"))
    fpl = _s(atc.get("flightplan_text"))
    units = "lb" if "lb" in _s(params.get("units")).lower() else "kg"
    fixes = []
    navlog = ofp.get("navlog") or {}
    raw_fixes = navlog.get("fix") if isinstance(navlog, dict) else navlog
    if isinstance(raw_fixes, dict):
        raw_fixes = [raw_fixes]
    for f in raw_fixes or []:
        if not isinstance(f, dict):
            continue
        fixes.append({"ident": _s(f.get("ident")), "name": _s(f.get("name")), "type": _s(f.get("type")), "lat": _f(f.get("pos_lat")), "lon": _f(f.get("pos_long")),
                      "airway": _s(f.get("via_airway")), "sidstar": _s(f.get("is_sid_star")) == "1", "stage": _s(f.get("stage")), "alt_ft": _i(f.get("altitude_feet")),
                      "ias": _i(f.get("ind_airspeed")), "tas": _i(f.get("true_airspeed")), "mach": _f(f.get("mach")), "gs": _i(f.get("groundspeed")),
                      "wind_dir": _i(f.get("wind_dir")), "wind_spd": _i(f.get("wind_spd")), "oat": _i(f.get("oat")), "dist_nm": _f(f.get("distance")),
                      "track_true": _i(f.get("track_true")), "track_mag": _i(f.get("track_mag")), "time_leg_s": _i(f.get("time_leg")), "time_total_s": _i(f.get("time_total")),
                      "fuel_leg": _i(f.get("fuel_leg")), "fuel_onboard": _i(f.get("fuel_plan_onboard")), "fir": _s(f.get("fir")), "mora": _s(f.get("mora"))})
    steps = []
    for part in _s(g.get("stepclimb_string")).split():
        if "/" in part:
            fx, lvl = part.split("/", 1)
            steps.append({"fix": fx, "alt_ft": _i(lvl) * 100 if len(lvl) <= 4 else _i(lvl)})
    directory = _s(files.get("directory")) or _s(fms.get("directory"))
    pdf = files.get("pdf") or fms.get("pdf") or {}
    link = lambda item: (directory + _s(item.get("link"))) if isinstance(item, dict) and _s(item.get("link")) and not _s(item.get("link")).startswith("http") else (_s(item.get("link")) if isinstance(item, dict) else "")
    pbn = ""
    m = re.search(r"PBN/([A-Z0-9]+)", fpl)
    if m:
        pbn = m.group(1)
    selcal = _s(ac.get("selcal"))
    m = re.search(r"SEL/([A-Z]{4})", fpl)
    if not selcal and m:
        selcal = m.group(1)
    plan = {
        "source": "simbrief", "generated": _ts(params.get("time_generated")), "airac": _s(params.get("airac")), "static_id": _s(params.get("static_id")), "request_id": _s(params.get("request_id")),
        "units": units, "airline": airline, "flight_number": fltnum, "callsign": callsign,
        "aircraft": {"type": actype, "name": _s(ac.get("name")), "reg": _s(ac.get("reg")).replace("-", "").upper() if _s(ac.get("reg")) else "", "reg_display": _s(ac.get("reg")), "equip": _s(ac.get("equip")),
                     "pbn": pbn, "selcal": selcal, "wtc": wake_category(fpl, actype), "max_pax": _i(ac.get("max_passengers"))},
        "origin": {"icao": _s(o.get("icao_code")), "name": _s(o.get("name")), "rwy": _s(o.get("plan_rwy")), "lat": _f(o.get("pos_lat")), "lon": _f(o.get("pos_long")), "elev_ft": _i(o.get("elevation")), "trans_alt": _i(o.get("trans_alt")), "metar": _s(o.get("metar") or wx.get("orig_metar")), "taf": _s(o.get("taf") or wx.get("orig_taf"))},
        "destination": {"icao": _s(d.get("icao_code")), "name": _s(d.get("name")), "rwy": _s(d.get("plan_rwy")), "lat": _f(d.get("pos_lat")), "lon": _f(d.get("pos_long")), "elev_ft": _i(d.get("elevation")), "trans_alt": _i(d.get("trans_alt")), "metar": _s(d.get("metar") or wx.get("dest_metar")), "taf": _s(d.get("taf") or wx.get("dest_taf"))},
        "alternate": {"icao": _s(a.get("icao_code")), "name": _s(a.get("name")), "rwy": _s(a.get("plan_rwy")), "lat": _f(a.get("pos_lat")), "lon": _f(a.get("pos_long")), "burn": _i(a.get("burn")), "dist_nm": _i(a.get("distance")), "route": _s(a.get("route")), "metar": _s(a.get("metar") or wx.get("altn_metar")), "taf": _s(a.get("taf") or wx.get("altn_taf"))},
        "sid": _s(g.get("sid_ident")), "sid_trans": _s(g.get("sid_trans")), "star": _s(g.get("star_ident")), "star_trans": _s(g.get("star_trans")),
        "route": _s(g.get("route")), "route_ifps": _s(g.get("route_ifps")) or _s(atc.get("route_ifps")), "route_atc": _s(atc.get("route")), "fixes": fixes,
        "initial_alt_ft": _i(g.get("initial_altitude")), "steps": steps, "cruise_tas": _i(g.get("cruise_tas")), "cruise_mach": _f(g.get("cruise_mach")), "cost_index": _s(g.get("costindex")),
        "distance": {"gc_nm": _i(g.get("gc_distance")), "route_nm": _i(g.get("route_distance")), "air_nm": _i(g.get("air_distance"))},
        "times": {"eobt": _ts(t.get("sched_out")), "etd": _ts(t.get("est_off")), "eta": _ts(t.get("est_on")), "eibt": _ts(t.get("est_in")), "enroute_s": _i(t.get("est_time_enroute")), "sched_enroute_s": _i(t.get("sched_time_enroute")),
                  "block_s": _i(t.get("est_block")), "taxi_out_s": _i(t.get("taxi_out")), "taxi_in_s": _i(t.get("taxi_in")), "endurance_s": _i(t.get("endurance"))},
        "fuel": {"taxi": _i(fuel.get("taxi")), "trip": _i(fuel.get("enroute_burn")), "contingency": _i(fuel.get("contingency")), "alternate": _i(fuel.get("alternate_burn")), "reserve": _i(fuel.get("reserve")), "extra": _i(fuel.get("extra")),
                 "min_takeoff": _i(fuel.get("min_takeoff")), "takeoff": _i(fuel.get("plan_takeoff")), "block": _i(fuel.get("plan_ramp")), "landing": _i(fuel.get("plan_landing")), "max_tanks": _i(fuel.get("max_tanks"))},
        "weights": {"oew": _i(w.get("oew")), "payload": _i(w.get("payload")), "cargo": _i(w.get("cargo")), "pax": _i(w.get("pax_count")), "zfw": _i(w.get("est_zfw")), "max_zfw": _i(w.get("max_zfw")), "tow": _i(w.get("est_tow")), "max_tow": _i(w.get("max_tow")),
                    "ldw": _i(w.get("est_ldw")), "max_ldw": _i(w.get("max_ldw")), "ramp": _i(w.get("est_ramp"))},
        "fpl": fpl, "fpl_items": fpl_items(fpl), "remarks": _s(atc.get("section18")),
        "links": {"pdf": link(pdf), "xplane_fms": link(fms.get("xpe") or {}), "directory": directory, "skyvector": _s((ofp.get("links") or {}).get("skyvector"))},
    }
    plan["weights"]["ok"] = {"zfw": plan["weights"]["zfw"] <= plan["weights"]["max_zfw"] or not plan["weights"]["max_zfw"], "tow": plan["weights"]["tow"] <= plan["weights"]["max_tow"] or not plan["weights"]["max_tow"],
                             "ldw": plan["weights"]["ldw"] <= plan["weights"]["max_ldw"] or not plan["weights"]["max_ldw"]}
    return plan


def fpl_items(fpl: str) -> dict:
    """Items 7-19 of the ICAO flight-plan string, as far as it carries them."""
    out = {}
    if not fpl:
        return out
    body = fpl.strip().strip("()")
    lines = [l.strip() for l in body.replace("\r", "").split("\n") if l.strip()]
    m = re.match(r"FPL-([A-Z0-9]+)-([IVYZ])([SNGMX])", lines[0] if lines else "")
    if m:
        out["7_callsign"], out["8_rules"], out["8_type"] = m.group(1), m.group(2), m.group(3)
    for l in lines[1:]:
        l = l.lstrip("-")
        if re.match(r"^[A-Z0-9]{2,4}/[LMHJ]-", l):
            typ, rest = l.split("/", 1)
            out["9_type"], out["9_wtc"] = typ, rest[0]
            out["10_equip"] = rest[2:] if len(rest) > 2 else ""
        elif re.match(r"^[A-Z]{4}\d{4}$", l):
            out["13_dep"], out["13_eobt"] = l[:4], l[4:]
        elif re.match(r"^[NMK]\d{3,4}[FASVM]\d{3,4} ", l):
            out["15_speed"], out["15_level"] = l.split(" ")[0][:5] if l[0] == "N" else l.split(" ")[0], l.split(" ")[0]
            out["15_route"] = " ".join(l.split(" ")[1:])
        elif re.match(r"^[A-Z]{4}\d{4}( [A-Z]{4})*$", l):
            parts = l.split(" ")
            out["16_dest"], out["16_eet"], out["16_altn"] = parts[0][:4], parts[0][4:], " ".join(parts[1:])
        elif "/" in l:
            out["18_other"] = l
    return out


def _message_for(code: int, body: str) -> str:
    if code == 400:
        return "SimBrief: unknown username / pilot ID, or no flight has been planned yet (HTTP 400)"
    if code in (401, 403):
        return f"SimBrief refused the request (HTTP {code})"
    if code == 429:
        return "SimBrief: too many requests, wait a moment (HTTP 429)"
    return f"SimBrief: HTTP {code} {body[:120]}"


def fetch_latest(user: str, timeout: float = 15.0, opener=None) -> dict:
    """The raw OFP JSON of the pilot's latest flight. `user` is a username or a numeric pilot id."""
    user = _s(user)
    if not USER_RE.match(user):
        raise ValueError("SimBrief: enter your SimBrief username or pilot ID (Settings)")
    key = "userid" if user.isdigit() else "username"
    url = f"{FETCH_URL}?{urllib.parse.urlencode({key: user, 'json': '1'})}"
    req = urllib.request.Request(url, headers=UA)
    try:
        with (opener or urllib.request.urlopen)(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            body = ""
        raise RuntimeError(_message_for(e.code, body)) from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"SimBrief not reachable: {e.reason}") from None
    try:
        data = json.loads(body)
    except ValueError:
        m = re.search(r"<error>(.*?)</error>", body, re.S)
        raise RuntimeError("SimBrief: " + (m.group(1).strip() if m else "unexpected answer (not JSON)")) from None
    if isinstance(data, dict) and isinstance(data.get("fetch"), dict) and _s(data["fetch"].get("status")).lower() not in ("", "success", "ok"):
        raise RuntimeError("SimBrief: " + _s(data["fetch"].get("status")))
    return data


class Store:
    """cache/simbrief/: the last raw OFP and its parsed form, per user and as 'last'."""

    def __init__(self, cache_dir):
        self.dir = Path(cache_dir) / "simbrief"

    def save(self, user: str, raw: dict) -> dict:
        self.dir.mkdir(parents=True, exist_ok=True)
        plan = parse(raw)
        plan["fetched"] = int(time.time())
        plan["user"] = _s(user)
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", _s(user)) or "user"
        (self.dir / f"{safe}.raw.json").write_text(json.dumps(raw, separators=(",", ":")), "utf-8")
        (self.dir / "last.json").write_text(json.dumps(plan, separators=(",", ":")), "utf-8")
        return plan

    def last(self):
        p = self.dir / "last.json"
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text("utf-8"))
        except ValueError:
            return None

    def clear(self):
        for p in self.dir.glob("*.json"):
            try:
                p.unlink()
            except OSError:
                pass


def plan_url() -> str:
    """Where a pilot plans a new flight by hand (no key needed)."""
    return NEW_FLIGHT_URL


API_FIELDS = ("orig", "dest", "type", "airline", "fltnum", "route", "altn", "deph", "depm", "fl", "reg", "cpt", "pax", "civalue", "units", "planformat", "navlog", "stepclimbs", "static_id", "date", "steh", "stem")


def api_form_url(params: dict, api_key: str, referral_page: str = "", now: int | None = None) -> str:
    """The official apiv1 flow, done the way simbrief.apiv1.php does it: the form fields plus a timestamp and the
    api code md5(key + timestamp), opened on SimBrief's loader page. The key never leaves this machine except
    as that hash, exactly as the official PHP does."""
    key = _s(api_key)
    if not key:
        raise ValueError("SimBrief: no API key (Settings) -- plan on SimBrief's page instead")
    fields = {k: _s(v) for k, v in params.items() if k in API_FIELDS and _s(v)}
    for req in ("orig", "dest", "type"):
        if req not in fields:
            raise ValueError(f"SimBrief: {req} is required")
    if fields.get("static_id") and not re.match(r"^[A-Za-z0-9_]+$", fields["static_id"]):
        raise ValueError("SimBrief: static_id may contain only letters, numbers and underscores")
    ts = int(now if now is not None else time.time())
    fields["timestamp"] = str(ts)
    fields["apicode"] = hashlib.md5((key + str(ts)).encode("utf-8")).hexdigest()
    if referral_page:
        fields["outputpage"] = referral_page
    return API_FORM_URL + "?" + urllib.parse.urlencode(fields)


def summary(plan: dict) -> str:
    """One line for logs and the strip: TTR123 A320/M EETN-EVRA FL360 ULGOT N746 ABETI."""
    lvl = plan.get("initial_alt_ft", 0)
    return f"{plan.get('callsign', '')} {plan.get('aircraft', {}).get('type', '')}/{plan.get('aircraft', {}).get('wtc', 'M')} {plan.get('origin', {}).get('icao', '')}-{plan.get('destination', {}).get('icao', '')} " \
           f"{'FL%03d' % (lvl // 100) if lvl >= 6000 else str(lvl) + ' ft'} {plan.get('route', '')}".strip()
