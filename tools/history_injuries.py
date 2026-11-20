"""One-off: save who FotMob listed as unavailable (injured, ill, suspended...) for every Premier League match of
past seasons, with each match's date, to archive/injuries/fotmob_<season>.json.gz, for testing the minutes formula.

Usage: python tools/history_injuries.py 2024/2025 2025/2026"""
import gzip
import json
import sys
import time
from pathlib import Path

import requests

OUT = Path("archive/injuries")
OUT.mkdir(parents=True, exist_ok=True)
S = requests.Session()
S.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
                  "Accept": "application/json, text/plain, */*", "Accept-Language": "en-GB,en;q=0.9", "Referer": "https://www.fotmob.com/"})
API = "https://www.fotmob.com/api/data"


def get(path, **params):
    for attempt in range(4):
        try:
            r = S.get(f"{API}/{path}", params=params, timeout=25)
            if r.status_code == 200:
                return r.json()
            print(f"  {r.status_code} {path} {params}")
            if r.status_code in (401, 403, 404):
                return None
        except Exception as e:  # network trouble: try again
            print(f"  {type(e).__name__} {path}")
        time.sleep(2 + attempt * 4)
    return None


def season(name):
    lg = get("leagues", id=47, ccode3="GBR", season=name)
    if not lg:
        print(f"{name}: league not read")
        return None
    matches = (lg.get("fixtures") or {}).get("allMatches") or []
    out = {"season": name, "source": "FotMob matchDetails lineup.unavailable", "matches": []}
    for m in matches:
        if not (m.get("status") or {}).get("finished"):
            continue
        d = get("matchDetails", matchId=m["id"])
        if d is None:
            print(f"{name}: match details refused after {len(out['matches'])} matches")
            break
        lineup = (d.get("content") or {}).get("lineup") or {}
        side = lambda k: [{"id": p.get("id"), "name": p.get("name"), "unavailability": p.get("unavailability")} for p in (lineup.get(k) or {}).get("unavailable", [])]
        out["matches"].append({"round": int(m.get("round") or 0), "id": m["id"], "utcTime": (m.get("status") or {}).get("utcTime"),
                               "home": m["home"]["name"], "away": m["away"]["name"],
                               "homeUnavailable": side("homeTeam"), "awayUnavailable": side("awayTeam")})
        time.sleep(0.5)
    n = sum(len(x["homeUnavailable"]) + len(x["awayUnavailable"]) for x in out["matches"])
    print(f"{name}: {len(out['matches'])} matches, {n} unavailable entries")
    return out


if __name__ == "__main__":
    for name in sys.argv[1:]:
        res = season(name)
        if res and res["matches"]:
            path = OUT / f"fotmob_{name.replace('/20', '-').replace('/', '-')}.json.gz"
            path.write_bytes(gzip.compress(json.dumps(res, ensure_ascii=False).encode()))
            print(f"saved {path}")
