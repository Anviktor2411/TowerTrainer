"""Setup wizard backend (G6): what the browser page /setup asks the server to detect and do.

Rules the wizard keeps:
  * it only writes under folders it shows first (Documents\\EuroScope, the X-Plane folder, this folder's cache)
    and asks before overwriting anything that exists;
  * every action is logged to setup.log next to server.py (ignored by git);
  * nothing from a sector package, Navigraph or X-Plane is ever copied into the repository;
  * every action takes dry_run=True and then only reports what it would do.
Stdlib only. The functions are small and testable on a temporary folder (tests/setup_test.py).
"""
from __future__ import annotations

import importlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG = ROOT / "setup.log"
XRADIO_RELEASES = "https://api.github.com/repos/Anviktor2411/xradio/releases/latest"
EUROSCOPE_SITE = "https://www.euroscope.hu/wp/"
PYTHON_SITE = "https://www.python.org/downloads/"
UA = {"User-Agent": "TowerTrainer-setup/1.0"}

# pip name, import name, purpose, rough download size
OPTIONAL = [
    ("edge-tts", "edge_tts", "neural pilot and controller voices (free, needs internet)", "0.1 MB"),
    ("piper-tts", "piper", "offline neural voices", "20 MB + 60 MB per voice model"),
    ("faster-whisper", "faster_whisper", "speech recognition for Firefox / remote windows / pilot transcripts", "1.2 GB incl. CTranslate2 and the base model"),
    ("vosk", "vosk", "lighter offline speech recognition", "30 MB + 50 MB model"),
    ("av", "av", "Opus voice for XRadio (PyAV, bundled FFmpeg)", "45 MB"),
    ("opuslib", "opuslib", "Opus voice for XRadio (needs a libopus DLL on PATH)", "0.1 MB"),
]


def log(msg: str):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass
    return line


# ---------------------------------------------------------------- Python and optional packages
def python_info() -> dict:
    v = sys.version_info
    pip = importlib.util.find_spec("pip") is not None
    return {"version": f"{v.major}.{v.minor}.{v.micro}", "executable": sys.executable, "ok": (v.major, v.minor) >= (3, 9), "pip": pip,
            "platform": platform.platform(), "download": PYTHON_SITE}


def packages() -> list:
    out = []
    for pip_name, mod, what, size in OPTIONAL:
        info = {"pip": pip_name, "module": mod, "what": what, "size": size, "installed": False, "version": ""}
        try:
            spec = importlib.util.find_spec(mod)
        except (ValueError, ModuleNotFoundError):
            spec = None
        if spec is not None:
            info["installed"] = True
            try:
                from importlib import metadata
                info["version"] = metadata.version(pip_name)
            except Exception:
                info["version"] = "?"
        out.append(info)
    return out


def pip_install(pip_name: str, dry_run: bool = False) -> dict:
    """Install one optional package with this interpreter's pip (never anything else)."""
    if pip_name not in [p[0] for p in OPTIONAL]:
        return {"ok": False, "error": "not an optional package of the trainer"}
    cmd = [sys.executable, "-m", "pip", "install", "--user" if not _in_venv() else "--upgrade", pip_name] if not _in_venv() else [sys.executable, "-m", "pip", "install", pip_name]
    if dry_run:
        return {"ok": True, "dry_run": True, "command": " ".join(cmd)}
    log(f"pip install {pip_name}: {' '.join(cmd)}")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        out = (r.stdout or "") + (r.stderr or "")
        ok = r.returncode == 0
        log(f"pip install {pip_name}: {'ok' if ok else 'FAILED ' + str(r.returncode)}")
        return {"ok": ok, "output": out[-4000:], "command": " ".join(cmd)}
    except Exception as e:  # noqa: BLE001
        log(f"pip install {pip_name}: {e}")
        return {"ok": False, "error": str(e), "command": " ".join(cmd)}


def _in_venv() -> bool:
    return sys.prefix != getattr(sys, "base_prefix", sys.prefix)


# ---------------------------------------------------------------- folders
def documents_dir() -> Path:
    home = Path.home()
    for cand in (home / "Documents", home / "OneDrive" / "Documents", home / "Dokumendid"):
        if cand.exists():
            return cand
    return home / "Documents"


def euroscope_status(docs: Path | None = None) -> dict:
    docs = Path(docs) if docs else documents_dir() / "EuroScope"
    exes = []
    for base in (os.environ.get("PROGRAMFILES(X86)", ""), os.environ.get("PROGRAMFILES", ""), os.environ.get("LOCALAPPDATA", "")):
        if base:
            p = Path(base) / "EuroScope" / "EuroScope.exe"
            if p.exists():
                exes.append(str(p))
    packages_found = []
    if docs.exists():
        for d in sorted(docs.iterdir()):
            if d.is_dir():
                sct = list(d.rglob("*.sct"))
                if sct:
                    packages_found.append({"name": d.name, "sct": [str(s) for s in sct[:5]], "prf": [str(p) for p in d.rglob("*.prf")][:5]})
    return {"installed": bool(exes), "exe": exes[0] if exes else "", "docs": str(docs), "docs_exists": docs.exists(), "packages": packages_found, "site": EUROSCOPE_SITE,
            "profiles": [str(p) for p in docs.glob("*.prf")] if docs.exists() else []}


def unpack_sector_package(zip_path: str, docs: str, name: str = "", overwrite: bool = False, dry_run: bool = False) -> dict:
    """Unpack a sector package the user supplied into Documents\\EuroScope\\<name>. Never fetched by the trainer."""
    zp = Path(zip_path)
    if not zp.exists() or not zipfile.is_zipfile(zp):
        return {"ok": False, "error": "not a zip file"}
    target = Path(docs) / (name or re.sub(r"[^A-Za-z0-9_.-]+", "_", zp.stem))
    with zipfile.ZipFile(zp) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        bad = [n for n in names if n.startswith("/") or ".." in Path(n).parts or (len(n) > 1 and n[1] == ":")]
        if bad:
            return {"ok": False, "error": f"the package has unsafe paths ({bad[0]})"}
        if target.exists() and any(target.iterdir()) and not overwrite:
            return {"ok": False, "exists": True, "target": str(target), "error": "the folder exists — allow overwriting to replace it"}
        if dry_run:
            return {"ok": True, "dry_run": True, "target": str(target), "files": len(names), "sct": [n for n in names if n.lower().endswith(".sct")][:5]}
        target.mkdir(parents=True, exist_ok=True)
        z.extractall(target)
    log(f"sector package {zp} unpacked to {target} ({len(names)} files)")
    return {"ok": True, "target": str(target), "files": len(names), "sct": [str(p) for p in target.rglob("*.sct")][:5], "prf": [str(p) for p in target.rglob("*.prf")][:5]}


def generate_sector(icao: str, docs: str, cache_dir: str | Path | None = None, callsign: str = "", overwrite: bool = False, dry_run: bool = False) -> dict:
    """TowerTrainer_<ICAO>.sct/.ese/.asr + profile from the trainer's own airport data (sector.py)."""
    import sector
    icao = icao.upper()
    cache = Path(cache_dir) if cache_dir else ROOT / "cache"
    if not (cache / f"{icao}.json").exists():
        return {"ok": False, "error": f"{icao} is not cached yet — load it in the trainer first"}
    apt, procs, osm = sector.load_cached(cache, icao)
    target = Path(docs) / "TowerTrainer"
    existing = [p for p in (target / f"TowerTrainer_{icao}.sct", target / f"TowerTrainer {icao}.prf") if p.exists()]
    if existing and not overwrite:
        return {"ok": False, "exists": True, "target": str(target), "error": "files exist — allow overwriting to replace them"}
    if dry_run:
        return {"ok": True, "dry_run": True, "target": str(target), "files": [f"TowerTrainer_{icao}.sct", f"TowerTrainer_{icao}.ese", f"TowerTrainer_{icao}.asr", f"TowerTrainer {icao}.prf"],
                "procs": bool(procs and (procs.get("sids") or procs.get("stars"))), "buildings": len((osm or {}).get("buildings", []))}
    paths = sector.write_package(apt, target, procs, osm, callsign=callsign, es_dir=target)
    log(f"sector files for {icao} written to {target}")
    return {"ok": True, "target": str(target), **paths, "procs": bool(procs and (procs.get("sids") or procs.get("stars"))), "buildings": len((osm or {}).get("buildings", []))}


def desktop_shortcut(target: str, name: str, args: str = "", dry_run: bool = False) -> dict:
    """A Windows .lnk on the desktop (PowerShell / WScript.Shell); elsewhere a .desktop-style text launcher."""
    desktop = Path.home() / "Desktop"
    link = desktop / f"{name}.lnk"
    if dry_run:
        return {"ok": True, "dry_run": True, "link": str(link)}
    if platform.system() != "Windows":
        p = desktop / f"{name}.command"
        p.write_text(f"#!/bin/sh\n\"{target}\" {args}\n", "utf-8")
        os.chmod(p, 0o755)
        log(f"launcher {p}")
        return {"ok": True, "link": str(p)}
    ps = ("$s = (New-Object -ComObject WScript.Shell).CreateShortcut(%s); $s.TargetPath = %s; $s.Arguments = %s; $s.WorkingDirectory = %s; $s.Save()"
          % (_ps(str(link)), _ps(target), _ps(args), _ps(str(Path(target).parent))))
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True, timeout=60)
        ok = r.returncode == 0 and link.exists()
        log(f"shortcut {link}: {'ok' if ok else r.stderr.strip()[:200]}")
        return {"ok": ok, "link": str(link), "error": "" if ok else r.stderr.strip()[:300]}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "link": str(link), "error": str(e)}


def _ps(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


# ---------------------------------------------------------------- X-Plane, Navigraph, XRadio
def xplane_install_files() -> list:
    cands = []
    la = os.environ.get("LOCALAPPDATA")
    if la:
        cands.append(Path(la) / "x-plane_install_12.txt")
    home = Path.home()
    cands += [home / "Library" / "Preferences" / "x-plane_install_12.txt", home / ".x-plane" / "x-plane_install_12.txt"]
    return [c for c in cands if c.exists()]


def steam_libraries() -> list:
    libs = []
    for base in (os.environ.get("PROGRAMFILES(X86)", ""), os.environ.get("PROGRAMFILES", ""), str(Path.home() / ".steam" / "steam"), str(Path.home() / "Library" / "Application Support" / "Steam")):
        if not base:
            continue
        steam = Path(base) / "Steam" if "Steam" not in base else Path(base)
        vdf = steam / "steamapps" / "libraryfolders.vdf"
        if steam.exists():
            libs.append(steam)
        if vdf.exists():
            for m in re.finditer(r'"path"\s+"([^"]+)"', vdf.read_text("utf-8", "replace")):
                libs.append(Path(m.group(1).replace("\\\\", "\\")))
    return libs


def xplane_status(extra: str = "") -> dict:
    found = []
    for f in xplane_install_files():
        for line in f.read_text("utf-8", "replace").splitlines():
            p = line.strip()
            if p and Path(p).exists():
                found.append({"path": p, "source": "installer"})
    for lib in steam_libraries():
        p = lib / "steamapps" / "common" / "X-Plane 12"
        if p.exists():
            found.append({"path": str(p), "source": "steam"})
    if extra and Path(extra).exists():
        found.insert(0, {"path": extra, "source": "typed"})
    seen, uniq = set(), []
    for f in found:
        key = os.path.normcase(os.path.abspath(f["path"]))
        if key not in seen:
            seen.add(key)
            f.update(xplane_folder_info(f["path"]))
            uniq.append(f)
    return {"installs": uniq}


def xplane_folder_info(path: str) -> dict:
    p = Path(path)
    plugins = p / "Resources" / "plugins"
    xr = plugins / "XRadio"
    marker = xr / "TowerTrainer-installed.txt"
    return {"valid": (p / "Resources").exists() and (p / "Custom Data").exists() or (p / "Resources" / "plugins").exists(),
            "navigraph": navigraph_status(p), "xradio": {"installed": xr.exists(), "path": str(xr), "version": marker.read_text("utf-8").strip() if marker.exists() else ("unknown" if xr.exists() else ""),
                                                           "xpl": [x.name for x in xr.rglob("*.xpl")] if xr.exists() else []},
            "settings": str(p / "Output" / "preferences" / "xradio.cfg")}


def navigraph_status(xp_dir: str | Path) -> dict:
    cd = Path(xp_dir) / "Custom Data"
    info = {"present": cd.exists(), "cycle": "", "valid_from": "", "valid_to": "", "outdated": None}
    ci = cd / "cycle_info.txt"
    if ci.exists():
        txt = ci.read_text("utf-8", "replace")
        m = re.search(r"AIRAC cycle\s*:\s*(\d{4})", txt)
        if m:
            info["cycle"] = m.group(1)
        m = re.search(r"Valid \(from/to\)\s*:\s*([0-9A-Z/-]+)\s*-\s*([0-9A-Z/-]+)", txt)
        if m:
            info["valid_from"], info["valid_to"] = m.group(1), m.group(2)
        if info["cycle"]:
            yy, nn = int(info["cycle"][:2]), int(info["cycle"][2:])
            now = time.gmtime()
            cur = (now.tm_year % 100) * 100 + min(13, (now.tm_yday // 28) + 1)
            info["outdated"] = (yy * 100 + nn) < cur - 1
    info["files"] = [f.name for f in cd.glob("earth_*.dat")] if cd.exists() else []
    return info


def xradio_latest(timeout: float = 8) -> dict:
    try:
        with urllib.request.urlopen(urllib.request.Request(XRADIO_RELEASES, headers=UA), timeout=timeout) as r:
            j = json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
    assets = [a for a in j.get("assets", []) if a.get("name", "").lower().endswith(".zip")]
    assets.sort(key=lambda a: ("all" not in a["name"].lower(), "source" in a["name"].lower()))
    return {"ok": True, "tag": j.get("tag_name", ""), "name": j.get("name", ""), "zip": assets[0]["browser_download_url"] if assets else "", "zip_name": assets[0]["name"] if assets else "",
            "page": j.get("html_url", ""), "published": j.get("published_at", "")}


def install_xradio(xp_dir: str, source: str, tag: str = "", backup: bool = True, dry_run: bool = False) -> dict:
    """Install or update the XRadio plugin from a release zip (URL or local file) into <X-Plane>/Resources/plugins/XRadio.
    The zip must contain an XRadio/ folder (the way the releases are built). The old folder is kept as XRadio.backup-<time>."""
    xp = Path(xp_dir)
    plugins = xp / "Resources" / "plugins"
    if not plugins.exists():
        return {"ok": False, "error": f"{plugins} does not exist — is this the X-Plane folder?"}
    target = plugins / "XRadio"
    if dry_run:
        return {"ok": True, "dry_run": True, "target": str(target), "backup": str(target) + ".backup-<time>" if target.exists() and backup else "", "source": source}
    tmp = Path(tempfile.mkdtemp(prefix="tt-xradio-"))
    try:
        zp = tmp / "xradio.zip"
        if re.match(r"^https?://", source):
            log(f"download {source}")
            with urllib.request.urlopen(urllib.request.Request(source, headers=UA), timeout=120) as r, open(zp, "wb") as f:
                shutil.copyfileobj(r, f)
        else:
            shutil.copyfile(source, zp)
        if not zipfile.is_zipfile(zp):
            return {"ok": False, "error": "the download is not a zip file"}
        ext = tmp / "x"
        with zipfile.ZipFile(zp) as z:
            names = z.namelist()
            if any(n.startswith("/") or ".." in Path(n).parts for n in names):
                return {"ok": False, "error": "unsafe paths in the zip"}
            z.extractall(ext)
        roots = [p for p in ext.rglob("XRadio") if p.is_dir() and (any(p.rglob("*.xpl")) or (p / "win_x64").exists())]
        if not roots:
            roots = [p.parent for p in ext.rglob("*.xpl")]
            roots = [r for r in roots if r.name in ("win_x64", "mac_x64", "lin_x64")]
            roots = [r.parent for r in roots]
        if not roots:
            return {"ok": False, "error": "no XRadio plugin folder (with .xpl files) inside the zip"}
        src = roots[0]
        bak = ""
        if target.exists():
            if backup:
                bak = str(target) + time.strftime(".backup-%Y%m%d-%H%M%S")
                shutil.move(str(target), bak)
            else:
                shutil.rmtree(target)
        shutil.copytree(src, target)
        (target / "TowerTrainer-installed.txt").write_text((tag or Path(source).name) + "\n", "utf-8")
        log(f"XRadio installed to {target} from {source}{' (backup ' + bak + ')' if bak else ''}")
        return {"ok": True, "target": str(target), "backup": bak, "xpl": [x.name for x in target.rglob("*.xpl")], "tag": tag}
    except Exception as e:  # noqa: BLE001
        log(f"XRadio install failed: {e}")
        return {"ok": False, "error": str(e)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


XR_KEYS = {"host", "port", "callsign", "actype", "password", "showai", "aimax", "shareweather", "followweather", "atccue", "autoconnect", "simbriefuser"}


def xradio_settings(xp_dir: str, values: dict, dry_run: bool = False) -> dict:
    """Write keys into <X-Plane>/Output/preferences/xradio.cfg (the plugin's own "key = value" file), keeping the rest."""
    cfg = Path(xp_dir) / "Output" / "preferences" / "xradio.cfg"
    vals = {k: str(v) for k, v in values.items() if k in XR_KEYS}
    if not vals:
        return {"ok": False, "error": "nothing to set"}
    lines = cfg.read_text("utf-8", "replace").splitlines() if cfg.exists() else ["# XRadio configuration"]
    out, done = [], set()
    for l in lines:
        m = re.match(r"\s*([a-z0-9_]+)\s*=", l)
        if m and m.group(1) in vals:
            out.append(f"{m.group(1)} = {vals[m.group(1)]}")
            done.add(m.group(1))
        else:
            out.append(l)
    for k, v in vals.items():
        if k not in done:
            out.append(f"{k} = {v}")
    if dry_run:
        return {"ok": True, "dry_run": True, "file": str(cfg), "set": vals, "exists": cfg.exists()}
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text("\n".join(out) + "\n", "utf-8")
    log(f"xradio.cfg updated: {', '.join(sorted(vals))}")
    return {"ok": True, "file": str(cfg), "set": vals}


# ---------------------------------------------------------------- the status the wizard page opens with
def status(xplane_extra: str = "", es_docs: str = "", cache_dir: str | Path | None = None) -> dict:
    cache = Path(cache_dir) if cache_dir else ROOT / "cache"
    cached = sorted(p.stem for p in cache.glob("????.json")) if cache.exists() else []
    return {"python": python_info(), "packages": packages(), "euroscope": euroscope_status(es_docs or None), "xplane": xplane_status(xplane_extra),
            "cached": cached, "root": str(ROOT), "log": str(LOG), "os": platform.system()}
