"""Team data for the Planner page.

The browser cannot read the FPL API (it blocks other sites), so the site build reads each team listed in
planner_ids.txt and writes what the planner needs to plans/<id>.json: the squad with selling prices, bank, free
transfers and the chips still available. The plan itself (transfers, chips, captain) is worked out in the browser,
so the viewer can choose chip weeks and how many gameweeks to plan.

    python planner.py --site _site --ids planner_ids.txt
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from fpl_xpoints import _api

MAX_FT = 5
POS = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
CHIP_NAMES = {"wildcard": "Wildcard", "freehit": "Free Hit", "bboost": "Bench Boost", "3xc": "Triple Captain"}


def free_transfers(history: dict, log: list[str] | None = None) -> int:
    """Free transfers for the next gameweek: 1 after GW1, +1 a gameweek up to 5, less the transfers made.
    A wildcard or free hit week keeps the saved ones but adds none. log, if given, gets one line per gameweek."""
    chips = {c["event"]: c["name"] for c in history.get("chips", [])}
    ft = 1
    for e in history["current"]:
        if e["event"] == 1:
            continue
        chip = chips.get(e["event"])
        before = ft
        if chip not in ("wildcard", "freehit"):
            ft = min(MAX_FT, max(ft - e["event_transfers"], 0) + 1)
        if log is not None:
            log.append(f'GW{e["event"]}: {before} FT, {e["event_transfers"]} transfers{" (" + chip + ")" if chip else ""}, cost {e.get("event_transfers_cost", 0)} -> {ft} FT next')
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


def chips_available(boot: dict, used: list[dict], next_gw: int) -> list[dict]:
    """Chips not yet played in their window, from the next gameweek on. FPL lists each chip with the gameweeks it can
    be played in (from 2025-26 every chip comes twice, once per half of the season)."""
    defs = [c for c in boot.get("chips", []) if c.get("name") in CHIP_NAMES]
    if not defs:  # older API: one of each for the season
        defs = [{"name": n, "start_event": 1, "stop_event": 38} for n in CHIP_NAMES]
    out = []
    for c in defs:
        start, stop = int(c.get("start_event") or 1), int(c.get("stop_event") or 38)
        if stop < next_gw:
            continue
        if any(u["name"] == c["name"] and start <= u["event"] <= stop for u in used):
            continue
        out.append({"name": c["name"], "label": CHIP_NAMES[c["name"]], "from": max(start, next_gw), "to": stop})
    return sorted(out, key=lambda c: (list(CHIP_NAMES).index(c["name"]), c["from"]))


def load_team(entry: int, cache: Path) -> dict:
    boot = _api("bootstrap-static/", cache, False)
    elements = {e["id"]: e for e in boot["elements"]}
    teams = {t["id"]: t["short_name"] for t in boot["teams"]}
    history = _api(f"entry/{entry}/history/", cache, False)
    info = _api(f"entry/{entry}/", cache, False)
    played = list(history["current"])
    if not played:
        raise SystemExit(f"Team {entry} has not played a gameweek yet")
    last = played[-1]["event"]
    used = [{"name": c["name"], "event": c["event"]} for c in history.get("chips", [])]
    chips = {c["event"]: c["name"] for c in used}
    pick_gw = last - 1 if chips.get(last) == "freehit" and last > 1 else last  # a free hit squad reverts
    picks = _api(f"entry/{entry}/event/{pick_gw}/picks/", cache, False)
    squad = [p["element"] for p in picks["picks"]]
    transfers = _api(f"entry/{entry}/transfers/", cache, False)
    log: list[str] = []
    ft = free_transfers(history, log)
    bank = played[-1]["bank"] / 10
    # Transfers already made for the coming gameweek: FPL lists them straight away, the picks only after the deadline.
    pending = [t for t in sorted(transfers, key=lambda t: t["time"]) if t["event"] > last]
    selling = selling_prices(squad, elements, transfers)
    made = []
    for t in pending:
        if t["element_out"] in squad:
            squad[squad.index(t["element_out"])] = t["element_in"]
            selling.pop(t["element_out"], None)
            selling[t["element_in"]] = t["element_in_cost"] / 10
            bank += (t["element_out_cost"] - t["element_in_cost"]) / 10
            made.append(f'{elements[t["element_out"]]["web_name"]} -> {elements[t["element_in"]]["web_name"]}')
    if pending:
        ft = max(ft - len(pending), 0)
        log.append(f"Already made for GW{last + 1}: {', '.join(made)}; {ft} FT left")
    print(f"Team {entry} free transfers:\n  " + "\n  ".join(log))
    return {
        "entry": entry, "name": info.get("name", ""),
        "manager": f'{info.get("player_first_name", "")} {info.get("player_last_name", "")}'.strip(),
        "lastGw": last, "bank": round(bank, 1), "ft": ft, "madeAlready": made,
        "squad": [{"id": f'c{elements[e]["code"]}', "name": elements[e]["web_name"], "team": teams[elements[e]["team"]],
                   "position": POS[elements[e]["element_type"]], "price": elements[e]["now_cost"] / 10, "sell": selling[e]} for e in squad],
        "chipsUsed": used, "chipsAvailable": chips_available(boot, used, last + 1),
    }


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
    ap.add_argument("--site", type=Path, default=Path("_site"), help="site folder with data.json; teams go to plans/<id>.json")
    ap.add_argument("--ids", nargs="+", required=True, help="team IDs, or a file listing them")
    ap.add_argument("--data-dir", type=Path, default=Path("fpl_data"))
    a = ap.parse_args()
    data = json.loads((a.site / "data.json").read_text())
    out = a.site / "plans"
    out.mkdir(exist_ok=True)
    for entry in ids_from(a.ids):
        try:
            team = load_team(entry, a.data_dir / "api_cache")
        except (SystemExit, Exception) as e:  # one bad team must not stop the others
            print(f"Team {entry}: no team data ({e})")
            continue
        team["updatedAt"] = data.get("updatedAt")
        (out / f"{entry}.json").write_text(json.dumps(team, ensure_ascii=False))
        print(f"Team {entry} {team['name']}: bank {team['bank']}, {team['ft']} FT, chips left: "
              + ", ".join(f'{c["label"]} GW{c["from"]}-{c["to"]}' for c in team["chipsAvailable"]))


if __name__ == "__main__":
    main()
