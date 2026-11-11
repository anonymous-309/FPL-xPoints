"""One-off: put the GW1-9 absences read from Sofascore and FotMob into the injury log (injury_log.json), the same
log the Injuries page shows, instead of the admin's hand-added list.

Only gameweeks where the player really had 0 minutes count. Consecutive gameweeks become one record. Records the
log already has (it starts in GW10-11) are not repeated. The Sofascore and FotMob entries are removed from
admin_injuries.json. Safe to run again: earlier records from this script are replaced."""
import json
import re
import time
import unicodedata
from pathlib import Path

import requests

SEASON = "2026-27"
TEAM = {"AFC Bournemouth": "Bournemouth", "Brighton & Hove Albion": "Brighton", "Manchester City": "Man City", "Manchester United": "Man Utd",
        "Tottenham Hotspur": "Spurs", "Nottingham Forest": "Nott'm Forest", "Newcastle United": "Newcastle", "Leeds United": "Leeds",
        "Coventry City": "Coventry", "Hull City": "Hull", "Ipswich Town": "Ipswich", "Liverpool FC": "Liverpool"}
POS = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
RANK = {"Suspended": 0, "Illness": 1, "Injury": 2, "Other": 3}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z ]", "", re.sub(r"[-.']", " ", s)).split())


boot = requests.get("https://fantasy.premierleague.com/api/bootstrap-static/", timeout=30).json()
teams = {t["id"]: t for t in boot["teams"]}
team_id = {t["name"]: t["id"] for t in boot["teams"]}
players = boot["elements"]
full = lambda p: norm(f'{p["first_name"]} {p["second_name"]}')


def find(name, team):
    n = norm(name)
    tid = team_id.get(TEAM.get(team, team))
    tests = (lambda p: full(p) == n, lambda p: norm(p["web_name"]) == n, lambda p: set(n.split()) <= set(full(p).split()),
             lambda p: n.split()[-1] == norm(p["second_name"]).split()[-1] and full(p).startswith(n.split()[0][:3]),
             lambda p: p["team"] == tid and set(norm(p["web_name"]).split()) <= set(n.split()),
             lambda p: p["team"] == tid and set(norm(p["second_name"]).split()) <= set(n.split()),
             lambda p: p["team"] == tid and bool(set(full(p).split()) & set(n.split()) - {"junior", "jr", "de", "da", "van", "der"}))
    for pool in ([p for p in players if p["team"] == tid], players):
        for test in tests:
            hit = [p for p in pool if test(p)]
            if len(hit) == 1:
                return hit[0]
    return None


# (player id, gameweek) -> (reason, source, detail)
listed, missed = {}, []
def add(p, gw, kind, source, detail=""):
    key = (p["id"], gw)
    if key not in listed or RANK[kind] < RANK[listed[key][0]]:
        listed[key] = (kind, source, detail)


for line in Path("absences_raw/sofascore.txt").read_text().splitlines():
    if not line or line.startswith("#"):
        continue
    name, team, kind, m, d = line.split("|")
    p = find(name, team)
    if not p:
        missed.append(name)
        continue
    for gw in [int(x) for x in (m.split(",") if m else []) + (d.split(",") if d else [])]:
        add(p, gw, kind, "Sofascore")
fm = json.loads(Path("absences_raw/fotmob.json").read_text())
for mt in fm["matches"]:
    for side in ("home", "away"):
        for u in mt[f"{side}Unavailable"]:
            p = find(u.get("name"), mt[side])
            if not p:
                missed.append(u.get("name"))
                continue
            kind = {"injury": "Injury", "suspension": "Suspended"}.get((u.get("unavailability") or {}).get("type"), "Other")
            add(p, mt["round"], kind, "FotMob")

minutes = {}
for eid in {k[0] for k in listed}:
    per = {}
    for g in requests.get(f"https://fantasy.premierleague.com/api/element-summary/{eid}/", timeout=30).json()["history"]:
        per[g["round"]] = per.get(g["round"], 0) + g["minutes"]
    minutes[eid] = per
    time.sleep(0.2)

log_path, admin_path = Path("injury_log.json"), Path("admin_injuries.json")
log = [r for r in json.loads(log_path.read_text()) if r.get("startFrom") != "history"]
admin = json.loads(admin_path.read_text())
admin["manual"] = [e for e in admin["manual"] if e.get("note") not in ("FotMob", "Sofascore")]


def in_log(pid, gw):
    return any(r["pid"] == pid and r.get("season") == SEASON and r["startGw"] <= gw and (not r.get("returnedGw") or gw < r["returnedGw"]) for r in log) \
        or any(e["pid"] == pid and int(e["startGw"]) <= gw and (e.get("endGw") is None or gw <= int(e["endGw"])) for e in admin["manual"])


by_player, played = {}, []
for (eid, gw), (kind, source, _) in listed.items():
    mins = minutes[eid].get(gw)
    if mins is None:
        continue
    if mins > 0:
        played.append(f"{eid} GW{gw}")
        continue
    by_player.setdefault(eid, []).append((gw, kind, source))

added = []
by_id = {p["id"]: p for p in players}
for eid, rows in by_player.items():
    p = by_id[eid]
    pid = f'c{p["code"]}'
    rows.sort()
    runs = []
    for gw, kind, source in rows:
        if in_log(pid, gw):
            continue
        if runs and runs[-1]["end"] == gw - 1 and runs[-1]["type"] == kind:
            runs[-1]["end"] = gw
            runs[-1]["sources"].add(source)
        else:
            runs.append({"start": gw, "end": gw, "type": kind, "sources": {source}})
    for r in runs:
        src = " and ".join(sorted(r["sources"]))
        added.append({"id": f"{pid}-{SEASON}-history-GW{r['start']}", "season": SEASON, "pid": pid, "name": p["web_name"],
                      "team": teams[p["team"]]["short_name"], "position": POS[p["element_type"]], "startGw": r["start"],
                      "startFrom": "history", "firstSeen": None, "status": "back", "returnedGw": r["end"] + 1, "updates": [],
                      "type": "Suspended" if r["type"] == "Suspended" else r["type"] if r["type"] != "Other" else "Unavailable",
                      "news": f"{r['type']}, GW{r['start']}" + (f"-{r['end']}" if r["end"] != r["start"] else "") + f" (from {src})",
                      "chance": None, "expectedReturnGw": None, "expectedReturnDate": None, "lastSeen": None})

log_path.write_text(json.dumps(log + sorted(added, key=lambda r: (r["startGw"], r["name"])), indent=1, ensure_ascii=False) + "\n")
admin_path.write_text(json.dumps(admin, indent=1, ensure_ascii=False) + "\n")
print(f"Added {len(added)} records to the injury log from {len(by_player)} players; {len(admin['manual'])} entries left in the admin list.")
from collections import Counter
print(Counter(r["type"] for r in added))
print(f"Listed but played, left out: {len(played)}. Not matched: {', '.join(sorted(set(missed)))}")
for name in sorted(set(missed)):
    toks = set(norm(name).split())
    near = [f'{p["first_name"]} {p["second_name"]} ({p["web_name"]}, {teams[p["team"]]["short_name"]})' for p in players if toks & set(full(p).split() + norm(p["web_name"]).split())]
    print(f"  {name}: FPL players with a shared name: {'; '.join(near[:6]) or 'none'}")
