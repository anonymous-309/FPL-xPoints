"""One-off: add the GW1-9 absences read from Sofascore (absences_raw/sofascore.txt) to the admin absences
(admin_injuries.json). A gameweek counts only if the player really had 0 minutes in it, both for players listed as
missing and for those listed as doubtful. Consecutive gameweeks become one entry; gameweeks an existing entry
already covers are skipped. Each new entry is marked "Sofascore" in its note."""
import json
import re
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import requests

TEAM = {"AFC Bournemouth": "Bournemouth", "Brighton & Hove Albion": "Brighton", "Manchester City": "Man City", "Manchester United": "Man Utd",
        "Tottenham Hotspur": "Spurs", "Nottingham Forest": "Nott'm Forest", "Newcastle United": "Newcastle", "Leeds United": "Leeds",
        "Coventry City": "Coventry", "Hull City": "Hull", "Ipswich Town": "Ipswich", "Liverpool FC": "Liverpool"}
POS = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z ]", "", s.replace("-", " ")).strip()


boot = requests.get("https://fantasy.premierleague.com/api/bootstrap-static/", timeout=30).json()
teams = {t["id"]: t for t in boot["teams"]}
team_id = {t["name"]: t["id"] for t in boot["teams"]}
players = boot["elements"]
full = lambda p: norm(f'{p["first_name"]} {p["second_name"]}')


def find(name, team):
    """The FPL player: same name in that team first, then the only one of that name in the league (transfers)."""
    n = norm(name)
    tid = team_id.get(TEAM.get(team, team))
    tests = (lambda p: full(p) == n, lambda p: norm(p["web_name"]) == n,
             lambda p: set(n.split()) <= set(full(p).split()),
             lambda p: n.split()[-1] == norm(p["second_name"]).split()[-1] and full(p).startswith(n.split()[0][:3]))
    for pool in ([p for p in players if p["team"] == tid], players):
        for test in tests:
            hit = [p for p in pool if test(p)]
            if len(hit) == 1:
                return hit[0]
    return None


rows = [l.split("|") for l in Path("absences_raw/sofascore.txt").read_text().splitlines() if l and not l.startswith("#")]
want, missed = {}, []
for name, team, kind, m, d in rows:
    p = find(name, team)
    if not p:
        missed.append(f"{name} ({team})")
        continue
    w = want.setdefault((p["id"], kind), {"p": p, "gws": set()})
    w["gws"] |= {int(x) for x in (m.split(",") if m else []) + (d.split(",") if d else [])}

minutes = {}
for pid in {k[0] for k in want}:
    h = requests.get(f"https://fantasy.premierleague.com/api/element-summary/{pid}/", timeout=30).json()["history"]
    per = {}
    for g in h:
        per[g["round"]] = per.get(g["round"], 0) + g["minutes"]
    minutes[pid] = per
    time.sleep(0.2)

path = Path("admin_injuries.json")
admin = json.loads(path.read_text())


def covered(pid, gw):
    return any(x["pid"] == pid and int(x["startGw"]) <= gw and (x.get("endGw") is None or int(x["endGw"]) >= gw) for x in admin["manual"])


added, played = 0, []
for (eid, kind), w in sorted(want.items(), key=lambda kv: kv[1]["p"]["web_name"]):
    p = w["p"]
    pid = f'c{p["code"]}'
    gws = []
    for gw in sorted(w["gws"]):
        mins = minutes[eid].get(gw)
        if mins is None:  # no match that gameweek
            continue
        if mins > 0:
            played.append(f'{p["web_name"]} GW{gw} {mins}\'')
            continue
        if not covered(pid, gw):
            gws.append(gw)
    runs, start = [], None
    for a, b in zip(gws, gws[1:] + [None]):
        start = a if start is None else start
        if b != a + 1:
            runs.append((start, a))
            start = None
    for s, e in runs:
        admin["manual"].append({"id": f"{pid}-sofascore-GW{s}", "pid": pid, "name": p["web_name"], "team": teams[p["team"]]["short_name"],
                                "position": POS[p["element_type"]], "type": kind, "startGw": s, "endGw": e, "note": "Sofascore",
                                "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        added += 1
        print(f'{p["web_name"]:20} {teams[p["team"]]["short_name"]} {kind:10} GW{s}' + (f"-{e}" if e != s else ""))
path.write_text(json.dumps(admin, indent=1, ensure_ascii=False) + "\n")
print(f"Added {added} absences.")
print("Listed but played (left out): " + "; ".join(played))
print("Not matched to an FPL player: " + "; ".join(missed))
