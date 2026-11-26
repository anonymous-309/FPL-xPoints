"""Keep FotMob's per-player match stats for every Premier League match of a season, in case FotMob stops being
readable: archive/fotmob/<season>.json.gz = {match id: {"round", "home", "away", "players": [[name, team id, {stat key: value}]]}}.
Only new finished matches are read (the file is kept between runs). Usage: python tools/fotmob_archive.py 2025-26 [2026-27 ...]"""
import gzip, json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import fpl_xpoints as F

OUT = Path("archive/fotmob")


def season_matches(season: str) -> list:
    start, end = season.split("-")
    lg = F._fotmob_get("leagues", {"id": F.FOTMOB_LEAGUE, "ccode3": "GBR", "season": f"{start}/{start[:2]}{end}"})
    out = []
    def walk(o):
        if isinstance(o, dict):
            if (o.get("status") or {}).get("finished") and o.get("id") and o.get("home"):
                out.append(o)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(lg)
    return list({str(m["id"]): m for m in out}.values())


def player_rows(d: dict) -> list:
    rows = []
    for p in ((d.get("content") or {}).get("playerStats") or {}).values():
        stats = {}
        for grp in p.get("stats") or []:
            for title, v in (grp.get("stats") or {}).items():
                st = (v or {}).get("stat") or {}
                key = (v or {}).get("key") or title
                if isinstance(st.get("value"), (int, float)):
                    stats[key] = st["value"]
                    if st.get("total") is not None:
                        stats[key + "_total"] = st["total"]
        rows.append([p.get("name"), p.get("teamId"), stats])
    return rows


def run(season: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{season}.json.gz"
    store = json.loads(gzip.open(path, "rt", encoding="utf-8").read()) if path.exists() else {}
    matches = season_matches(season)
    new = 0
    for m in matches:
        mid = str(m["id"])
        if mid in store:
            continue
        try:
            d = F._fotmob_get("matchDetails", {"matchId": mid})
        except Exception as e:
            print(f"{season} match {mid} not read ({e})")
            continue
        store[mid] = {"round": int(m.get("round") or 0), "home": (m.get("home") or {}).get("name"), "away": (m.get("away") or {}).get("name"),
                      "homeId": (m.get("home") or {}).get("id"), "players": player_rows(d)}
        new += 1
        time.sleep(0.4)
    if new:
        with gzip.open(path, "wt", encoding="utf-8") as f:
            json.dump(store, f, ensure_ascii=False, separators=(",", ":"))
    print(f"FotMob archive {season}: {len(store)} matches kept ({new} new) of {len(matches)} finished")


if __name__ == "__main__":
    for s in sys.argv[1:] or [F.CURRENT_SEASON]:
        run(s)
