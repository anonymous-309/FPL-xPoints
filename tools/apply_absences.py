"""One-off: turn the GW1-9 absences read from FotMob (absences_raw/fotmob.json) into absences added by the admin
(admin_injuries.json), one entry per run of consecutive gameweeks, so those matches leave the minutes formula.
Entries already there are not added twice; each new one is marked "FotMob" in its note so it can be deleted."""
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import requests

TEAM = {"AFC Bournemouth": "Bournemouth", "Brighton & Hove Albion": "Brighton", "Manchester City": "Man City", "Manchester United": "Man Utd",
        "Tottenham Hotspur": "Spurs", "Nottingham Forest": "Nott'm Forest", "Newcastle United": "Newcastle", "Leeds United": "Leeds",
        "Coventry City": "Coventry", "Hull City": "Hull", "Ipswich Town": "Ipswich", "West Ham United": "West Ham",
        "Wolverhampton Wanderers": "Wolves", "Leicester City": "Leicester"}
KIND = {"injury": "Injury", "suspension": "Suspended"}
POS = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z ]", "", s.replace("-", " ")).strip()


boot = requests.get("https://fantasy.premierleague.com/api/bootstrap-static/", timeout=30).json()
fixtures = requests.get("https://fantasy.premierleague.com/api/fixtures/", timeout=30).json()
teams = {t["id"]: t for t in boot["teams"]}
team_id = {t["name"]: t["id"] for t in boot["teams"]}
gw_of = {(f["team_h"], f["team_a"]): f["event"] for f in fixtures if f.get("event")}
players = boot["elements"]


def fpl_team(name):
    n = TEAM.get(name, name)
    if n in team_id:
        return team_id[n]
    for t in boot["teams"]:
        if norm(t["name"]) in norm(name) or norm(name).startswith(norm(t["name"])):
            return t["id"]
    return None


def find(u, tid):
    full, last, first = norm(u.get("name")), norm(u.get("lastName")), norm(u.get("firstName"))
    pool = [p for p in players if p["team"] == tid]
    for test in (lambda p: norm(f'{p["first_name"]} {p["second_name"]}') == full,
                 lambda p: norm(p["web_name"]) == full,
                 lambda p: last and norm(p["second_name"]) == last and (not first or norm(p["first_name"]).startswith(first[:3])),
                 lambda p: last and (norm(p["second_name"]).endswith(last) or norm(p["web_name"]) == last),
                 lambda p: full and set(full.split()) <= set(norm(f'{p["first_name"]} {p["second_name"]}').split())):
        hit = [p for p in pool if test(p)]
        if len(hit) == 1:
            return hit[0]
    return None


raw = json.loads(Path("absences_raw/fotmob.json").read_text())
seen, missed = {}, []
for m in raw["matches"]:
    h, a = fpl_team(m["home"]), fpl_team(m["away"])
    gw = gw_of.get((h, a), m["round"])
    for side, tid in (("homeUnavailable", h), ("awayUnavailable", a)):
        for u in m[side]:
            p = find(u, tid)
            if not p:
                missed.append(f'GW{gw} {u.get("name")} ({m["home" if side.startswith("home") else "away"]})')
                continue
            kind = KIND.get((u.get("unavailability") or {}).get("type"), "Other")
            seen.setdefault((p["code"], kind), {"p": p, "gws": set()})["gws"].add(gw)

path = Path("admin_injuries.json")
admin = json.loads(path.read_text()) if path.exists() else {"manual": [], "startOverrides": {}}
def covered(pid, s, e):
    """True if an entry already there covers any of these gameweeks for this player."""
    return any(x["pid"] == pid and int(x["startGw"]) <= e and (x.get("endGw") is None or int(x["endGw"]) >= s) for x in admin["manual"])
added = 0
for (code, kind), v in sorted(seen.items(), key=lambda kv: kv[1]["p"]["web_name"]):
    p, gws = v["p"], sorted(v["gws"])
    runs, start = [], gws[0]
    for a, b in zip(gws, gws[1:] + [None]):
        if b != a + 1:
            runs.append((start, a))
            start = b
    for s, e in runs:
        pid = f"c{code}"
        if covered(pid, s, e):
            continue
        admin["manual"].append({"id": f"{pid}-fotmob-GW{s}", "pid": pid, "name": p["web_name"], "team": teams[p["team"]]["short_name"],
                                "position": POS[p["element_type"]], "type": kind, "startGw": s, "endGw": e, "note": "FotMob",
                                "at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        added += 1
        print(f'{p["web_name"]:20} {teams[p["team"]]["short_name"]} {kind:10} GW{s}' + (f"-{e}" if e != s else ""))
path.write_text(json.dumps(admin, indent=1, ensure_ascii=False) + "\n")
print(f"Added {added} absences for {len(seen)} player/reason pairs.")
if missed:
    print("Not matched to an FPL player: " + "; ".join(missed))
