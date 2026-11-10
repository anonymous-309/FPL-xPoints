"""Transfer planner: the transfers that maximise expected points over the next gameweeks for an FPL team.

Reads the predictions the site build wrote (data.json) and the team from the FPL API, then solves a
mixed-integer programme over the horizon:
- squad of 15 (2 GK, 5 DEF, 5 MID, 3 FWD), at most 3 per club, within the bank and selling prices;
- each gameweek a starting 11 (1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD) and a captain, whose points count twice;
- free transfers: +1 each gameweek up to 5, every transfer beyond them costs 4 points.
Bench players count a little (BENCH_WEIGHT) for auto-subs. No chips are planned and prices do not change.

    python planner.py --site _site --ids 11081
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import lil_matrix

from fpl_xpoints import _api

HORIZON = 8
HIT = 4.0
MAX_FT = 5
BENCH_WEIGHT = 0.1       # share of a bench player's points counted, for auto-subs
TRANSFER_COST = 0.2      # small cost per transfer so it does not churn for nothing
DOMINATED = 1  # a player beaten on points by this many times his position's squad size, at no higher price, is dropped
SQUAD = {"GK": 2, "DEF": 5, "MID": 5, "FWD": 3}
XI = {"GK": (1, 1), "DEF": (3, 5), "MID": (2, 5), "FWD": (1, 3)}
POS = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}


def free_transfers(history: dict) -> int:
    """Free transfers for the next gameweek: 1 after GW1, +1 a gameweek up to 5; transfers use them,
    a wildcard or free hit keeps them."""
    chips = {c["event"]: c["name"] for c in history.get("chips", [])}
    ft = 1
    for e in history["current"]:
        if e["event"] == 1:
            continue
        used = 0 if chips.get(e["event"]) in ("wildcard", "freehit") else e["event_transfers"]
        ft = min(MAX_FT, max(ft - used, 0) + 1)
    return ft


def selling_prices(squad: list[int], elements: dict, transfers: list[dict]) -> dict[int, float]:
    """Selling price per player: half the rise since he was bought (rounded down to 0.1), the full fall."""
    bought = {}
    for t in sorted(transfers, key=lambda t: t["time"]):
        bought[t["element_in"]] = t["element_in_cost"]
    out = {}
    for e in squad:
        now = elements[e]["now_cost"]
        paid = bought.get(e, now - elements[e].get("cost_change_start", 0))
        out[e] = (paid + (now - paid) // 2 if now > paid else now) / 10
    return out


def load_team(entry: int, cache: Path) -> dict:
    boot = _api("bootstrap-static/", cache, False)
    elements = {e["id"]: e for e in boot["elements"]}
    history = _api(f"entry/{entry}/history/", cache, False)
    info = _api(f"entry/{entry}/", cache, False)
    played = [e for e in history["current"]]
    if not played:
        raise SystemExit(f"Team {entry} has not played a gameweek yet")
    last = played[-1]["event"]
    chips = {c["event"]: c["name"] for c in history.get("chips", [])}
    pick_gw = last - 1 if chips.get(last) == "freehit" and last > 1 else last  # a free hit squad reverts
    picks = _api(f"entry/{entry}/event/{pick_gw}/picks/", cache, False)
    squad = [p["element"] for p in picks["picks"]]
    transfers = _api(f"entry/{entry}/transfers/", cache, False)
    return {
        "entry": entry, "name": info.get("name", ""), "manager": f'{info.get("player_first_name", "")} {info.get("player_last_name", "")}'.strip(),
        "lastGw": last, "bank": played[-1]["bank"] / 10, "ft": free_transfers(history),
        "squad": squad, "selling": selling_prices(squad, elements, transfers),
        "codes": {e: elements[e]["code"] for e in squad}, "elements": elements,
        "chipsUsed": sorted({c["name"] for c in history.get("chips", [])}),
    }


def plan(team: dict, data: dict, horizon: int = HORIZON, time_limit: float = 240) -> dict:
    gws = data["gws"][:horizon]
    by_pid = {p["id"]: p for p in data["players"]}
    owned_pids = []
    for e in team["squad"]:
        pid = f'c{team["codes"][e]}'
        if pid not in by_pid:  # left the league or no prediction: keep him with 0 points
            el = team["elements"][e]
            by_pid[pid] = {"id": pid, "name": el["web_name"], "team": "", "position": POS[el["element_type"]], "price": el["now_cost"] / 10, "byGw": {}}
        owned_pids.append(pid)
    pts = lambda p: [round(p["byGw"].get(str(g), {}).get("xpts", 0.0), 3) for g in gws]
    # Candidates: owned players, and anyone not beaten by many players who score more for no more money.
    pool = set(owned_pids)
    for pos_, k in SQUAD.items():
        cands = sorted(((p["price"], -sum(pts(p)), p["id"]) for p in data["players"] if p["position"] == pos_))
        best = []  # points of cheaper-or-equal players seen so far, highest first, capped
        for price, neg, pid in cands:
            if sum(1 for b in best if b > -neg) < DOMINATED * k and -neg > 0:
                pool.add(pid)
            best = sorted(best + [-neg], reverse=True)[: DOMINATED * k]
    P = sorted(pool)
    idx = {pid: i for i, pid in enumerate(P)}
    n, T = len(P), len(gws)
    xp = np.array([pts(by_pid[pid]) for pid in P])  # n x T
    pos = [by_pid[pid]["position"] for pid in P]
    club = [by_pid[pid]["team"] for pid in P]
    owned = np.zeros(n)
    owned[[idx[pid] for pid in owned_pids]] = 1
    sell_price = {f'c{team["codes"][e]}': v for e, v in team["selling"].items()}
    buy = np.array([by_pid[pid]["price"] for pid in P])
    sell = np.array([sell_price.get(pid, by_pid[pid]["price"]) for pid in P])

    # variable layout: per gameweek t, blocks x, y, c, b, s (each n), then n_t, u_t, h_t, f_t, bank_t
    per = 5 * n + 5
    def v(t, kind, i=0):
        return t * per + {"x": 0, "y": 1, "c": 2, "b": 3, "s": 4}[kind] * n + i if kind in "xycbs" else t * per + 5 * n + {"n": 0, "u": 1, "h": 2, "f": 3, "bank": 4}[kind]
    nv = per * T
    obj = np.zeros(nv)
    lo, hi = np.zeros(nv), np.ones(nv)
    integ = np.ones(nv)
    rows, lb, ub = [], [], []
    A = lil_matrix((40 * T + 4 * n * T + 50, nv))
    r = 0
    def add(coefs: dict, low: float, high: float):
        nonlocal r
        for k, val in coefs.items():
            A[r, k] = A[r, k] + val
        lb.append(low)
        ub.append(high)
        r += 1

    for t in range(T):
        for i in range(n):
            # points: starters, captain double, a little for the bench (x - y)
            obj[v(t, "y", i)] -= xp[i, t] * (1 - BENCH_WEIGHT)
            obj[v(t, "x", i)] -= xp[i, t] * BENCH_WEIGHT
            obj[v(t, "c", i)] -= xp[i, t]
            obj[v(t, "b", i)] += TRANSFER_COST
            # squad continuity: x_t - x_{t-1} - b + s = 0
            coefs = {v(t, "x", i): 1, v(t, "b", i): -1, v(t, "s", i): 1}
            if t > 0:
                coefs[v(t - 1, "x", i)] = -1
                add(coefs, 0, 0)
            else:
                add(coefs, owned[i], owned[i])
            add({v(t, "y", i): 1, v(t, "x", i): -1}, -np.inf, 0)
            add({v(t, "c", i): 1, v(t, "y", i): -1}, -np.inf, 0)
            add({v(t, "b", i): 1, v(t, "s", i): 1}, -np.inf, 1)
        add({v(t, "x", i): 1 for i in range(n)}, 15, 15)
        add({v(t, "y", i): 1 for i in range(n)}, 11, 11)
        add({v(t, "c", i): 1 for i in range(n)}, 1, 1)
        for p_, k in SQUAD.items():
            add({v(t, "x", i): 1 for i in range(n) if pos[i] == p_}, k, k)
            add({v(t, "y", i): 1 for i in range(n) if pos[i] == p_}, *XI[p_])
        for cl in set(club):
            if cl:
                add({v(t, "x", i): 1 for i in range(n) if club[i] == cl}, -np.inf, 3)
        # money: bank_t = bank_{t-1} + sales - purchases
        coefs = {v(t, "bank"): 1, **{v(t, "s", i): -sell[i] for i in range(n)}}
        for i in range(n):
            coefs[v(t, "b", i)] = buy[i]
        if t > 0:
            coefs[v(t - 1, "bank")] = -1
            add(coefs, 0, 0)
        else:
            add(coefs, team["bank"], team["bank"])
        # transfers: n_t = buys; free used u_t <= n_t, f_t; hits h_t >= n_t - u_t; f_{t+1} <= f_t - u_t + 1
        add({v(t, "n"): 1, **{v(t, "b", i): -1 for i in range(n)}}, 0, 0)
        add({v(t, "u"): 1, v(t, "n"): -1}, -np.inf, 0)
        add({v(t, "u"): 1, v(t, "f"): -1}, -np.inf, 0)
        add({v(t, "h"): 1, v(t, "n"): -1, v(t, "u"): 1}, 0, np.inf)
        if t == 0:
            add({v(t, "f"): 1}, team["ft"], team["ft"])
        else:
            add({v(t, "f"): 1, v(t - 1, "f"): -1, v(t - 1, "u"): 1}, -np.inf, 1)
        obj[v(t, "h")] += HIT
        for k, top in (("n", 15), ("u", MAX_FT), ("h", 15), ("f", MAX_FT)):
            hi[v(t, k)] = top
        lo[v(t, "bank")], hi[v(t, "bank")], integ[v(t, "bank")] = 0, 200, 0

    A = A[:r].tocsr()
    res = milp(obj, constraints=LinearConstraint(A, lb, ub), integrality=integ, bounds=Bounds(lo, hi),
               options={"time_limit": time_limit, "mip_rel_gap": 0.01, "disp": False})
    if res.x is None:
        raise SystemExit(f"No plan found: {res.message}")
    z = np.round(res.x).astype(float)
    z[[v(t, "bank") for t in range(T)]] = res.x[[v(t, "bank") for t in range(T)]]

    def player(i, t=None):
        p = by_pid[P[i]]
        out = {"id": P[i], "name": p["name"], "team": p["team"], "position": p["position"], "price": float(buy[i])}
        if t is not None:
            out["xpts"] = round(float(xp[i, t]), 2)
            d = p["byGw"].get(str(gws[t]))
            out["opp"] = d["opp"] if d else []
        return out

    order = {"GK": 0, "DEF": 1, "MID": 2, "FWD": 3}
    weeks, total, ft = [], 0.0, team["ft"]
    for t in range(T):
        squad = [i for i in range(n) if z[v(t, "x", i)] > 0.5]
        xi = [i for i in squad if z[v(t, "y", i)] > 0.5]
        cap = next(i for i in xi if z[v(t, "c", i)] > 0.5)
        bench = sorted((i for i in squad if i not in xi), key=lambda i: (pos[i] != "GK", -xp[i, t]))
        moves = int(sum(z[v(t, "b", i)] for i in range(n)))
        hits, ft_now = max(moves - ft, 0), ft  # FPL's rule replayed on the chosen transfers
        ft = min(MAX_FT, max(ft - moves, 0) + 1)
        pts_t = float(sum(xp[i, t] for i in xi) + xp[cap, t]) - HIT * hits
        total += pts_t
        weeks.append({
            "gw": gws[t], "freeTransfers": ft_now, "hits": hits, "bank": round(float(z[v(t, "bank")]), 1),
            "out": [player(i, t) | {"sell": float(sell[i])} for i in range(n) if z[v(t, "s", i)] > 0.5],
            "in": [player(i, t) for i in range(n) if z[v(t, "b", i)] > 0.5],
            "xi": [player(i, t) for i in sorted(xi, key=lambda i: (order[pos[i]], -xp[i, t]))],
            "bench": [player(i, t) for i in bench], "captain": P[cap], "xpts": round(pts_t, 2),
        })
    # the same squad all the way, best 11 and captain each week, for comparison
    hold = 0.0
    for t in range(T):
        sq = [idx[pid] for pid in owned_pids]
        best = best_xi(sq, pos, xp[:, t])
        hold += sum(xp[i, t] for i in best) + max(xp[i, t] for i in best)
    return {"entry": team["entry"], "name": team["name"], "manager": team["manager"], "lastGw": team["lastGw"],
            "bank": team["bank"], "ft": team["ft"], "chipsUsed": team["chipsUsed"], "gws": gws,
            "current": [player(idx[pid]) | {"sell": sell_price.get(pid)} for pid in sorted(owned_pids, key=lambda pid: (order[by_pid[pid]["position"]], -sum(pts(by_pid[pid]))))],
            "weeks": weeks, "planXpts": round(total, 1), "holdXpts": round(hold, 1),
            "status": res.message, "gap": None if res.mip_gap is None else round(float(res.mip_gap), 4)}


def best_xi(squad: list[int], pos: list[str], pts: np.ndarray) -> list[int]:
    """Highest scoring legal 11 from a 15-man squad."""
    best, best_pts = [], -1e9
    for d in range(3, 6):
        for m in range(2, 6):
            f = 10 - d - m
            if not 1 <= f <= 3:
                continue
            pick = []
            for p_, k in (("GK", 1), ("DEF", d), ("MID", m), ("FWD", f)):
                pick += sorted((i for i in squad if pos[i] == p_), key=lambda i: -pts[i])[:k]
            s = sum(pts[i] for i in pick)
            if len(pick) == 11 and s > best_pts:
                best, best_pts = pick, s
    return best


def ids_from(arg: list[str]) -> list[int]:
    """IDs given directly, or read from a file (one per line, # comments allowed)."""
    out = []
    for a in arg:
        p = Path(a)
        lines = p.read_text().splitlines() if p.exists() else [a]
        out += [int(x.split("#")[0]) for x in lines if x.split("#")[0].strip()]
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", type=Path, default=Path("_site"), help="site folder with data.json; plans go to plans/<id>.json")
    ap.add_argument("--ids", nargs="+", required=True, help="team IDs, or a file listing them")
    ap.add_argument("--time-limit", type=float, default=300, help="seconds per team")
    ap.add_argument("--horizon", type=int, default=HORIZON)
    ap.add_argument("--data-dir", type=Path, default=Path("fpl_data"))
    a = ap.parse_args()
    data = json.loads((a.site / "data.json").read_text())
    out = a.site / "plans"
    out.mkdir(exist_ok=True)
    for entry in ids_from(a.ids):
        try:
            result = plan(load_team(entry, a.data_dir / "api_cache"), data, a.horizon, a.time_limit)
        except (SystemExit, Exception) as e:  # one bad team must not stop the others
            print(f"Team {entry}: no plan ({e})")
            continue
        result["updatedAt"] = data.get("updatedAt")
        (out / f"{entry}.json").write_text(json.dumps(result, ensure_ascii=False))
        print(f"\n=== Plan for {entry} {result['name']} ({result['manager']}): {result['planXpts']} xPts vs {result['holdXpts']} holding, "
              f"bank {result['bank']}, {result['ft']} free transfers, {result['status']} gap {result['gap']} ===")
        for w in result["weeks"]:
            moves = ", ".join(f'{o["name"]} -> {i["name"]}' for o, i in zip(w["out"], w["in"])) or "no transfer"
            cap = next(p["name"] for p in w["xi"] if p["id"] == w["captain"])
            print(f'GW{w["gw"]}: {moves}; FT {w["freeTransfers"]}, hits {w["hits"]}, bank {w["bank"]}; captain {cap}; {w["xpts"]} xPts')


if __name__ == "__main__":
    main()
