"""How right is the xMin formula? Tested on past seasons with FotMob's lists of unavailable players
(archive/injuries/fotmob_<season>.json.gz, from tools/history_injuries.py) as the injury log.

For every league match of a player in his club's squad, the formula's minutes before the match are compared with
the minutes he played:
  - Usual minutes: his last 5 counted matches weighted 5-4-3-2-1 (newest first); matches he missed through an
    absence FotMob listed, a yellow-card ban or the match he was sent off in are not counted.
  - Listed unavailable for the match: 0.
  - Back from an injury absence: the site's return rule (RETURN_RULES in fpl_xpoints.py) on his usual minutes.
Run after `python fpl_xpoints.py download`: python tools/xmin_backtest.py"""
import gzip
import json
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, ".")
import fpl_xpoints as F  # noqa: E402

SEASONS = {"2024-25": "archive/injuries/fotmob_2024-25.json.gz", "2025-26": "archive/injuries/fotmob_2025-26.json.gz"}
W = F.MINUTE_WEIGHTS


def norm(s):
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z ]", "", re.sub(r"[-.']", " ", s)).split())


def team_key(s):
    s = norm(s).replace("afc ", "").replace(" fc", "")
    alias = {"manchester city": "man city", "manchester united": "man utd", "tottenham hotspur": "spurs", "nottingham forest": "nottm forest",
             "brighton hove albion": "brighton", "wolverhampton wanderers": "wolves", "newcastle united": "newcastle", "west ham united": "west ham",
             "leicester city": "leicester", "ipswich town": "ipswich", "leeds united": "leeds", "sunderland": "sunderland", "burnley": "burnley"}
    return alias.get(s, s)


def find(name, rows):
    """FPL row for a FotMob name among one side's squad rows (full names), or None when unsure."""
    n = norm(name)
    tests = (lambda r: norm(r) == n,
             lambda r: norm(r).split()[-1:] == n.split()[-1:] and norm(r).split()[:1] == n.split()[:1],
             lambda r: set(n.split()) <= set(norm(r).split()),
             lambda r: n.split()[-1:] == norm(r).split()[-1:])
    for t in tests:
        hit = [i for i, r in rows if t(r)]
        if len(hit) == 1:
            return hit[0]
        if len(hit) > 1:
            return None
    return None


def main():
    seasons = F.HIST_SEASONS
    df = F.load_history(Path("fpl_data"), seasons)
    df = df[~df["future"] & df["minutes"].notna()].copy()
    df["absent"], df["absent_type"], df["absent_id"] = False, "", np.nan
    matched = unmatched = 0
    for season, path in SEASONS.items():
        data = json.loads(gzip.decompress(Path(path).read_bytes()))
        s = df[df["season"] == season]
        fx = s.groupby("fixture").agg(k=("kickoff_time", "first"), home=("team", lambda x: None)).reset_index()
        sides = s.groupby(["fixture", "was_home"])["team"].first().unstack()
        fx = s.drop_duplicates("fixture")[["fixture", "kickoff_time"]].merge(sides.rename(columns={1: "home", 0: "away"}).reset_index(), on="fixture")
        fx["hk"], fx["ak"] = fx["home"].map(team_key), fx["away"].map(team_key)
        for m in data["matches"]:
            t = pd.Timestamp(m["utcTime"]) if m.get("utcTime") else None
            hk, ak = team_key(m["home"]), team_key(m["away"])
            cand = fx[(fx["hk"].str.split().str[0] == hk.split()[0]) & (fx["ak"].str.split().str[0] == ak.split()[0])]
            if len(cand) != 1:
                unmatched += 1
                continue
            fixture = cand["fixture"].iloc[0]
            for side, home in (("homeUnavailable", 1), ("awayUnavailable", 0)):
                rows = s[(s["fixture"] == fixture) & (s["was_home"] == home)]
                pool = list(zip(rows.index, rows["name"]))
                for u in m[side]:
                    i = find(u["name"], pool)
                    if i is None:
                        unmatched += 1
                        continue
                    matched += 1
                    un = u.get("unavailability") or {}
                    df.loc[i, ["absent", "absent_type"]] = [True, un.get("type") or ""]
                    df.loc[i, "absent_id"] = un.get("injuryId", np.nan)
    print(f"FotMob unavailable entries matched to FPL players: {matched}, not matched: {unmatched}")
    # Soccerway injury spells (From / Until): out for a match inside a spell; a spell starting on the match day (when he
    # played) or within 2 days after it is an injury picked up in that match.
    df["fm_absent"] = df["absent"]
    sw = json.loads(gzip.decompress(Path("archive/injuries/soccerway_players.json.gz").read_bytes()))["players"]
    names = df.drop_duplicates("pid")[["pid", "name"]]
    tok = {pid: frozenset(norm(n).split()) for pid, n in zip(names["pid"], names["name"])}
    spells, ok = {}, 0
    for p in sw:
        t = frozenset(norm(p["slug"].replace("-", " ")).split())
        hit = [pid for pid, tk in tok.items() if tk == t] or [pid for pid, tk in tok.items() if t <= tk or tk <= t]
        if len(hit) != 1 or not p["injuries"]:
            continue
        ok += 1
        for r in p["injuries"]:
            a = pd.Timestamp(pd.to_datetime(r["from"], format="%d.%m.%Y"))
            b = pd.Timestamp(pd.to_datetime(r["until"], format="%d.%m.%Y")) if r["until"] else pd.Timestamp("2027-01-01")
            spells.setdefault(hit[0], []).append((a, b))
    print(f"Soccerway players matched to FPL: {ok} of {len(sw)}")
    kd = pd.to_datetime(df["kickoff_time"]).dt.tz_localize(None).dt.normalize()
    sw_out = np.zeros(len(df), bool); sw_in = np.zeros(len(df), bool)
    for n, (pid, k, m) in enumerate(zip(df["pid"], kd, df["minutes"])):
        for a, b in spells.get(pid, ()):
            if a < k < b or (a == k and m == 0):
                sw_out[n] = True
            elif m > 0 and k <= a <= k + pd.Timedelta(days=2):
                sw_in[n] = True
    df["sw_out"], df["sw_inmatch"] = sw_out, sw_in & ~sw_out
    new = df["sw_out"] & ~df["absent"]
    print(f"Matches out on Soccerway: {int(sw_out.sum())}, of them not listed by FotMob: {int(new.sum())}; injuries picked up in a match: {int(df['sw_inmatch'].sum())}")
    df.loc[new, ["absent", "absent_type"]] = [True, "injury"]

    # Usual minutes before each match, the formula's way
    df = df.sort_values(["pid", "kickoff_time", "fixture"])
    usual = np.full(len(df), np.nan)
    back = np.zeros(len(df), bool)  # first match after an injury absence
    gap = np.zeros(len(df))         # days since his previous counted match
    reds = df["red_cards"].fillna(0).to_numpy()
    ban = df["yellow_ban"].fillna(False).to_numpy()
    absent = df["absent"].to_numpy()
    atype = df["absent_type"].to_numpy()
    mins = df["minutes"].to_numpy(float)
    kick = df["kickoff_time"].to_numpy()
    rec = (df["hist_skip"].astype(bool) & (df["hist_ret"] < 1)).to_numpy() if "hist_ret" in df else np.zeros(len(df), bool)  # recovery matches under his usual
    prev, hist, was_out, red_ban, last_t = None, [], False, 0, None
    for i, k in enumerate(df["pid"].to_numpy()):
        if k != prev:
            prev, hist, was_out, red_ban, last_t = k, [], False, 0, None
        win = hist[::-1][:5]
        usual[i] = np.dot(win, W[:len(win)]) / W[:len(win)].sum() if win else np.nan
        back[i] = was_out and not absent[i]
        if absent[i]:
            was_out = was_out or atype[i] == "injury"
            continue
        if ban[i] or (red_ban > 0 and mins[i] == 0):
            red_ban = max(0, red_ban - 1)
            continue
        if reds[i] > 0:
            red_ban = 3
            was_out = False
            if win and mins[i] >= usual[i]:
                hist.append(mins[i])  # sent off after his usual minutes: counted, as on the site
            continue
        was_out = False
        if rec[i]:
            continue  # back from injury, under his usual minutes: recovery, left out (the site's rule)
        hist.append(mins[i])
    df["usual"], df["back"] = usual, back
    # Suspended: a yellow-card ban, or a match he missed after a red card (up to 3)
    susp = np.zeros(len(df), bool); prev, left = None, 0
    for i, k in enumerate(df["pid"].to_numpy()):
        if k != prev: prev, left = k, 0
        if ban[i]: susp[i] = True
        elif left > 0 and mins[i] == 0: susp[i] = True; left -= 1
        elif left > 0: left = 0
        if reds[i] > 0: left = 3
    df["susp"] = susp
    # Was he listed injured for his club's next league match? (marks an injury picked up in this match)
    nxt = df.groupby("pid")
    df["next_inj"] = (nxt["absent"].shift(-1).fillna(False).astype(bool) & (nxt["absent_type"].shift(-1).fillna("") == "injury"))
    df["next_mins"] = nxt["minutes"].shift(-1)
    ev = df[df["season"].isin(SEASONS) & df["usual"].notna()].copy()
    # Leave out players outside the picture (usual 0 and not playing): they would flatter every rule
    ev = ev[(ev["usual"] > 0) | (ev["minutes"] > 0)]
    ret = ev["hist_ret"].fillna(1.0) if "hist_ret" in ev else np.where(ev["back"], 0.5, 1.0)
    ev["pred"] = np.where(ev["absent"], 0.0, ev["usual"] * ret)  # back from injury: the site's return rule
    ev["pred_noinj"] = ev["usual"]  # no injury log: absent players predicted as usual

    def report(name, sub, col="pred"):
        e = sub[col] - sub["minutes"]
        print(f"  {name:44s} n={len(sub):6d}  MAE {e.abs().mean():5.1f}  bias {e.mean():+5.1f}  "
              f"predicted {sub[col].mean():5.1f} vs played {sub['minutes'].mean():5.1f}")

    print("\nAll player-matches (2024-25 and 2025-26)")
    report("formula with the injury log", ev)
    report("formula without it (absences counted as usual)", ev, "pred_noinj")
    print("\nBy situation")
    report("listed unavailable (predicted 0)", ev[ev["absent"]])
    played_absent = ev[ev["absent"] & (ev["minutes"] > 0)]
    print(f"  listed unavailable but played: {len(played_absent)} of {int(ev['absent'].sum())} ({len(played_absent) / max(1, ev['absent'].sum()):.1%})")
    report("not listed, normal match", ev[~ev["absent"] & ~ev["back"]])
    rb = ev[ev["back"]]
    print(f"\nFirst match back after an injury ({len(rb)} cases): played {rb['minutes'].mean():.1f} min on average, usual before {rb['usual'].mean():.1f}")
    for share, label in ((0.0, "0 (rest)"), (0.5, "half (site rule)"), (0.75, "three quarters"), (1.0, "full usual")):
        e = rb["usual"] * share - rb["minutes"]
        print(f"  predict {label:18s} MAE {e.abs().mean():5.1f}  bias {e.mean():+5.1f}")
    print(f"  share of usual actually played: median {np.median(rb['minutes'] / rb['usual'].clip(lower=1)):.2f}, mean {(rb['minutes'] / rb['usual'].clip(lower=1)).clip(upper=1.5).mean():.2f}; "
          f"0 minutes in {(rb['minutes'] == 0).mean():.0%}")
    print("\nBy usual minutes band (normal matches)")
    nm = ev[~ev["absent"] & ~ev["back"]]
    for lo, hi in ((0, 30), (30, 60), (60, 80), (80, 91)):
        report(f"usual {lo}-{hi}", nm[(nm["usual"] >= lo) & (nm["usual"] < hi)])
    print("\nBy position (normal matches)")
    for pos in ("GK", "DEF", "MID", "FWD"):
        report(pos, nm[nm["position"] == pos])

    # How long injuries last (FotMob listing): consecutive matches listed with an injury, days to the next match played
    sp = []
    for pid, g in df[df["season"].isin(SEASONS)].groupby("pid"):
        start = None
        for a, typ, t, m in zip(g["absent"], g["absent_type"], g["kickoff_time"], g["minutes"]):
            if a and typ == "injury":
                start = start or t
            elif start is not None:
                sp.append((t - start).days)
                start = None
    sp = np.array(sp)
    if len(sp):
        print(f"\nInjury spells (FotMob, first match missed to the match he was back for): {len(sp)}; days: median {np.median(sp):.0f}, "
              f"25% {np.percentile(sp, 25):.0f}, 75% {np.percentile(sp, 75):.0f}, 90% {np.percentile(sp, 90):.0f}")
    ev[["season", "GW", "name", "team", "position", "minutes", "starts", "red_cards", "yellow_ban", "susp", "fm_absent", "sw_out", "sw_inmatch", "next_inj", "next_mins", "usual", "absent", "absent_type", "back", "pred"]].to_csv("xmin_backtest_rows.csv", index=False)
    summary(pd.read_csv("xmin_backtest_rows.csv"))


def summary(rows, out="site/xmin_accuracy.json"):
    """The Accuracy page's xMin card: players on 60+ xMin, matches with a red card, a ban or an injury picked up in
    the match left out. `rows` is xmin_backtest_rows.csv."""
    e = rows[rows["pred"] >= 60]
    bad = (e["red_cards"] > 0) | e["susp"] | e["sw_inmatch"] | (e["next_inj"] & (e["minutes"] < 90))
    c = e[~bad]
    res = {"seasons": sorted(rows["season"].unique().tolist()), "removed": {"red": int((e["red_cards"] > 0).sum()), "ban": int(e["susp"].sum()),
           "injured_in_match": int((e["sw_inmatch"] | (e["next_inj"] & (e["minutes"] < 90))).sum())}, "bands": []}
    for lo, hi, lab in ((80, 91, "80–90"), (70, 80, "70–80"), (60, 70, "60–70"), (60, 91, "All 60+")):
        s = c[(c["pred"] >= lo) & (c["pred"] < hi)]
        er, m, st = s["pred"] - s["minutes"], s["minutes"], s[s["starts"] == 1]
        res["bands"].append({"band": lab, "n": len(s), "pred": round(s["pred"].mean(), 1), "real": round(m.mean(), 1), "bias": round(er.mean(), 1),
                             "mae": round(er.abs().mean(), 1), "within10": round((er.abs() <= 10).mean(), 3), "real60": round((m >= 60).mean(), 3),
                             "zero": round((m == 0).mean(), 3), "sub": round(((m > 0) & (m < 60)).mean(), 3), "p60_89": round(((m >= 60) & (m < 90)).mean(), 3),
                             "full": round((m >= 90).mean(), 3), "not_started": int((s["starts"] == 0).sum()),
                             "started_mae": round((st["pred"] - st["minutes"]).abs().mean(), 1), "started_bias": round((st["pred"] - st["minutes"]).mean(), 1)})
    top = c[c["pred"] >= 80]
    res["top_by_pos"] = {p: {"n": int((top["position"] == p).sum()), "not_started": int(((top["position"] == p) & (top["starts"] == 0)).sum())} for p in ("GK", "DEF", "MID", "FWD")}
    try:  # keep what other runs added (the by-gameweek bench table)
        old = json.loads(Path(out).read_text())
        res.update({k: v for k, v in old.items() if k not in res})
    except (OSError, ValueError):
        pass
    Path(out).write_text(json.dumps(res, ensure_ascii=False, indent=1))
    return res


if __name__ == "__main__" and "--summary" in sys.argv:
    summary(pd.read_csv(sys.argv[sys.argv.index("--summary") + 1]))
elif __name__ == "__main__":
    main()
