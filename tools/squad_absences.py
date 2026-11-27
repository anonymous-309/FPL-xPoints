"""Who was missing from each Premier League match, from the FotMob archive (archive/fotmob/<season>.json.gz):
a club's player who was in one of its matchday squads that season but not in this one (not a starter, not a
substitute) missed it. The reason is FotMob's own list where it has him (injury, suspension, international duty),
else "not in squad" (injury FotMob did not list, illness, left out, or not yet signed / already gone).
Usage: python tools/squad_absences.py [season] [player name part ...]"""
import gzip, json, sys
from collections import defaultdict
from pathlib import Path

season = sys.argv[1] if len(sys.argv) > 1 else "2025-26"
names = [n.lower() for n in sys.argv[2:]]
store = json.loads(gzip.open(Path("archive/fotmob") / f"{season}.json.gz", "rt", encoding="utf-8").read())
matches = sorted(((int(m.get("round") or 0), mid, m) for mid, m in store.items() if m.get("lineup")), key=lambda x: (x[0], x[1]))
print(f"{season}: {len(matches)} matches with line-ups of {len(store)}")

# each club's matches in order, and each player's squad status per match: S starter, B bench (came on), U unused, - missing
club_matches = defaultdict(list)
for rnd, mid, m in matches:
    for side in ("home", "away"):
        club_matches[m[side]].append((rnd, mid, m, side))
status, names_of, why = defaultdict(dict), {}, {}
for club, ms in club_matches.items():
    for rnd, mid, m, side in ms:
        lu = m["lineup"][side]
        for pid, nm in lu["starters"]:
            status[(club, pid)][mid] = "S"; names_of[pid] = nm
        for pid, nm, on in lu["subs"]:
            status[(club, pid)][mid] = "B" if on else "U"; names_of[pid] = nm
        for u in (m.get("unavailable") or {}).get(side, []):
            why[(mid, u[0])] = u[2] or "other"

counts = defaultdict(int)
rows = []
for (club, pid), seen in status.items():
    ms = club_matches[club]
    idx = [i for i, (_, mid, _, _) in enumerate(ms) if mid in seen]
    first, last = min(idx), max(idx)  # only between his first and last squad of the season (signed late / sold)
    for i in range(first, last + 1):
        rnd, mid, m, side = ms[i]
        if mid in seen:
            continue
        r = why.get((mid, pid), "not in squad")
        counts[r] += 1
        rows.append((club, names_of[pid], rnd, r))
print("Missing from a matchday squad (between his first and last squad of the season): " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda x: -x[1])))
listed = sum(1 for k in why)
print(f"FotMob's missing list: {listed} entries; of them in no squad: {sum(1 for c, n, r, w in rows if w != 'not in squad')}")
for club, nm, rnd, r in rows:
    if names and any(n in nm.lower() for n in names):
        print(f"  {nm} ({club}) GW{rnd}: {r}")
