"""SimBrief (Phase S1): the OFP parser on a saved, made-up fixture, the fetch errors (HTTP 400 = unknown user /
no flight), the cache, the plan link and the signed API form URL -- all against local stand-ins, never SimBrief.
    python tests/simbrief_test.py
"""
import hashlib
import http.server
import io
import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import simbrief  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        fails += 1


raw = json.load(open(os.path.join(ROOT, "tests", "fixtures", "simbrief_ofp.json"), encoding="utf-8"))
p = simbrief.parse(raw)
print("parser")
check(p["callsign"] == "TTR123" and p["airline"] == "TTR" and p["flight_number"] == "123", "callsign from atc.callsign, airline + number")
check(p["aircraft"]["type"] == "A320" and p["aircraft"]["reg"] == "ESTTR" and p["aircraft"]["reg_display"] == "ES-TTR" and p["aircraft"]["wtc"] == "M", "aircraft type, registration (both forms) and the wake category from the FPL string")
check(p["aircraft"]["equip"] == "SDE2E3FGHIRWXY/LB1D1" and p["aircraft"]["pbn"] == "A1B1C1D1O1S2" and p["aircraft"]["selcal"] == "AB-CD", "equipment, PBN and SELCAL")
check(p["origin"]["icao"] == "EETN" and p["origin"]["rwy"] == "26" and p["destination"]["icao"] == "EVRA" and p["destination"]["rwy"] == "18" and p["alternate"]["icao"] == "EYVI" and p["alternate"]["rwy"] == "19", "origin / destination / alternate with planned runways")
check(p["sid"] == "ULGOT1G" and p["star"] == "ABETI2A", "SID and STAR")
check(p["route"] == "DCT ULGOT N746 ABETI DCT" and p["route_atc"] == "ULGOT1G ULGOT N746 ABETI ABETI2A", "route strings (OFP and ATC)")
check(len(p["fixes"]) == 9 and p["fixes"][2]["ident"] == "ULGOT" and p["fixes"][2]["airway"] == "ULGOT1G" and p["fixes"][2]["sidstar"] and abs(p["fixes"][2]["lat"] - 58.878611) < 1e-6 and p["fixes"][4]["alt_ft"] == 36000 and p["fixes"][4]["wind_dir"] == 250 and p["fixes"][4]["wind_spd"] == 40 and p["fixes"][4]["time_total_s"] == 1140,
      "waypoints with ident, lat/lon, airway, altitude, wind and time")
check(p["initial_alt_ft"] == 36000 and p["steps"] == [{"fix": "EETN", "alt_ft": 36000}, {"fix": "ULGOT", "alt_ft": 38000}], "initial altitude and step climbs")
check(p["cruise_tas"] == 447 and abs(p["cruise_mach"] - 0.78) < 1e-9 and p["cost_index"] == "25", "cruise TAS / Mach / cost index")
check(p["times"]["eobt"]["hhmm"] == "07:30".replace(":", "") and p["times"]["etd"]["hhmm"] == "0740" and p["times"]["eta"]["hhmm"] == "0809" and p["times"]["enroute_s"] == 1750, "EOBT / ETD / ETA as HHMM zulu and the enroute time")
check(p["fuel"]["block"] == 3540 and p["fuel"]["trip"] == 1180 and p["fuel"]["reserve"] == 1100 and p["fuel"]["takeoff"] == 3340 and p["fuel"]["alternate"] == 640 and p["units"] == "kg", "fuel figures in kg")
check(p["weights"]["zfw"] == 57270 and p["weights"]["tow"] == 60610 and p["weights"]["ldw"] == 59430 and p["weights"]["max_tow"] == 77000 and p["weights"]["ok"] == {"zfw": True, "tow": True, "ldw": True} and p["weights"]["pax"] == 142 and p["weights"]["cargo"] == 2600, "ZFW / TOW / LW with limits, pax and cargo")
check(p["fpl"].startswith("(FPL-TTR123-IS") and p["fpl_items"]["7_callsign"] == "TTR123" and p["fpl_items"]["8_rules"] == "I" and p["fpl_items"]["9_type"] == "A320" and p["fpl_items"]["9_wtc"] == "M" and p["fpl_items"]["10_equip"] == "SDE2E3FGHIRWXY/LB1D1" and p["fpl_items"]["13_dep"] == "EETN" and p["fpl_items"]["13_eobt"] == "0730" and p["fpl_items"]["15_route"] == "ULGOT1G ULGOT N746 ABETI ABETI2A" and p["fpl_items"]["16_dest"] == "EVRA" and p["fpl_items"]["16_eet"] == "0029" and p["fpl_items"]["16_altn"] == "EYVI" and "REG/ESTTR" in p["fpl_items"]["18_other"],
      "ICAO flight plan items 7-19 split out")
check("EETN 150620Z" in p["origin"]["metar"] and p["origin"]["taf"].startswith("TAF EETN") and "EVRA 150620Z" in p["destination"]["metar"] and p["destination"]["taf"].startswith("TAF EVRA"), "METAR and TAF at both ends")
check(p["links"]["pdf"] == "https://www.simbrief.com/ofp/flightplans/TTR123_PDF_1760512200.pdf" and p["links"]["xplane_fms"].endswith("TTR123_XPE_1760512200.fms") and p["links"]["skyvector"].startswith("https://skyvector.com"), "OFP PDF and X-Plane .fms links")
check(simbrief.summary(p) == "TTR123 A320/M EETN-EVRA FL360 DCT ULGOT N746 ABETI DCT", "one-line summary: " + simbrief.summary(p))
committed = json.load(open(os.path.join(ROOT, "tests", "fixtures", "simbrief_plan.json"), encoding="utf-8"))
check(committed == p, "tests/fixtures/simbrief_plan.json is parse() of the raw fixture (regenerate it when the parser changes)")
check(simbrief.wake_category("", "B744") == "H" and simbrief.wake_category("", "C172") == "L" and simbrief.wake_category("", "XXXX") == "M" and simbrief.wake_category("(FPL-X-IS\n-B738/M-S/C", "B738") == "M", "wake category: FPL string first, then the table, M otherwise")
try:
    simbrief.parse({"fetch": {"status": "Error: Unknown UserID"}})
    check(False, "an error OFP raises")
except ValueError as e:
    check("Unknown UserID" in str(e), "an error OFP raises with SimBrief's message")

print("fetching (against a local stand-in for xml.fetcher.php)")


class Fake(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if "username=tester" in self.path and "json=1" in self.path:
            body = json.dumps(raw).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)
        elif "userid=999999" in self.path:
            self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(raw).encode())
        elif "username=nobody" in self.path:
            self.send_response(400); self.end_headers(); self.wfile.write(b"<?xml version=\"1.0\"?><OFP><fetch><status>Error: Unknown UserID</status></fetch></OFP>")
        elif "username=slow" in self.path:
            self.send_response(429); self.end_headers()
        else:
            self.send_response(404); self.end_headers()


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fake)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}/api/xml.fetcher.php"
real_url = simbrief.FETCH_URL
simbrief.FETCH_URL = base
d = simbrief.fetch_latest("tester")
check(d["general"]["icao_airline"] == "TTR", "username -> the OFP JSON")
d = simbrief.fetch_latest("999999")
check(d["atc"]["callsign"] == "TTR123", "a numeric pilot id goes as userid")
try:
    simbrief.fetch_latest("nobody")
    check(False, "HTTP 400 raises")
except RuntimeError as e:
    check("unknown username" in str(e) and "400" in str(e), "HTTP 400 -> a clear message: " + str(e))
try:
    simbrief.fetch_latest("slow")
    check(False, "HTTP 429 raises")
except RuntimeError as e:
    check("too many" in str(e), "HTTP 429 -> wait message")
try:
    simbrief.fetch_latest("bad user!")
    check(False, "an invalid user string is refused before any request")
except ValueError as e:
    check("username" in str(e), "an invalid user string is refused before any request")
simbrief.FETCH_URL = real_url
srv.shutdown()

print("cache and links")
with tempfile.TemporaryDirectory() as tmp:
    st = simbrief.Store(tmp)
    check(st.last() is None, "no cache yet")
    plan = st.save("tester", raw)
    check(plan["callsign"] == "TTR123" and plan["user"] == "tester" and plan["fetched"] > 0, "save() parses and stamps")
    check(os.path.exists(os.path.join(tmp, "simbrief", "tester.raw.json")) and os.path.exists(os.path.join(tmp, "simbrief", "last.json")), "raw OFP and last.json in cache/simbrief/")
    check(st.last()["callsign"] == "TTR123", "last() reads it back")
    st.clear()
    check(st.last() is None, "clear() empties it")
check(simbrief.plan_url() == "https://www.simbrief.com/system/dispatch.php?newflight=1", "the plan-by-hand link is the official new-flight page")
u = simbrief.api_form_url({"orig": "EETN", "dest": "EVRA", "type": "A320", "airline": "TTR", "fltnum": "123", "route": "ULGOT N746 ABETI", "bogus": "x"}, "secretkey", "http://localhost:8780/", now=1700000000)
q = dict(urllib.parse.parse_qsl(u.split("?", 1)[1]))
check(u.startswith(simbrief.API_FORM_URL) and q["orig"] == "EETN" and q["type"] == "A320" and q["fltnum"] == "123" and "bogus" not in q and q["outputpage"] == "http://localhost:8780/", "API form URL carries the form fields, not unknown ones")
check(q["timestamp"] == "1700000000" and q["apicode"] == hashlib.md5(b"secretkey1700000000").hexdigest() and "secretkey" not in u, "signed like simbrief.apiv1.php: md5(key + timestamp), the key itself never in the URL")
try:
    simbrief.api_form_url({"orig": "EETN"}, "k")
    check(False, "missing dest/type refused")
except ValueError as e:
    check("required" in str(e), "orig/dest/type are required")
try:
    simbrief.api_form_url({"orig": "EETN", "dest": "EVRA", "type": "A320"}, "")
    check(False, "no key refused")
except ValueError as e:
    check("API key" in str(e), "without a key the form flow is refused (plan on the page instead)")

print(f"\n{fails} FAILED" if fails else "\nALL PASSED")
sys.exit(1 if fails else 0)
