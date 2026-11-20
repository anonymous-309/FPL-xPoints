import gzip, json, sys, statistics as st
from datetime import datetime as D
src = open("fpl_xpoints.py").read()
i = src.index("INJURY_DAYS = ["); j = src.index("def injury_days"); k = src.index("    return INJURY_DAYS_DEFAULT", j)
exec(src[i:k + len("    return INJURY_DAYS_DEFAULT")])
d = json.loads(gzip.decompress(open("archive/injuries/soccerway_players.json.gz", "rb").read()))
ps = d["players"]; print("players", len(ps), "with rows", sum(1 for p in ps if p["injuries"]), "clubs", len({c for p in ps for c in p["clubs"]}))
lo, hi = D(2024, 8, 1), D(2026, 6, 1)
by = {}
for p in ps:
    for r in p["injuries"]:
        if not r["until"]: continue
        a, b = D.strptime(r["from"], "%d.%m.%Y"), D.strptime(r["until"], "%d.%m.%Y")
        if not (lo <= a < hi): continue
        days = (b - a).days
        mdays, label = injury_days(r["injury"])
        by.setdefault(label, []).append((days, mdays, r["injury"]))
tot = []
print(f"{'type (our label)':22s} {'n':>4s} {'ours':>5s} {'median':>6s} {'p25':>4s} {'p75':>4s} {'mean':>5s}  MAE-ours  MAE-median")
for label, v in sorted(by.items(), key=lambda x: -len(x[1])):
    ds = sorted(x[0] for x in v); ours = v[0][1]; med = st.median(ds)
    q = lambda f: ds[int(f * (len(ds) - 1))]
    print(f"{label:22s} {len(ds):4d} {ours:5d} {med:6.0f} {q(.25):4d} {q(.75):4d} {st.mean(ds):5.0f}  {st.mean(abs(x - ours) for x in ds):7.1f}  {st.mean(abs(x - med) for x in ds):7.1f}")
    tot += [(x[0], x[1]) for x in v]
print("all", len(tot), "median days", st.median(t[0] for t in tot), "MAE ours", round(st.mean(abs(a - b) for a, b in tot), 1))
import collections; print(collections.Counter(x[2] for x in by.get("an injury", [])).most_common(12))
