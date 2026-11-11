"""One-off: save who was missing from each Premier League match of GW1-9 this season, as published by
Sofascore and FotMob, so absences before the injury log started can be left out of the minutes formula.
Writes the raw answers to absences_raw/; matching them to FPL players is done separately."""
import json
import sys
import time
from pathlib import Path

import requests

ROUNDS = range(1, 10)
OUT = Path("absences_raw")
OUT.mkdir(exist_ok=True)
S = requests.Session()
S.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
                  "Accept": "application/json, text/plain, */*", "Accept-Language": "en-GB,en;q=0.9"})


def get(url, **kw):
    for attempt in range(3):
        try:
            r = S.get(url, timeout=20, **kw)
            if r.status_code == 200:
                return r.json()
            print(f"  {r.status_code} {url}")
            if r.status_code in (401, 403, 404):
                return None
        except Exception as e:  # network trouble: try again
            print(f"  {type(e).__name__} {url}")
        time.sleep(2 + attempt * 3)
    return None


def sofascore():
    base = "https://api.sofascore.com/api/v1"
    seasons = get(f"{base}/unique-tournament/17/seasons")
    if not seasons:
        S.headers.update({"Origin": "https://www.sofascore.com", "Referer": "https://www.sofascore.com/"})
        base = "https://www.sofascore.com/api/v1"
        seasons = get(f"{base}/unique-tournament/17/seasons")
    if not seasons:
        print("Sofascore: no answer")
        return None
    season = seasons["seasons"][0]
    print(f"Sofascore season {season.get('year')} id {season['id']}")
    out = {"season": season, "matches": []}
    for rnd in ROUNDS:
        ev = get(f"{base}/unique-tournament/17/season/{season['id']}/events/round/{rnd}") or {}
        for e in ev.get("events", []):
            if e.get("status", {}).get("type") != "finished":
                continue
            lu = get(f"{base}/event/{e['id']}/lineups") or {}
            out["matches"].append({"round": rnd, "id": e["id"], "home": e["homeTeam"]["name"], "away": e["awayTeam"]["name"],
                                   "start": e.get("startTimestamp"),
                                   "homeMissing": (lu.get("home") or {}).get("missingPlayers", []),
                                   "awayMissing": (lu.get("away") or {}).get("missingPlayers", []),
                                   "homePlayers": [p["player"]["name"] for p in (lu.get("home") or {}).get("players", [])],
                                   "awayPlayers": [p["player"]["name"] for p in (lu.get("away") or {}).get("players", [])]})
            time.sleep(0.6)
        print(f"Sofascore round {rnd}: {sum(m['round'] == rnd for m in out['matches'])} matches")
    return out


def fotmob():
    lg = get("https://www.fotmob.com/api/leagues", params={"id": 47, "ccode3": "GBR"})
    if not lg:
        print("FotMob: no answer")
        return None
    matches = (lg.get("fixtures") or {}).get("allMatches") or lg.get("matches", {}).get("allMatches") or []
    out = {"matches": []}
    for m in matches:
        rnd = int(m.get("round") or m.get("roundName") or 0)
        if rnd not in ROUNDS or not (m.get("status") or {}).get("finished"):
            continue
        d = get("https://www.fotmob.com/api/matchDetails", params={"matchId": m["id"]})
        if d is None:
            print("FotMob: match details refused")
            return out if out["matches"] else None
        lineup = (d.get("content") or {}).get("lineup") or {}
        out["matches"].append({"round": rnd, "id": m["id"], "home": m["home"]["name"], "away": m["away"]["name"],
                               "homeUnavailable": (lineup.get("homeTeam") or {}).get("unavailable", []),
                               "awayUnavailable": (lineup.get("awayTeam") or {}).get("unavailable", [])})
        time.sleep(0.6)
    print(f"FotMob: {len(out['matches'])} matches")
    return out


if __name__ == "__main__":
    got = 0
    for name, fn in [("sofascore", sofascore), ("fotmob", fotmob)]:
        try:
            res = fn()
        except Exception as e:
            print(f"{name} failed: {type(e).__name__}: {e}")
            res = None
        if res and res.get("matches"):
            (OUT / f"{name}.json").write_text(json.dumps(res, ensure_ascii=False, indent=0))
            n = sum(len(m.get("homeMissing", m.get("homeUnavailable", []))) + len(m.get("awayMissing", m.get("awayUnavailable", []))) for m in res["matches"])
            print(f"{name}: saved {len(res['matches'])} matches, {n} missing players")
            got += 1
    sys.exit(0 if got else 1)
