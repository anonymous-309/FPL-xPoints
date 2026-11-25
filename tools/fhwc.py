"""Free Hit and Wildcard log: before each deadline, the best Free Hit squad for the next gameweek and the best
Wildcard squad for the next 5 gameweeks (budget 100.0m, today's prices, the site's xPoints), and after the matches
what those teams really scored (FPL points, automatic subs and vice-captain as in the game).

Run after `fpl_xpoints.py site --out _site`:  python tools/fhwc.py _site
Keeps fhwc_log.json in the repo and copies it into the site folder.
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp

LOG = Path("fhwc_log.json")
API = "https://fantasy.premierleague.com/api"
BUDGET = 100.0
WC_WEEKS = 5
POOL = {"GK": 12, "DEF": 40, "MID": 40, "FWD": 25}  # candidates per position, by xPoints over the weeks
SQUAD = {"GK": 2, "DEF": 5, "MID": 5, "FWD": 3}
XI_MIN = {"GK": 1, "DEF": 3, "MID": 2, "FWD": 1}
XI_MAX = {"GK": 1, "DEF": 5, "MID": 5, "FWD": 3}
# as the Planner counts a gameweek: starters 97% (keeper) / 95.5% (outfield), bench 28-12-5% and the reserve keeper 3%
BENCH_SLOTS, BENCH_GK, XI_OUT, XI_GK = [0.28, 0.12, 0.05], 0.03, 0.955, 0.97
BENCH_SEARCH = sum(BENCH_SLOTS) / 3


def get(path):
    for k in range(4):
        try:
            req = urllib.request.Request(f"{API}/{path}", headers={"User-Agent": "Mozilla/5.0"})
            return json.loads(urllib.request.urlopen(req, timeout=30).read())
        except Exception as e:  # retry
            err = e
            time.sleep(3 + 5 * k)
    raise err


def solve(players, weeks):
    """Best 15 (budget, 3 a club) and each week's 11 and captain. players: [{id, pos, team, price, xp: {gw: x}}]."""
    n, T = len(players), len(weeks)
    nv = n * (1 + 2 * T)  # x_i, then per week y_ti and c_ti
    X = lambda i: i
    Y = lambda t, i: n + t * 2 * n + i
    C = lambda t, i: n + t * 2 * n + n + i
    c = np.zeros(nv)
    for t, g in enumerate(weeks):
        for i, p in enumerate(players):
            xp = p["xp"].get(str(g), 0.0)
            keep = XI_GK if p["pos"] == "GK" else XI_OUT
            bench = BENCH_GK if p["pos"] == "GK" else BENCH_SEARCH
            c[X(i)] -= xp * bench
            c[Y(t, i)] -= xp * (keep - bench)
            c[C(t, i)] -= xp * keep
    rows, lo, hi = [], [], []
    def row(coef, a, b):
        r = np.zeros(nv)
        for j, v in coef:
            r[j] += v
        rows.append(r); lo.append(a); hi.append(b)
    for pos, k in SQUAD.items():
        row([(X(i), 1) for i, p in enumerate(players) if p["pos"] == pos], k, k)
    row([(X(i), p["price"]) for i, p in enumerate(players)], 0, BUDGET)
    for team in {p["team"] for p in players}:
        row([(X(i), 1) for i, p in enumerate(players) if p["team"] == team], 0, 3)
    for t in range(T):
        row([(Y(t, i), 1) for i in range(n)], 11, 11)
        row([(C(t, i), 1) for i in range(n)], 1, 1)
        for pos in SQUAD:
            row([(Y(t, i), 1) for i, p in enumerate(players) if p["pos"] == pos], XI_MIN[pos], XI_MAX[pos])
        for i in range(n):
            row([(Y(t, i), 1), (X(i), -1)], -np.inf, 0)
            row([(C(t, i), 1), (Y(t, i), -1)], -np.inf, 0)
    res = milp(c, constraints=LinearConstraint(np.array(rows), lo, hi), integrality=np.ones(nv), bounds=Bounds(0, 1),
               options={"time_limit": 240, "mip_rel_gap": 1e-4})
    v = np.round(res.x).astype(int)
    squad = [i for i in range(n) if v[X(i)]]
    out = []
    for t, g in enumerate(weeks):
        xp = lambda i: players[i]["xp"].get(str(g), 0.0)
        xi = [i for i in squad if v[Y(t, i)]]
        order = {"GK": 0, "DEF": 1, "MID": 2, "FWD": 3}
        xi.sort(key=lambda i: (order[players[i]["pos"]], -xp(i)))
        cap = max(xi, key=xp)
        vice = max((i for i in xi if i != cap), key=xp)
        rest = [i for i in squad if i not in xi]
        gk = [i for i in rest if players[i]["pos"] == "GK"]
        bench = gk + sorted((i for i in rest if players[i]["pos"] != "GK"), key=lambda i: -xp(i))
        exp = sum(xp(i) * (XI_GK if players[i]["pos"] == "GK" else XI_OUT) for i in xi) + xp(cap) * XI_OUT
        exp += sum(xp(i) * BENCH_GK for i in gk) + sum(xp(i) * w for i, w in zip(bench[1:], BENCH_SLOTS))
        out.append({"gw": g, "xi": [players[i]["id"] for i in xi], "bench": [players[i]["id"] for i in bench],
                    "cap": players[cap]["id"], "vice": players[vice]["id"], "xpts": round(exp, 2),
                    "xptsXi": round(sum(xp(i) for i in xi) + xp(cap), 2), "xp": {players[i]["id"]: round(xp(i), 2) for i in squad}})
    cost = round(sum(players[i]["price"] for i in squad), 1)
    return {"squad": [players[i]["id"] for i in squad], "cost": cost}, out


def lineup(squad, info, g):
    """Best 11 of a fixed 15 for gameweek g (at least 3 DEF, 2 MID, 1 FWD), captain and vice the two highest, bench in
    xPoints order; info: id -> {pos, xp: {gw: x}}."""
    xp = lambda i: info[i]["xp"].get(str(g), 0.0)
    pos = lambda i: info[i]["pos"]
    by = sorted(squad, key=lambda i: -xp(i))
    xi = [next(i for i in by if pos(i) == "GK")]
    for p, k in (("DEF", 3), ("MID", 2), ("FWD", 1)):
        xi += [i for i in by if pos(i) == p][:k]
    room = {"DEF": 5, "MID": 5, "FWD": 3}
    for i in by:
        if len(xi) < 11 and i not in xi and pos(i) != "GK" and sum(pos(x) == pos(i) for x in xi) < room[pos(i)]:
            xi.append(i)
    order = {"GK": 0, "DEF": 1, "MID": 2, "FWD": 3}
    xi.sort(key=lambda i: (order[pos(i)], -xp(i)))
    caps = sorted(xi, key=lambda i: -xp(i))
    rest = [i for i in by if i not in xi]
    bench = [i for i in rest if pos(i) == "GK"] + [i for i in rest if pos(i) != "GK"]
    exp = sum(xp(i) * (XI_GK if pos(i) == "GK" else XI_OUT) for i in xi) + xp(caps[0]) * XI_OUT
    exp += xp(bench[0]) * BENCH_GK + sum(xp(i) * w for i, w in zip(bench[1:], BENCH_SLOTS))
    return {"gw": g, "xi": xi, "bench": bench, "cap": caps[0], "vice": caps[1], "xpts": round(exp, 2),
            "xp": {i: round(xp(i), 2) for i in squad}}


def real_points(week, live, pos):
    """FPL points of a gameweek's team: starters who played, automatic subs in bench order (keeping a legal
    formation), captain double (the vice if the captain did not play)."""
    mins = lambda i: (live.get(i) or {}).get("minutes", 0)
    pts = lambda i: (live.get(i) or {}).get("total_points", 0)
    xi, bench = list(week["xi"]), list(week["bench"])
    on = [i for i in xi if mins(i) > 0]
    subs = []
    gk_out = [i for i in xi if pos[i] == "GK" and mins(i) == 0]
    if gk_out and bench and pos[bench[0]] == "GK" and mins(bench[0]) > 0:
        on.append(bench[0]); subs.append(bench[0])
    for i in [i for i in xi if pos[i] != "GK" and mins(i) == 0]:
        for b in bench[1:]:
            if b in subs or mins(b) == 0:
                continue
            trial = [x for x in on if pos[x] != "GK"] + [b]
            count = lambda p: sum(1 for x in trial if pos[x] == p)
            need = max(0, 3 - count("DEF")) + max(0, 2 - count("MID")) + max(0, 1 - count("FWD"))
            if len(trial) > 10 or need > 10 - len(trial):
                continue
            on.append(b); subs.append(b)
            break
    total = sum(pts(i) for i in on)
    capt = week["cap"] if mins(week["cap"]) > 0 else week["vice"] if mins(week["vice"]) > 0 else None
    if capt is not None:
        total += pts(capt)
    return {"pts": total, "subs": subs, "capt": capt}


def main(site):
    data = json.loads((Path(site) / "data.json").read_text())
    boot = get("bootstrap-static/")
    events = {e["id"]: e for e in boot["events"]}
    code_to_id = {f"c{e['code']}": e["id"] for e in boot["elements"]}
    log = json.loads(LOG.read_text()) if LOG.exists() else {"entries": {}}
    gws = data["gws"]
    nxt = gws[0]
    now = datetime.now(timezone.utc)
    deadline = datetime.fromisoformat(events[nxt]["deadline_time"].replace("Z", "+00:00"))
    names = {}
    import os
    final_run = os.environ.get("ARCHIVE_GW") == str(nxt)  # the run about 30 minutes before the deadline keeps the final teams
    locked = (log["entries"].get(str(nxt)) or {}).get("locked")
    if now < deadline and not locked:
        players = []
        for p in data["players"]:
            if p["id"] not in code_to_id:
                continue
            xp = {str(g): float(((p["byGw"].get(str(g)) or {}).get("xpts")) or 0) for g in gws[:WC_WEEKS]}
            players.append({"id": p["id"], "pos": p["position"], "team": p["team"], "price": float(p["price"]), "xp": xp})
        def pool(weeks):
            keep = []
            for pos, k in POOL.items():
                ps = sorted((p for p in players if p["pos"] == pos), key=lambda p: -sum(p["xp"].get(str(g), 0) for g in weeks))
                keep += ps[:k]
            return keep
        fh_players = pool([nxt])
        fh_squad, fh_weeks = solve(fh_players, [nxt])
        wc_w = gws[:WC_WEEKS]
        wc_players = pool(wc_w)
        wc_squad, wc_weeks = solve(wc_players, wc_w)
        log["entries"][str(nxt)] = {"gw": nxt, "saved": now.isoformat(timespec="minutes"), "deadline": events[nxt]["deadline_time"],
                                     "fh": {**fh_squad, "week": fh_weeks[0]}, "wc": {**wc_squad, "weeks": wc_weeks}, "locked": final_run}
        print(f"GW{nxt}: Free Hit {fh_weeks[0]['xpts']:.1f} xPts (£{fh_squad['cost']}m), Wildcard {sum(w['xpts'] for w in wc_weeks):.1f} over GW{wc_w[0]}-{wc_w[-1]} (£{wc_squad['cost']}m)")
    # Wildcard teams: before each of their later gameweeks, the same 15 re-picked (best 11, captain, bench) with the
    # xPoints of the day; the run before that deadline keeps it.
    if now < deadline:
        info = {p["id"]: {"pos": p["position"], "xp": {str(g): float(((p["byGw"].get(str(g)) or {}).get("xpts")) or 0) for g in gws[:1]}} for p in data["players"]}
        for key, e in log["entries"].items():
            for w in e["wc"]["weeks"]:
                if w["gw"] != nxt or w.get("locked"):
                    continue
                if not all(i in info for i in e["wc"]["squad"]):
                    continue
                new = lineup(e["wc"]["squad"], info, nxt)
                w.setdefault("xptsPlan", w["xpts"])  # what the week was worth on the Wildcard's own day
                w.update({k: new[k] for k in ("xi", "bench", "cap", "vice", "xpts", "xp")})
                w["picked"] = now.isoformat(timespec="minutes")
                w["locked"] = final_run
    # real points of every gameweek played so far (until FPL has checked the data)
    live_cache = {}
    def live(g):
        if g not in live_cache:
            live_cache[g] = {e["id"]: e["stats"] for e in get(f"event/{g}/live/")["elements"]}
        return live_cache[g]
    pos_of = {e["id"]: {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}[e["element_type"]] for e in boot["elements"]}
    for key, e in log["entries"].items():
        for part, weeks in (("fh", [e["fh"]["week"]]), ("wc", e["wc"]["weeks"])):
            for w in weeks:
                g = w["gw"]
                ev = events.get(g)
                if not ev or not (ev.get("finished") or ev.get("is_current") or ev.get("is_previous")) or w.get("final"):
                    continue
                if datetime.fromisoformat(ev["deadline_time"].replace("Z", "+00:00")) > now:
                    continue
                L = live(g)
                ids = lambda lst: [code_to_id.get(i) for i in lst]
                wk = {"xi": ids(w["xi"]), "bench": ids(w["bench"]), "cap": code_to_id.get(w["cap"]), "vice": code_to_id.get(w["vice"])}
                r = real_points(wk, L, pos_of)
                back = {v: k for k, v in code_to_id.items()}
                w["actual"] = r["pts"]
                w["playerPts"] = {back[i]: (L.get(i) or {}).get("total_points", 0) for i in wk["xi"] + wk["bench"] if i}
                w["playerMins"] = {back[i]: (L.get(i) or {}).get("minutes", 0) for i in wk["xi"] + wk["bench"] if i}
                w["subs"] = [back[i] for i in r["subs"]]
                w["final"] = bool(ev.get("finished") and ev.get("data_checked"))
    log["names"] = {p["id"]: {"name": p["name"], "team": p["team"], "pos": p["position"], "price": p["price"]} for p in data["players"]}
    LOG.write_text(json.dumps(log, ensure_ascii=False, indent=0))
    (Path(site) / "fhwc_log.json").write_text(json.dumps(log, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "_site")
