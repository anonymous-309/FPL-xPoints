"""Fill the FH & WC log for past gameweeks from the replays (archive/<season>/replay/gwN: the site rebuilt as it was
before each deadline), at the prices of each gameweek (FPL's history), then real points as for the live log."""
import gzip, json, sys, time
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, "tools")
import fhwc as F

SEASON = "2026-27"
FROM, TO = int(sys.argv[1]), int(sys.argv[2])
boot = F.get("bootstrap-static/")
id_of = {f"c{e['code']}": e["id"] for e in boot["elements"]}
price = {}  # (code id, gw) -> price that gameweek
for n, (cid, eid) in enumerate(id_of.items()):
    try:
        for r in F.get(f"element-summary/{eid}/")["history"]:
            price.setdefault((cid, r["round"]), r["value"] / 10)
    except Exception as e:
        print("no history", eid, e)
    time.sleep(0.05)
    if n % 200 == 0:
        print(n, flush=True)
def at(cid, g, now):
    for k in [g] + [g + d for dd in range(1, 6) for d in (-dd, dd)]:
        if (cid, k) in price:
            return price[(cid, k)]
    return now
replay = lambda g: json.loads(gzip.open(f"archive/{SEASON}/replay/gw{g}/data.json.gz").read())
log = json.loads(F.LOG.read_text()) if F.LOG.exists() else {"entries": {}}
for g in range(FROM, TO + 1):
    d = replay(g)
    gws = d["gws"]
    players = [{"id": p["id"], "pos": p["position"], "team": p["team"], "price": at(p["id"], g, float(p["price"])),
                "xp": {str(w): float(((p["byGw"].get(str(w)) or {}).get("xpts")) or 0) for w in gws[:F.WC_WEEKS]}} for p in d["players"] if p["id"] in id_of]
    def pool(weeks):
        out = []
        for pos, k in F.POOL.items():
            out += sorted((p for p in players if p["pos"] == pos), key=lambda p: -sum(p["xp"].get(str(w), 0) for w in weeks))[:k]
        return out
    fh_squad, fh_weeks = F.solve(pool([g]), [g])
    wc_squad, wc_weeks = F.solve(pool(gws[:F.WC_WEEKS]), gws[:F.WC_WEEKS])
    # later weeks of the Wildcard: the 11 picked again from the replay before that week (when there is one)
    for w in wc_weeks[1:]:
        try:
            dw = replay(w["gw"])
        except FileNotFoundError:
            continue  # not replayed: the live log re-picks it before its deadline
        info = {p["id"]: {"pos": p["position"], "xp": {str(w["gw"]): float(((p["byGw"].get(str(w["gw"])) or {}).get("xpts")) or 0)}} for p in dw["players"]}
        new = F.lineup(wc_squad["squad"], info, w["gw"])
        w["xptsPlan"] = w["xpts"]
        w.update({k: new[k] for k in ("xi", "bench", "cap", "vice", "xpts", "xp")})
        w["picked"] = "replay"; w["locked"] = True
    log["entries"][str(g)] = {"gw": g, "saved": "replay", "replay": True, "locked": True, "deadline": None,
                              "fh": {**fh_squad, "week": fh_weeks[0]}, "wc": {**wc_squad, "weeks": wc_weeks}}
    print(f"GW{g}: FH {fh_weeks[0]['xpts']:.1f} (£{fh_squad['cost']}m), WC {sum(w['xpts'] for w in wc_weeks):.1f} (£{wc_squad['cost']}m)", flush=True)
F.LOG.write_text(json.dumps(log, ensure_ascii=False, indent=0))
