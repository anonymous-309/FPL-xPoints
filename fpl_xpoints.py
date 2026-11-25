#!/usr/bin/env python3
"""FPL expected-points model.

    xPts = P(1+ min) + P(60+ min)
           + xMin/90 * (clean sheet + goals + assists + bonus - goals conceded + saves + penalty saves
                        + DEFCON - cards - penalty misses - own goals)

Goal/assist/bonus rates are Poisson GLMs on log-features: the player's long-run
xG/xA per 90, recent form, finishing, own team attack, opponent defence and
home/away. xMin is AI Minute (see ai_minute), scaled down by FPL's injury or
suspension flag.
Every feature uses only gameweeks before the one being predicted.

Usage:
    python fpl_xpoints.py download
    python fpl_xpoints.py backtest
    python fpl_xpoints.py predict --horizon 5
    python fpl_xpoints.py site --out _site

Requires: pandas, numpy, scipy, scikit-learn.
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import poisson
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LogisticRegression, PoissonRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

HIST_SEASONS = ["2023-24", "2024-25", "2025-26"]
CURRENT_SEASON = "2026-27"
RAW = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"
API = "https://fantasy.premierleague.com/api"
CORE = "https://raw.githubusercontent.com/olbauday/FPL-Core-Insights/main/data"  # match stats incl. xGOT, from 2024-25
UA = {"User-Agent": "fpl-xpoints/1.0 (personal script)"}

POSITIONS = ["GK", "DEF", "MID", "FWD"]
GOAL_PTS = {"GK": 10, "DEF": 6, "MID": 5, "FWD": 4}
CS_PTS = {"GK": 4, "DEF": 4, "MID": 1, "FWD": 0}
DEFCON_THRESHOLD = {"DEF": 10, "MID": 12, "FWD": 12}
DEFCON_PTS = 2
PEN_SAVE_PTS = 5
PEN_MISS_PTS = -2
OWN_GOAL_PTS = -2

HL_LONG, HL_SHORT, HL_MIN_SHORT, HL_MIN_LONG, HL_TEAM = 12, 4, 2, 8, 12
K_PLAYER, K_SHORT, K_FINISH, K_TEAM, K_TEAM_GOALS, K_RED, K_PEN = 5.0, 2.0, 15.0, 4.0, 8.0, 40.0, 60.0
# Rare events need long memory and strong pull to the role average (rare-tune, log loss on 2025-26):
# (half-life in matches, latest matches used, k). Red cards: a player's own record did not beat the role average.
RARE_MEMORY = {"yc": (1e9, 114, 20.0), "og": (1e9, 114, 200.0), "ps": (24, 76, 400.0)}
# Penalty attempts of league-average misses added to a taker's own record. On 2025-26 (92 penalties, rare-tune)
# every finite k scored worse than the league rate alone, so a taker's own record is effectively off for now;
# lower this once a few more seasons of counted penalties exist.
K_PEN_MISS = 1e6
DC_PRIOR_DEFAULT = 8.0  # defensive actions per 90 before any are counted
PROMOTED_ATT, PROMOTED_DEF = 0.85, 1.15  # starting belief for newly promoted teams
LEAGUE_XG_FALLBACK = 1.35
EPS = 1e-3
TEAM_CARRY = 1.0   # share of a team's record kept when a new season starts
TEAM_WINDOW = 0    # if above 0, use only this many latest matches, equally weighted
MAX_BAN_MATCHES = 4
HIST_PEN_SHARE = {1: 0.85, 2: 0.12, 3: 0.03}  # share of team penalties by FPL order, used for past seasons
PEN_TAKE_ON_PITCH = 1.0  # the listed taker takes every penalty while he is on the pitch (being on it is already in xMin)
PEN_CONVERSION, PEN_XG = 0.79, 0.79  # a penalty is worth 0.79 xG (FotMob / Opta), so about 21% are missed or saved
PEN_SAVE_SHARE = 0.12  # share of penalties saved, used until penalties are counted
SET_PIECE_COLS = {"penalties_order": "pen_order", "direct_freekicks_order": "fk_order", "corners_and_indirect_freekicks_order": "corner_order"}
HL_FINISH, K_XGOT, K_FINISH_XG = 12, 8.0, 15.0  # finishing: same half-life as the rest, shrunk by xG volume
HISTORY_MATCHES = 38  # every decayed record uses only each player's or team's latest 38 matches
PEN_XGOT_SCORED, PEN_XGOT_MISSED = 0.95, 0.3   # rough xGOT of a scored and a missed penalty (FotMob rates each one by where it went)
HL_ROLE, ROLE_MIN_90S = 6, 3.0  # playing role from recent matches, needs about 270 recent minutes
K_VENUE = 6.0  # home or away record of a team, shrunk toward its overall record
# goals, xG, xGOT weights, and how many average xG each player's record is padded with (smaller = closer to a plain average)
GOAL_MODES = {"learned": (None, None, None, None), "equal": (1 / 3, 1 / 3, 1 / 3, 15.0), "g50": (0.5, 0.25, 0.25, 15.0), "xg40": (0.3, 0.4, 0.3, 15.0),
              "g50_k5": (0.5, 0.25, 0.25, 5.0), "g50_k2": (0.5, 0.25, 0.25, 2.0), "equal_k5": (1 / 3, 1 / 3, 1 / 3, 5.0), "equal_k2": (1 / 3, 1 / 3, 1 / 3, 2.0),
              "xg_only": (0.0, 1.0, 0.0, 15.0), "goals_only": (1.0, 0.0, 0.0, 15.0), "goals_only_k5": (1.0, 0.0, 0.0, 5.0), "goals_only_k2": (1.0, 0.0, 0.0, 2.0)}
CS_MODES = {"learned": None, "goals": (1.0, False), "mix90": (0.9, False), "mix70": (0.7, False), "mix50": (0.5, False), "mix30": (0.3, False), "venue70": (0.7, True)}
PAST_GWS = 38  # played gameweeks shown on the Minutes page (the whole season so far)
MINUTE_WEIGHTS = np.array([5.0, 4.0, 3.0, 2.0, 1.0])  # newest to oldest of the last 5 matches
BURN_IN_GWS = 6

NEEDED = ["name", "position", "team", "element", "fixture", "opponent_team", "was_home",
          "kickoff_time", "minutes", "total_points", "goals_scored", "assists", "bonus", "bps",
          "saves", "yellow_cards", "red_cards", "expected_goals", "expected_assists",
          "team_h_score", "team_a_score", "value"]
NUMERIC = ["element", "fixture", "minutes", "total_points", "goals_scored", "assists", "bonus",
           "bps", "saves", "yellow_cards", "red_cards", "expected_goals", "expected_assists",
           "team_h_score", "team_a_score", "value", "starts", "defensive_contribution", "xP", "penalties_saved", "penalties_missed", "own_goals", "pen_order", "fk_order", "corner_order", "core_xgot", "core_pen_scored", "core_pen_missed", "core_shots", "core_box"]


# ---------------------------------------------------------------- data access
def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def download(data_dir: Path, seasons: list[str]) -> None:
    for s in seasons:
        out = data_dir / s / "gws"
        out.mkdir(parents=True, exist_ok=True)
        if (data_dir / s / "players_raw.csv").exists() and len(list(out.glob("gw*.csv"))) >= 38:
            print(f"{s}: already downloaded")
            continue
        (data_dir / s / "players_raw.csv").write_bytes(_get(f"{RAW}/{s}/players_raw.csv"))
        got = 0
        for gw in range(1, 39):
            try:
                (out / f"gw{gw}.csv").write_bytes(_get(f"{RAW}/{s}/gws/gw{gw}.csv"))
                got += 1
            except urllib.error.HTTPError as e:
                print(f"  {s} GW{gw}: HTTP {e.code}, skipped")
            time.sleep(0.05)
        print(f"{s}: {got} gameweek files")


def _core_season(season: str) -> str:
    start, end = season.split("-")
    return f"{start}-{start[:2]}{end}"


def download_core(data_dir: Path, seasons: list[str]) -> None:
    """Per-match player stats from FPL Core Insights (xGOT, penalties). The current season is refreshed every run."""
    for s in seasons:
        if s < "2024-25":
            continue
        out = data_dir / s / "core"
        out.mkdir(parents=True, exist_ok=True)
        if s != CURRENT_SEASON and (out / "players.csv").exists() and len(list(out.glob("pms_gw*.csv"))) >= 38:
            print(f"{s}: Core Insights already downloaded")
            continue
        cs = _core_season(s)
        old_layout = s == "2024-25"
        players = f"{CORE}/{cs}/players/players.csv" if old_layout else f"{CORE}/{cs}/players.csv"
        (out / "players.csv").write_bytes(_get(urllib.parse.quote(players, safe=":/")))
        got = 0
        for gw in range(1, 39):
            path = f"{CORE}/{cs}/playermatchstats/GW{gw}/playermatchstats.csv" if old_layout else f"{CORE}/{cs}/By Tournament/Premier League/GW{gw}/playermatchstats.csv"
            try:
                (out / f"pms_gw{gw}.csv").write_bytes(_get(urllib.parse.quote(path, safe=":/")))
                got += 1
            except urllib.error.HTTPError:
                pass
            time.sleep(0.03)
        print(f"{s}: Core Insights {got} gameweek files")


def load_core(data_dir: Path, season: str) -> pd.DataFrame:
    folder = data_dir / season / "core"
    if not (folder / "players.csv").exists():
        return pd.DataFrame()
    codes = _read_csv(folder / "players.csv")[["player_id", "player_code"]].drop_duplicates("player_id")
    frames = []
    for f in folder.glob("pms_gw*.csv"):
        d = _read_csv(f)
        if "xgot" not in d or d.empty:
            continue
        d["GW"] = int(re.findall(r"\d+", f.stem)[0])
        frames.append(d)
    if not frames:
        return pd.DataFrame()
    d = pd.concat(frames, ignore_index=True)
    for c in ["minutes_played", "xgot", "penalties_scored", "penalties_missed", "total_shots", "shots_on_target", "touches_opposition_box"]:
        d[c] = pd.to_numeric(d.get(c), errors="coerce")
    d = d[d["minutes_played"].fillna(0) > 0].merge(codes, on="player_id", how="inner")
    g = d.groupby(["GW", "player_code"], as_index=False).agg(core_xgot=("xgot", "sum"), core_pen_scored=("penalties_scored", "sum"),
                                                          core_pen_missed=("penalties_missed", "sum"), core_shots=("total_shots", "sum"),
                                                          core_box=("touches_opposition_box", "sum"))
    return g.rename(columns={"player_code": "code"}).assign(season=season)


def add_core(df: pd.DataFrame, data_dir: Path, seasons: list[str]) -> pd.DataFrame:
    core = [load_core(data_dir, s) for s in seasons]
    core = [c for c in core if len(c)]
    df = df.copy()
    df["code"] = pd.to_numeric(df["code"], errors="coerce")
    if not core:
        for col in ["core_xgot", "core_pen_scored", "core_pen_missed", "core_shots", "core_box"]:
            df[col] = np.nan
        df["has_core"] = False
        return df
    c = pd.concat(core, ignore_index=True)
    c["code"] = pd.to_numeric(c["code"], errors="coerce")
    df = df.merge(c, on=["season", "GW", "code"], how="left")
    # a double gameweek is one Core Insights row per match but one per gameweek here: split by minutes
    mins = pd.to_numeric(df["minutes"], errors="coerce").fillna(0)
    share = mins / mins.groupby([df["season"], df["GW"], df["code"]]).transform("sum").replace(0, np.nan)
    for col in ["core_xgot", "core_pen_scored", "core_pen_missed", "core_shots", "core_box"]:
        df[col] = df[col] * share.fillna(0)
    df["has_core"] = df["core_xgot"].notna() & (mins > 0)
    return df


def _read_csv(path: Path) -> pd.DataFrame:
    try:
        return pd.read_csv(path, encoding="utf-8", low_memory=False)
    except UnicodeDecodeError:
        return pd.read_csv(path, encoding="latin-1", low_memory=False)


def load_season(data_dir: Path, season: str) -> pd.DataFrame:
    folder = data_dir / season / "gws"
    files = sorted(folder.glob("gw*.csv"), key=lambda p: int(re.findall(r"\d+", p.stem)[0]))
    if not files:
        raise FileNotFoundError(f"No gameweek files in {folder}. Run: python fpl_xpoints.py download")
    frames = [_read_csv(f).assign(GW=int(re.findall(r"\d+", f.stem)[0])) for f in files]
    df = pd.concat(frames, ignore_index=True)
    missing = [c for c in NEEDED if c not in df.columns]
    if missing:
        raise ValueError(f"{season}: missing columns {missing}")
    df["season"] = season
    df["element"] = pd.to_numeric(df["element"], errors="coerce")
    raw = data_dir / season / "players_raw.csv"
    if raw.exists():
        raw_df = _read_csv(raw)
        keep = ["id", "code"] + [c for c in SET_PIECE_COLS if c in raw_df]
        ids = raw_df[keep].rename(columns={"id": "element", **SET_PIECE_COLS})
        df = df.merge(ids, on="element", how="left")
    else:
        df["code"] = np.nan
    return df


def clean(df: pd.DataFrame, seasons_order: list[str]) -> pd.DataFrame:
    df = df.copy()
    for c in NUMERIC:
        df[c] = pd.to_numeric(df[c], errors="coerce") if c in df else np.nan
    df = df[df["position"].isin(POSITIONS)].copy()
    df["was_home"] = df["was_home"].astype(str).str.lower().isin(["true", "1"]).astype(int)
    df["kickoff_time"] = pd.to_datetime(df["kickoff_time"], utc=True, errors="coerce")
    names = df["name"].astype(str).str.lower().str.replace(r"[^a-z]", "", regex=True)
    has_code = df["code"].notna()
    df["pid"] = "n" + names
    df.loc[has_code, "pid"] = "c" + df.loc[has_code, "code"].astype("int64").astype(str)
    df["season_idx"] = df["season"].map({s: i for i, s in enumerate(seasons_order)})
    df["t"] = df["season_idx"] * 100 + df["GW"]
    if "future" not in df:
        df["future"] = False
    df["future"] = df["future"].fillna(False).astype(bool)
    return add_teams(df).sort_values(["pid", "t", "fixture"]).reset_index(drop=True)


def add_teams(df: pd.DataFrame) -> pd.DataFrame:
    """Takes the majority team per fixture side: historic team labels can be wrong after a transfer."""
    mode = lambda s: s.value_counts().index[0]
    side = df.groupby(["season", "fixture", "was_home"], sort=False)["team"].agg(mode).reset_index()
    home = side[side["was_home"] == 1].rename(columns={"team": "home_team"})[["season", "fixture", "home_team"]]
    away = side[side["was_home"] == 0].rename(columns={"team": "away_team"})[["season", "fixture", "away_team"]]
    df = df.merge(home, on=["season", "fixture"], how="left").merge(away, on=["season", "fixture"], how="left")
    h = df["was_home"] == 1
    df["team"] = np.where(h, df["home_team"], df["away_team"])
    df["opp"] = np.where(h, df["away_team"], df["home_team"])
    df["gf"] = np.where(h, df["team_h_score"], df["team_a_score"])
    df["ga"] = np.where(h, df["team_a_score"], df["team_h_score"])
    return df.dropna(subset=["team", "opp"]).drop(columns=["home_team", "away_team"])


# ---------------------------------------------------------------- features
def decayed_pre(keys: np.ndarray, x: np.ndarray, half_life: float, cap: int | None = None) -> np.ndarray:
    """Exponentially decayed sum of *earlier* rows of each key over the latest cap rows; the current row is excluded."""
    cap = cap or HISTORY_MATCHES
    d = 0.5 ** (1 / half_life)
    tail = d ** cap
    out = np.zeros(len(x))
    s, prev, hist = 0.0, object(), []
    for i, (k, v) in enumerate(zip(keys, x)):
        if k != prev:
            s, prev, hist = 0.0, k, []
        out[i] = s
        hist.append(v)
        s = s * d + v
        if len(hist) > cap:
            s -= hist[-cap - 1] * tail
    return out


def ai_minute_detail(history: list[float]) -> tuple[float, float, float]:
    """Expected minutes and the chance of 1+ and 60+ minutes, from per-match minutes, oldest first (0 = did not play).

    The last 5 matches weighted 5, 4, 3, 2, 1 from newest to oldest; fewer matches use the first weights.
    The chances are the weighted share of the same matches with 1+ and 60+ minutes.
    """
    if not history:
        return np.nan, np.nan, np.nan
    window = np.array(history[::-1][:5], dtype=float)
    weights = MINUTE_WEIGHTS[:len(window)]
    total = weights.sum()
    return (float(np.dot(window, weights) / total), float(np.dot(window > 0, weights) / total),
            float(np.dot(window >= 60, weights) / total))


def ai_minute(history: list[float]) -> float:
    return ai_minute_detail(history)[0]


def ai_minute_on_return(history: list[float]) -> tuple[float, float, float]:
    """AI Minute for a player coming back from an injury or ban: the matches he is missing right now are left out,
    so the 5-4-3-2-1 formula runs on the matches before the absence."""
    end = len(history)
    while end > 0 and history[end - 1] == 0:
        end -= 1
    return ai_minute_detail(history[:end]) if end else (np.nan, np.nan, np.nan)


def ai_minutes(keys: np.ndarray, mins: np.ndarray, matches: np.ndarray, reds: np.ndarray, banned: np.ndarray | None = None) -> tuple[np.ndarray, ...]:
    """AI Minute and the chance of 1+ and 60+ minutes before each row of each key, the same three figures for a
    player returning from an absence (ai_minute_on_return), and the latest minutes as text.

    A match with a red card and the suspension straight after it say nothing about his role, so they are left out,
    and so are matches he missed through a yellow-card ban (banned: how many of the row's matches, see yellow_bans).
    """
    out = np.full((len(mins), 6), np.nan)
    banned = np.zeros(len(mins)) if banned is None else banned
    recent: list[str] = []
    hist: list[float] = []
    raw: list[float] = []
    ban_left = 0
    prev = object()
    for i, (k, v, n, r, b) in enumerate(zip(keys, mins, matches, reds, banned)):
        if k != prev:
            hist, raw, ban_left, prev = [], [], 0, k
        out[i] = ai_minute_detail(hist) + ai_minute_on_return(hist)
        recent.append(",".join("out" if m < 0 else str(int(round(m))) for m in raw[-8:]))
        if n > 0 and b >= n:
            raw.append(-1.0)  # shown as "out" in the log (ban or injury)
        elif n > 0:
            minutes = float(v) / n
            raw.append(minutes)
            if r > 0:
                ban_left = MAX_BAN_MATCHES
                # sent off: left out, unless he had already played his usual minutes (then it can only raise them)
                if hist and minutes >= ai_minute_detail(hist)[0]:
                    hist.append(minutes)
            elif ban_left > 0 and minutes == 0:
                ban_left -= 1
            else:
                ban_left = 0
                hist.append(minutes)
    return out[:, 0], out[:, 1], out[:, 2], out[:, 3], out[:, 4], out[:, 5], recent


def _start_detail(history: list[tuple[float, float]]) -> tuple[float, float, float]:
    """Chance he starts (the last 5 matches weighted 5-4-3-2-1, newest first), and his average minutes in the starts
    and in the other matches of the same 5, from (minutes, started) per match, oldest first."""
    if not history:
        return np.nan, np.nan, np.nan
    win = history[::-1][:5]
    w = MINUTE_WEIGHTS[:len(win)]
    st = np.array([x[1] for x in win], float)
    mins = np.array([x[0] for x in win], float)
    rate = float(np.dot(st, w) / w.sum())
    ms = float(np.dot(mins * st, w) / np.dot(st, w)) if np.dot(st, w) > 0 else np.nan
    mb = float(np.dot(mins * (1 - st), w) / np.dot(1 - st, w)) if np.dot(1 - st, w) > 0 else np.nan
    return rate, ms, mb


def ai_starts(keys: np.ndarray, mins: np.ndarray, starts: np.ndarray, matches: np.ndarray, reds: np.ndarray, banned: np.ndarray) -> tuple[np.ndarray, ...]:
    """The Start figure (the chance he starts, 5-4-3-2-1 over the last 5 matches) before each row of each key, with the
    same matches left out as in ai_minutes, and his minutes when starting and when not; then the same three for a
    player coming back from an absence (the zero-minute matches at the end left out)."""
    out = np.full((len(mins), 8), np.nan)
    hist: list[tuple[float, float]] = []
    ban_left = 0
    prev = object()
    for i, (k, v, st, n, r, b) in enumerate(zip(keys, mins, starts, matches, reds, banned)):
        if k != prev:
            hist, ban_left, prev = [], 0, k
        end = len(hist)
        while end > 0 and hist[end - 1][0] == 0:
            end -= 1
        out[i] = (_start_detail(hist) + (_start_detail(hist[:end]) if end else (np.nan, np.nan, np.nan))
                  + (hist[-1][1] if hist else np.nan, hist[end - 1][1] if end else np.nan))
        if n > 0 and b >= n:
            continue
        if n > 0:
            minutes = float(v) / n
            if r > 0:
                ban_left = MAX_BAN_MATCHES
                if hist and minutes >= ai_minute_detail([m for m, _ in hist])[0]:
                    hist.append((minutes, min(1.0, float(st) / n)))  # as in ai_minutes
            elif ban_left > 0 and minutes == 0:
                ban_left -= 1
            else:
                ban_left = 0
                hist.append((minutes, min(1.0, float(st) / n)))
    return tuple(out[:, j] for j in range(8))


def team_pre(keys: np.ndarray, x: np.ndarray, periods: np.ndarray) -> np.ndarray:
    """A team's record before each row: decayed with a season reset factor, or a plain recent window."""
    out = np.zeros(len(x))
    if TEAM_WINDOW > 0:
        hist: list[float] = []
        prev = object()
        for i, (k, v) in enumerate(zip(keys, x)):
            if k != prev:
                hist, prev = [], k
            out[i] = sum(hist[-TEAM_WINDOW:])
            hist.append(v)
        return out
    d = 0.5 ** (1 / HL_TEAM)
    s, prev, prev_period, hist = 0.0, object(), None, []
    for i, (k, v, q) in enumerate(zip(keys, x, periods)):
        if k != prev:
            s, prev, prev_period, hist = 0.0, k, q, []
        if q != prev_period:
            s *= TEAM_CARRY
            hist = [h * TEAM_CARRY for h in hist]
            prev_period = q
        out[i] = s
        hist.append(v)
        hist = hist[-HISTORY_MATCHES:]
        s = sum(h * d ** j for j, h in enumerate(reversed(hist)))
    return out


def team_features(df: pd.DataFrame) -> pd.DataFrame:
    hist = df[~df["future"]]
    fx = (hist.groupby(["season", "fixture", "team", "opp", "tf"], as_index=False)
          .agg(xg=("expected_goals", "sum"), gf=("gf", "first")))
    fx["gf"] = fx["gf"].fillna(0.0)
    against = fx[["season", "fixture", "team", "xg", "gf"]].rename(columns={"team": "opp", "xg": "xga", "gf": "ga"})
    fx = fx.merge(against, on=["season", "fixture", "opp"], how="left")
    t = fx.groupby(["team", "tf"], as_index=False).agg(n=("xg", "size"), xg=("xg", "sum"), xga=("xga", "sum"), gf=("gf", "sum"), ga=("ga", "sum"))
    pairs = pd.concat([df[["team", "tf"]], df[["opp", "tf"]].rename(columns={"opp": "team"})]).drop_duplicates()
    t = pairs.merge(t, on=["team", "tf"], how="left").fillna(0.0).sort_values(["team", "tf"])

    by_t = t.groupby("tf")[["n", "xg", "gf"]].sum().sort_index().cumsum().shift(1).fillna(0.0)
    lg = (by_t["xg"] / by_t["n"].replace(0, np.nan)).fillna(LEAGUE_XG_FALLBACK)
    lg_goals = (by_t["gf"] / by_t["n"].replace(0, np.nan)).fillna(LEAGUE_XG_FALLBACK)
    t["league"] = t["tf"].map(lg).replace(0, LEAGUE_XG_FALLBACK)
    t["league_g"] = t["tf"].map(lg_goals).replace(0, LEAGUE_XG_FALLBACK)

    seen = {i: set(g) for i, g in df.groupby("season_idx")["team"]}
    def promoted(team: str, tf: int) -> bool:
        i = int(tf // 100)
        return i > 0 and i - 1 in seen and team not in seen[i - 1]
    prom = np.array([promoted(a, b) for a, b in zip(t["team"], t["tf"])])

    keys = t["team"].to_numpy()
    periods = (t["tf"].to_numpy() // 100)
    sn = team_pre(keys, t["n"].to_numpy(float), periods)
    t["att_ratio"] = ((team_pre(keys, t["xg"].to_numpy(float), periods)
                       + K_TEAM * t["league"] * np.where(prom, PROMOTED_ATT, 1.0))
                      / (sn + K_TEAM)) / t["league"]
    t["def_ratio"] = ((team_pre(keys, t["xga"].to_numpy(float), periods)
                       + K_TEAM * t["league"] * np.where(prom, PROMOTED_DEF, 1.0))
                      / (sn + K_TEAM)) / t["league"]
    t["att_g_ratio"] = ((team_pre(keys, t["gf"].to_numpy(float), periods)
                         + K_TEAM_GOALS * t["league_g"] * np.where(prom, PROMOTED_ATT, 1.0))
                        / (sn + K_TEAM_GOALS)) / t["league_g"]
    t["def_g_ratio"] = ((team_pre(keys, t["ga"].to_numpy(float), periods)
                         + K_TEAM_GOALS * t["league_g"] * np.where(prom, PROMOTED_DEF, 1.0))
                        / (sn + K_TEAM_GOALS)) / t["league_g"]
    out = t[["team", "tf", "att_ratio", "def_ratio", "att_g_ratio", "def_g_ratio", "league_g"]]
    return out, venue_ratings(df, fx, out)


def venue_ratings(df: pd.DataFrame, fx: pd.DataFrame, overall: pd.DataFrame) -> pd.DataFrame:
    """Each team's goals scored and conceded at home and away, shrunk toward its overall goal record."""
    home = df.drop_duplicates(["season", "fixture", "team"])[["season", "fixture", "team", "was_home"]]
    v = fx.merge(home, on=["season", "fixture", "team"], how="left").rename(columns={"was_home": "home"})
    v = v.groupby(["team", "home", "tf"], as_index=False).agg(n=("gf", "size"), gf=("gf", "sum"), ga=("ga", "sum"))
    sides = pd.concat([df[["team", "was_home", "tf"]].rename(columns={"was_home": "home"}),
                       df[["opp", "was_home", "tf"]].rename(columns={"opp": "team"}).assign(home=lambda x: 1 - x["was_home"]).drop(columns="was_home")])
    sides = sides.drop_duplicates()
    v = sides.merge(v, on=["team", "home", "tf"], how="left").fillna(0.0).sort_values(["team", "home", "tf"])
    v = v.merge(overall[["team", "tf", "att_g_ratio", "def_g_ratio", "league_g"]], on=["team", "tf"], how="left")
    keys = (v["team"].astype(str) + "|" + v["home"].astype(int).astype(str)).to_numpy()
    periods = v["tf"].to_numpy() // 100
    sn = team_pre(keys, v["n"].to_numpy(float), periods)
    lg = v["league_g"].fillna(LEAGUE_XG_FALLBACK)
    v["att_gv"] = (team_pre(keys, v["gf"].to_numpy(float), periods) + K_VENUE * lg * v["att_g_ratio"].fillna(1.0)) / (sn + K_VENUE) / lg
    v["def_gv"] = (team_pre(keys, v["ga"].to_numpy(float), periods) + K_VENUE * lg * v["def_g_ratio"].fillna(1.0)) / (sn + K_VENUE) / lg
    return v[["team", "home", "tf", "att_gv", "def_gv"]]


YELLOW_BANS = [(5, 19, 1), (10, 32, 2), (15, 38, 3)]  # Premier League: yellows reached by gameweek -> matches banned


def yellow_bans(df: pd.DataFrame) -> pd.DataFrame:
    """Flags matches a player missed through a yellow-card ban ("yellow_ban").

    Counts his Premier League yellows through each season; reaching 5 by GW19, 10 by GW32 or 15 means a ban of
    1, 2 or 3 matches, served in the team's next matches. Only the zero-minute ones among them are flagged."""
    df = df.copy()
    df["yellow_ban"] = False
    obs = df[~df["future"] & df["minutes"].notna()].sort_values(["pid", "season", "kickoff_time", "fixture"])
    for _, g in obs.groupby(["pid", "season"], sort=False):
        total, owed = 0, 0
        for i, y, mins, gw in zip(g.index, g["yellow_cards"].fillna(0), g["minutes"], g["GW"]):
            if owed > 0:
                if mins == 0:
                    df.at[i, "yellow_ban"] = True
                owed -= 1
                continue
            before, total = total, total + int(y)
            for count, by_gw, matches in YELLOW_BANS:
                if before < count <= total and gw <= by_gw:
                    owed = matches
    print(f"Matches missed through a yellow-card ban: {int(df['yellow_ban'].sum())}")
    return df


def skipped(df: pd.DataFrame) -> pd.Series:
    """Matches left out of the minutes formula: yellow-card bans and injury absences (this season's from the injury
    log, past seasons' from archive/injuries)."""
    out = pd.Series(False, index=df.index)
    for col in ("yellow_ban", "inj_skip", "hist_skip"):
        if col in df:
            out |= df[col].fillna(False).astype(bool)
    return out


REPLAY_GW: int | None = None  # set by `site --as-of N`: rebuild the site as it would have been before GW N's deadline
INJURY_LOG = Path("injury_log.json")  # kept in the repo; the update workflow commits it after each build
OUT_STATUS = {"i": "Injury", "s": "Suspended", "d": "Doubtful", "n": "Unavailable"}


def update_injury_log(df: pd.DataFrame, first: int, path: Path = INJURY_LOG, now: str | None = None) -> list[dict]:
    """Adds to the injury log: one record per absence, never deleted.

    A player FPL flags (injured, suspended, doubtful, unavailable) gets a record with the gameweek it started (the
    first of his zero-minute matches in a row up to now, else the gameweek the news came out) and the gameweek he is
    expected back (from the return date in the news). Each change of news or expected return is added to its
    updates. When FPL no longer flags him, the record is closed with the gameweek he played again."""
    now = now or pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%MZ")
    log = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    fut = df[df["future"]].sort_values(["GW", "kickoff_time"]).drop_duplicates("pid")
    played = df[~df["future"] & (df["season"] == CURRENT_SEASON) & df["minutes"].notna()].sort_values(["kickoff_time", "fixture"])
    matches = {pid: list(zip(g["GW"].astype(int), g["minutes"].astype(float))) for pid, g in played.groupby("pid")}
    open_by_pid = {r["pid"]: r for r in log if r["status"] == "out" and r.get("season") == CURRENT_SEASON}
    added = changed = closed = 0
    for r in fut.itertuples(index=False):
        status = r.status if isinstance(r.status, str) else "a"
        rec = open_by_pid.get(r.pid)
        if status in OUT_STATUS:
            news = r.news if isinstance(r.news, str) else ""
            back = None if pd.isna(r.return_gw) else int(r.return_gw)
            when = return_date(news, r.news_added if isinstance(r.news_added, str) else None)
            chance = None if pd.isna(r.chance) else int(r.chance)
            if rec is None:
                m = matches.get(r.pid, [])
                k = len(m)
                while k > 0 and m[k - 1][1] == 0:
                    k -= 1
                start, source = (m[k][0], "matches") if k < len(m) else (int(r.news_gw), "news")
                rec = {"id": f"{r.pid}-{CURRENT_SEASON}-GW{start}", "season": CURRENT_SEASON, "pid": r.pid, "name": r.web_name,
                       "team": r.team_short, "position": r.position, "startGw": start, "startFrom": source, "firstSeen": now,
                       "status": "out", "returnedGw": None, "updates": []}
                log.append(rec)
                open_by_pid[r.pid] = rec
                added += 1
            now_state = {"type": OUT_STATUS[status], "news": news, "chance": chance, "expectedReturnGw": back,
                         "expectedReturnDate": None if when is None else when.strftime("%Y-%m-%d")}
            last = rec["updates"][-1] if rec["updates"] else {}
            if any(last.get(k) != v for k, v in now_state.items()):
                rec["updates"].append({"gw": first, "at": now, **now_state})
                changed += 1
            rec.update(now_state, team=r.team_short, lastSeen=now)
        elif rec is not None:
            back_gw = next((gw for gw, mins in matches.get(r.pid, []) if gw >= rec["startGw"] and mins > 0), first)
            rec.update(status="back" if status == "a" else "left", returnedGw=back_gw, closedAt=now)
            closed += 1
    # players with no upcoming fixture left in the data (left the league): close what is open
    gone = set(open_by_pid) - set(fut["pid"])
    for pid in gone:
        if open_by_pid[pid]["status"] == "out":
            open_by_pid[pid].update(status="left", closedAt=now)
    log.sort(key=lambda r: (r["status"] != "out", -r["startGw"], r["name"]))
    path.write_text(json.dumps(log, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Injury log: {added} new, {changed} updated, {closed} back, {sum(r['status'] == 'out' for r in log)} out now, {len(log)} in total")
    return log


ADMIN_INJURIES = Path("admin_injuries.json")  # set on the Admin page: {"manual": [...], "startOverrides": {id: gw}}


def load_admin_injuries(path: Path = ADMIN_INJURIES) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except ValueError as e:
        print(f"{path} not read ({e}); admin injuries ignored")
        data = {}
    return {"manual": list(data.get("manual", [])), "startOverrides": dict(data.get("startOverrides", {}))}


def merged_injuries(log: list[dict], admin: dict) -> list[dict]:
    """The logged absences with the admin's start gameweeks, plus the absences the admin added by hand."""
    out = []
    for r in log:
        r = dict(r)
        if r["id"] in admin["startOverrides"]:
            r["startGwAuto"], r["startGw"], r["startFrom"] = r["startGw"], int(admin["startOverrides"][r["id"]]), "admin"
        out.append(r)
    for m in admin["manual"]:
        end = m.get("endGw")
        out.append({"id": m["id"], "season": m.get("season", CURRENT_SEASON), "pid": m["pid"], "name": m.get("name", m["pid"]),
                    "team": m.get("team", ""), "position": m.get("position", ""), "type": m.get("type") or "Injury", "manual": True,
                    "startGw": int(m["startGw"]), "endGw": None if end is None else int(end), "startFrom": "admin",
                    "status": "out" if end is None else "back", "returnedGw": None if end is None else int(end) + 1,
                    "news": m.get("note", ""), "expectedReturnGw": None, "expectedReturnDate": None, "chance": None, "updates": []})
    out.sort(key=lambda r: (r["status"] != "out", -r["startGw"], r["name"]))
    return out


def manual_absences(target: pd.DataFrame, admin: dict) -> pd.DataFrame:
    """An absence the admin added by hand (injury, illness, ban, manager's discipline...) that covers an upcoming
    gameweek: 0 minutes until End GW, then his usual minutes from before it (the absence is left out of the formula)."""
    target = target.copy()
    for m in admin.get("manual", []):
        if m.get("season", CURRENT_SEASON) != CURRENT_SEASON:
            continue
        start, end = int(m["startGw"]), m.get("endGw")
        end = 99 if end is None else int(end)
        rows = (target["pid"] == m["pid"]) & target["GW"].between(start, end)
        if not rows.any():
            continue
        kind = m.get("type") or "Injury"
        target.loc[rows, "avail"] = 0.0
        target.loc[rows, "min_note"] = f"{kind} (admin), out until " + ("further notice" if end == 99 else f"GW{end}")
        target.loc[target["pid"] == m["pid"], "return_gw"] = None if end == 99 else end + 1
    return target


# ---------------------------------------------------------------- substitutions for injury (FotMob)
# FotMob's match events mark a substitution made because the player going off was hurt ("injuredPlayerOut"). Each
# finished match is read once and kept in INJURY_SUBS (in the repo; the update workflow commits it).
INJURY_SUBS = Path("injury_subs.json")
TACTICAL: dict = {}  # (pid, gameweek) -> note: taken off for a defender just after a team-mate's red card
RED_TACTICAL_BEFORE, RED_TACTICAL_WINDOW = 70, 20  # a red card before this minute; the sub within this many minutes after it
OOP_LAST = 5          # a defender's last league starts (FotMob places) give the share of time he plays further forward
RED_HALFLIFE_TF = 19  # gameweeks (about half a season) for a red card's weight in the position average to halve
OOP_MIN_SHARE = 0.10  # at or below this share he counts as a plain defender
OOP_KNOWN = 3  # with at least this many league starts known to FotMob, his places decide (not his stats)
OOP_MID_ROLES = {"AM", "RM", "LM", "RW", "LW", "ST"}  # wing, wide or attacking midfield (not holding/central midfield, not wing-back)
FM_SHARE: dict = {}  # pid -> share of recent starts further forward
FM_PLACES: dict = {}  # pid -> roles in his last league starts, for defenders playing further forward (filled each run)
FOTMOB_API = "https://www.fotmob.com/api/data"
FOTMOB_LEAGUE = 47  # Premier League
FOTMOB_TEAMS = {"AFC Bournemouth": "Bournemouth", "Brighton & Hove Albion": "Brighton", "Manchester City": "Man City", "Manchester United": "Man Utd",
                "Tottenham Hotspur": "Spurs", "Nottingham Forest": "Nott'm Forest", "Newcastle United": "Newcastle", "Leeds United": "Leeds",
                "Coventry City": "Coventry", "Hull City": "Hull", "Ipswich Town": "Ipswich", "Wolverhampton Wanderers": "Wolves",
                "West Ham United": "West Ham", "Leicester City": "Leicester", "Sunderland AFC": "Sunderland", "Brentford FC": "Brentford"}


def _fotmob_get(path: str, params: dict) -> dict:
    url = f"{FOTMOB_API}/{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
                                               "Accept": "application/json", "Referer": "https://www.fotmob.com/"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _name_key(s: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z ]", "", re.sub(r"[-.']", " ", s)).split())


def injury_subs(cache: Path, offline: bool, boot: dict) -> tuple[set, set]:
    """(pid, gameweek) of every player taken off injured in a finished league match this season, and the gameweeks
    whose matches were all read. Empty if FotMob cannot be read."""
    folder = cache / "fotmob"
    folder.mkdir(parents=True, exist_ok=True)
    idx = folder / "league.json"
    try:
        if offline or (idx.exists() and time.time() - idx.stat().st_mtime < 6 * 3600):
            league = json.loads(idx.read_text())
        else:
            league = _fotmob_get("leagues", {"id": FOTMOB_LEAGUE, "ccode3": "GBR"})
            idx.write_text(json.dumps({"fixtures": league.get("fixtures"), "matches": league.get("matches")}))
            league = json.loads(idx.read_text())
    except Exception as e:  # never stop the site for this
        print(f"FotMob not read ({e}); the match a player got hurt in is guessed from his minutes")
        return set(), set(), {}
    matches = ((league.get("fixtures") or {}).get("allMatches") or (league.get("matches") or {}).get("allMatches") or [])
    teams = {t["name"]: t["id"] for t in boot["teams"]}
    by_team = {}
    for p in boot["elements"]:
        by_team.setdefault(p["team"], []).append(p)

    def find(name: str, team: str):
        tid = teams.get(FOTMOB_TEAMS.get(team, team)) or next((i for nm, i in teams.items() if _name_key(nm).split()[0] == _name_key(team).split()[0]), None)
        n = _name_key(name)
        pool = by_team.get(tid, [])
        full = lambda p: _name_key(f'{p["first_name"]} {p["second_name"]}')
        for test in (lambda p: full(p) == n, lambda p: _name_key(p["web_name"]) == n, lambda p: set(n.split()) <= set(full(p).split()),
                     lambda p: set(_name_key(p["web_name"]).split()) <= set(n.split()), lambda p: n.split()[-1] == _name_key(p["second_name"]).split()[-1],
                     lambda p: n.split()[-1] in full(p).split()):  # "Yeremi Pino" is Yeremy Pino Santos
            hit = [p for p in pool if test(p)]
            if len(hit) == 1:
                return hit[0]
        return None

    def find_any(name: str):
        """The same name anywhere in FPL (a player FotMob lists at a club FPL does not, yet)."""
        n = _name_key(name)
        hit = [p for p in boot["elements"] if _name_key(f'{p["first_name"]} {p["second_name"]}') == n or n.split()[-1] in _name_key(p["second_name"]).split() and n.split()[0][:3] == _name_key(p["first_name"])[:3]]
        return hit[0] if len(hit) == 1 else None

    store = json.loads(INJURY_SUBS.read_text(encoding="utf-8")) if INJURY_SUBS.exists() else {}
    hurt, done, missing, fetched = set(), {}, [], 0
    for m in matches:
        if not (m.get("status") or {}).get("finished"):
            continue
        rnd = int(m.get("round") or 0)
        if str(m["id"]) in store and ("subs" in store[str(m["id"])] or offline):
            got = store[str(m["id"])]
        elif offline:
            done[rnd] = False
            continue
        else:
            try:
                d = _fotmob_get("matchDetails", {"matchId": m["id"]})
                ev = (((d.get("content") or {}).get("matchFacts") or {}).get("events") or {}).get("events") or []
                lu = (d.get("content") or {}).get("lineup") or {}
                side = lambda tm: [[x.get("name"), x.get("positionId"), (x.get("verticalLayout") or {}).get("x")] for x in (lu.get(tm) or {}).get("starters") or []]
                got = {"round": rnd, "home": m["home"]["name"], "away": m["away"]["name"],
                       "injured": [{"name": e["swap"][1]["name"] if len(e.get("swap") or []) > 1 else None, "home": e.get("isHome"), "time": e.get("time")}
                                   for e in ev if e.get("type") == "Substitution" and e.get("injuredPlayerOut")],
                       # each starter's place (FotMob position id and side), for the roles players actually play
                       "starters": {"home": side("homeTeam"), "away": side("awayTeam")},
                       # red cards (straight or second yellow) and every player taken off, with the minute
                       "reds": [{"name": (e.get("player") or {}).get("name") or e.get("nameStr"), "home": e.get("isHome"), "time": e.get("time")}
                                for e in ev if e.get("type") == "Card" and str(e.get("card") or "") in ("Red", "YellowRed")],
                       # every substitution: who came on, who went off, the minute
                       "subs": [{"in": (e.get("swap") or [{}])[0].get("name"), "out": e["swap"][1]["name"] if len(e.get("swap") or []) > 1 else None,
                                 "home": e.get("isHome"), "time": e.get("time")} for e in ev if e.get("type") == "Substitution"]}
                store[str(m["id"])] = got
                fetched += 1
                time.sleep(0.4)
            except Exception as e:
                print(f"FotMob match {m['id']} not read ({e})")
                done[rnd] = False
                continue
        done.setdefault(rnd, True)
        for x in got["injured"]:
            team = got["home"] if x["home"] else got["away"]
            p = find(x["name"], team) if x["name"] else None
            if p:
                hurt.add((f"c{p['code']}", rnd))
            else:
                missing.append(f"{x['name']} ({team})")
    if fetched:
        INJURY_SUBS.write_text(json.dumps(store, ensure_ascii=False, indent=0), encoding="utf-8")
    covered = {r for r, ok in done.items() if ok}
    # Team red card, tactical sub: a defensive player (defender or central midfielder) sent off before the 70th minute,
    # and the club's first change after it (within 20 minutes) takes an attacking player (winger, attacking midfielder
    # or striker) off for a defensive one. That match says nothing of the attacking player's role.
    TACTICAL.clear()
    roles_of = {}  # each player's FotMob places in his league starts (by name)
    for got in store.values():
        for k in ("home", "away"):
            for name, pid, _ in (got.get("starters") or {}).get(k) or []:
                if name:
                    roles_of.setdefault(_name_key(name), []).append(role_base(ROLE_OF(pid)))
    BACK, HOLD, ATTACK = ("CB", "RB", "LB", "RWB", "LWB"), ("DM", "CM"), ("RW", "LW", "RM", "LM", "AM", "ST")
    def kind(name, q, roles_now):
        """'defensive' or 'attacking': his place in this match if he started it, else his FPL position (a midfielder
        by where he usually starts)."""
        r = roles_now.get(_name_key(name))
        if r:
            return "defensive" if r in BACK + HOLD else "attacking" if r in ATTACK else None
        q = q or find_any(name)
        usual = roles_of.get(_name_key(name), [])
        most = lambda roles: usual and sum(x in roles for x in usual) * 2 > len(usual)
        if (q and q["element_type"] == 2) or (not q and most(BACK)):
            return "defensive"
        if q and q["element_type"] == 4:
            return "attacking"
        if (not q or q["element_type"] == 3) and most(HOLD):
            return "defensive"
        if (not q or q["element_type"] == 3) and most(ATTACK):
            return "attacking"
        return None
    for got in store.values():
        for k, team in (("home", got.get("home")), ("away", got.get("away"))):
            home = k == "home"
            roles_now = {_name_key(n): role_base(ROLE_OF(pid)) for n, pid, _ in (got.get("starters") or {}).get(k) or [] if n}
            for rc in got.get("reds") or []:
                t = rc.get("time")
                if rc.get("home") != home or t is None or t >= RED_TACTICAL_BEFORE or not rc.get("name"):
                    continue
                if kind(rc["name"], find(rc["name"], team), roles_now) != "defensive":
                    continue
                after = [sb for sb in got.get("subs") or [] if sb.get("home") == home and sb.get("time") is not None and t <= sb["time"] <= t + RED_TACTICAL_WINDOW]
                if not after:
                    continue
                first = min(sb["time"] for sb in after)  # the first change after the red card (a double change counts as one)
                for sb in (x for x in after if x["time"] == first):
                    if not sb.get("out") or not sb.get("in"):
                        continue
                    p_out = find(sb["out"], team)
                    if not p_out or kind(sb["out"], p_out, roles_now) != "attacking" or kind(sb["in"], find(sb["in"], team), {}) != "defensive":
                        continue
                    TACTICAL[(f"c{p_out['code']}", got.get("round") or 0)] = (f"Tactical sub (team red card): taken off at {first}' for {sb['in']} "
                                                                         f"after {rc['name']} was sent off at {t}'")
    if TACTICAL:
        print("Tactical subs (team red card): " + "; ".join(f"{k[0]} GW{k[1]}: {v}" for k, v in sorted(TACTICAL.items(), key=lambda kv: kv[0][1])))
    # Where each player started his last league matches (FotMob places): a defender in FPL who started in midfield or
    # on a wing in most of his last OOP_LAST starts plays out of position.
    starts = {}
    for got in store.values():
        for k, team in (("home", got.get("home")), ("away", got.get("away"))):
            line = (got.get("starters") or {}).get(k) or []
            front = sum(1 for _, pid, _ in line if int(pid or 0) >= 100)
            for name, pid, x in line:
                q = find(name, team) if name else None
                if not q:
                    continue
                r = ROLE_OF(pid)
                if r == "ST" and front >= 3 and x is not None:
                    r = "RW" if x < 0.35 else "LW" if x > 0.65 else "ST"
                starts.setdefault(f"c{q['code']}", []).append((got.get("round") or 0, r))
    pos_of = {f"c{q['code']}": q["element_type"] for q in boot["elements"]}
    fm_oop = {}
    for pid, lst in starts.items():
        last = [r for _, r in sorted(lst)[-OOP_LAST:]]
        if pos_of.get(pid) != 2 or len(last) < OOP_KNOWN:
            continue
        # share of his recent starts further forward, the newest weighted most (5-4-3-2-1)
        w = list(range(1, len(last) + 1))
        share = sum(wi for wi, r in zip(w, last) if role_base(r) in OOP_MID_ROLES) / sum(w)
        share = share if share > OOP_MIN_SHARE else 0.0  # too little to matter: a plain defender
        fm_oop[pid] = {"share": round(share, 3), "last": last}  # share 0: a plain defender, whatever his stats say
    print(f"FotMob places: {len(starts)} players; defenders starting in midfield or on a wing: "
          + ", ".join(f"{pid} {v['share']:.0%}" for pid, v in fm_oop.items() if v["share"] > 0))
    print(f"FotMob: {fetched} new matches read; {len(hurt)} players taken off injured in GW{min(covered, default=0)}-{max(covered, default=0)}"
          + (f"; not matched to FPL: {', '.join(missing[:10])}" if missing else ""))
    return hurt, covered, fm_oop


# ---------------------------------------------------------------- every club's fixtures in all competitions
# League matches come from FPL (its gameweek and kickoff); every other competition from FotMob's team pages.
CLUB_COMPS = {"Champions League": "UCL", "Europa League": "UEL", "Conference League": "UECL", "EFL Cup": "EFL",
              "FA Cup": "FAC",
              # qualifying rounds count as the competition itself
              "Champions League Qualification": "UCL", "Europa League Qualification": "UEL",
              "Conference League Qualification": "UECL"}
CUP_CODES = {"UCL", "UEL", "UECL", "EFL", "FAC"}


_CLUB_FILLER = {"fc", "ac", "as", "sc", "cf", "fk", "sk", "afc", "real", "club", "athletic", "olympique", "rb", "us", "ss", "ssc", "vfb", "vfl", "bayer", "borussia", "fsv", "tsg", "sv", "ogc", "rc", "rcd", "cd", "ud", "sd", "kv", "krc", "rsc", "royal"}


def _club_short(name: str) -> str:
    """Three letters for a club outside the league: "Real Madrid" MAD, "Paris Saint-Germain" PSG, "Sabah FK" SAB."""
    words = _name_key(name).split()
    if not words:
        return "TBC"
    fixed = {"paris saint": "PSG", "atletico madrid": "ATM", "union st": "USG", "inter": "INT", "ac milan": "MIL", "psv eindhoven": "PSV", "sporting cp": "SCP"}
    for k, v in fixed.items():
        if " ".join(words).startswith(k):
            return v
    rest = [w for w in words if w not in _CLUB_FILLER] or words
    return rest[0][:3].upper()


CUP_MINUTES = Path("cup_minutes.json")  # FotMob minutes of Premier League players in cup and European matches, kept in the repo


def fdr_table(res: pd.DataFrame, df: pd.DataFrame | None = None) -> dict:
    """Fixture difficulty from our own model, per club and coming match: goals it is expected to score (the other
    side's expected goals conceded) and to concede, and its clean sheet chance. For reference only."""
    t = res.groupby(["GW", "fixture", "team"], as_index=False).agg(
        short=("team_short", "first"), opp=("opp_short", "first"), home=("was_home", "first"), conc=("conc90", "first"), cs=("p_cs", "first"),
        kick=("kickoff_time", "first") if "kickoff_time" in res else ("GW", "first"))
    other = t[["fixture", "team", "conc"]].rename(columns={"team": "opp_team", "conc": "scored"})
    t["opp_team"] = t.groupby("fixture")["team"].transform(lambda x: x.iloc[::-1].to_numpy() if len(x) == 2 else x.to_numpy())
    t = t.merge(other, on=["fixture", "opp_team"], how="left")
    out = {}
    for _, r in t.sort_values(["GW", "kick"]).iterrows():
        out.setdefault(str(r["short"]), {}).setdefault(str(int(r["GW"])), []).append({
            "opp": str(r["opp"]).upper() if r["home"] else str(r["opp"]).lower(), "home": bool(r["home"]),
            "xgf": round(float(r["scored"]), 3) if pd.notna(r["scored"]) else None, "xga": round(float(r["conc"]), 3), "cs": round(float(r["cs"]), 4)})
    payload = {"gws": sorted(int(g) for g in res["GW"].unique()), "teams": out, "names": dict(zip(res["team_short"].astype(str), res["team"].astype(str)))}
    if df is not None:
        try:
            payload.update(fdr_strength(df, res))
        except Exception as e:  # the page falls back to the model's coming matches
            print(f"FDR strength not added ({e})")
    return payload


def fdr_strength(df: pd.DataFrame, res: pd.DataFrame) -> dict:
    """Each club's season so far, per match: real goals and xG, for and against, and the league's home advantage
    (real goals and xG mixed half and half). The FDR page ranks the clubs on this mix."""
    hist = df[~df["future"] & (df["season"] == CURRENT_SEASON) & df["minutes"].notna()]
    fx = hist.groupby(["fixture", "team", "opp"], as_index=False).agg(xg=("expected_goals", "sum"), gf=("gf", "first"), home=("was_home", "first"))
    fx["gf"] = fx["gf"].fillna(0.0)
    fx = fx.merge(fx[["fixture", "team", "xg", "gf"]].rename(columns={"team": "opp", "xg": "xga", "gf": "ga"}), on=["fixture", "opp"], how="left")
    short = dict(zip(res["team"].astype(str), res["team_short"].astype(str)))
    teams = {}
    for team, g in fx.groupby("team"):
        if str(team) in short:
            teams[short[str(team)]] = {"n": int(len(g)), "gf": round(float(g["gf"].mean()), 3), "ga": round(float(g["ga"].mean()), 3),
                                        "xg": round(float(g["xg"].mean()), 3), "xga": round(float(g["xga"].mean()), 3)}
    mix = 0.5 * fx["gf"] + 0.5 * fx["xg"]
    home_adv = float(mix[fx["home"] == 1].mean() / mix[fx["home"] == 0].mean())
    return {"strength": teams, "homeAdv": round(home_adv, 3), "mixGoals": 0.5}


def cup_minutes(fx: dict, offline: bool) -> dict:
    """{FotMob match id: {"teams": {team name: {player name: minutes}}}} for every finished cup or European match of a
    Premier League club, read once from FotMob's player stats and kept in CUP_MINUTES. For reference on the Minutes
    page only: the minutes formula does not use them."""
    store = json.loads(CUP_MINUTES.read_text(encoding="utf-8")) if CUP_MINUTES.exists() else {}
    want = {str(m["mid"]) for t in fx["teams"] for m in t["matches"] if m["comp"] in CUP_CODES and m.get("score") is not None and m.get("mid")}
    fetched = 0
    for mid in sorted(want - set(store)):
        if offline:
            break
        try:
            d = _fotmob_get("matchDetails", {"matchId": mid})
        except Exception as e:
            print(f"FotMob match {mid} not read ({e})")
            continue
        teams = {}
        for ps in ((d.get("content") or {}).get("playerStats") or {}).values():
            mins = None
            for blk in ps.get("stats") or []:
                v = ((blk.get("stats") or {}).get("Minutes played") or {}).get("stat", {}).get("value")
                if v is not None:
                    mins = int(v)
                    break
            if mins is not None and ps.get("name"):
                teams.setdefault(ps.get("teamName") or "", {})[ps["name"]] = mins
        store[mid] = {"teams": teams}
        fetched += 1
        time.sleep(0.4)
    if fetched:
        CUP_MINUTES.write_text(json.dumps(store, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"Cup minutes: {len(want)} finished cup matches, {fetched} read from FotMob now")
    return store


def gw_of_time(t, gws: list[dict]) -> int | None:
    """The gameweek whose window (its deadline up to the next one) a kick-off falls in."""
    if not t:
        return None
    k = pd.Timestamp(t)
    k = k.tz_localize("UTC") if k.tzinfo is None else k
    dl = [(g["gw"], pd.Timestamp(g["deadline"])) for g in sorted(gws, key=lambda g: g["gw"])]
    for (g, d), nxt in zip(dl, dl[1:] + [(None, None)]):
        if k >= d and (nxt[1] is None or k < nxt[1]):
            return g
    return None


INTL_MINUTES = Path("intl_minutes.json")  # FotMob national-team matches of Premier League players, kept in the repo
INTL_BATCH, INTL_AGE_H, INTL_FROM = 160, 20, "2026-07-01"


def intl_minutes(cache: Path, offline: bool) -> dict:
    """{FotMob player id: {name, club, fetched, matches: {match id: [kick-off, opponent, minutes, competition, nation]}}}:
    national-team matches from each player's FotMob page (its recent matches), refreshed a batch at a time (the
    players read longest ago first) and kept in INTL_MINUTES, since a page only lists the last few matches. For
    reference on the Minutes page only."""
    store = json.loads(INTL_MINUTES.read_text(encoding="utf-8")) if INTL_MINUTES.exists() else {}
    mf = cache / "fotmob" / "members.json"
    members = json.loads(mf.read_text()) if mf.exists() else {}
    now = time.time()
    todo = []
    for club, ms in members.items():
        for name, fid, nat, cname in ms:
            rec = store.setdefault(str(fid), {"name": name, "club": club, "fetched": 0, "matches": {}})
            rec.update(name=name, club=club, nat=nat)
            if now - rec["fetched"] > INTL_AGE_H * 3600:
                todo.append(str(fid))
    todo.sort(key=lambda k: store[k]["fetched"])
    fetched = 0
    for fid in todo[:INTL_BATCH]:
        if offline:
            break
        try:
            d = _fotmob_get("playerData", {"id": fid})
        except Exception as e:
            print(f"FotMob player {fid} not read ({e})")
            continue
        rec = store[fid]
        nat = rec.get("nat")
        for m in d.get("recentMatches") or []:
            t = (m.get("matchDate") or {}).get("utcTime") or ""
            if t < INTL_FROM or not m.get("id"):
                continue
            if not ((nat and m.get("teamId") == nat) or (not nat and "national" in str(m.get("leagueName", "")).lower())):
                continue
            rec["matches"][str(m["id"])] = [t, m.get("opponentTeamName") or "", int(m.get("minutesPlayed") or 0), m.get("leagueName") or "", m.get("teamName") or ""]
        rec["fetched"] = now
        fetched += 1
        time.sleep(0.35)
    if fetched or todo:
        INTL_MINUTES.write_text(json.dumps(store, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"International minutes: {len(store)} players, {fetched} read from FotMob now, {max(0, len(todo) - fetched)} left for later runs")
    return store


def _fm_find(p: dict, names: dict):
    """The value for this FPL player in a {FotMob name: value} map of his club, or None."""
    full = _name_key(p.get("fullName") or p["name"])
    # exact full name first, then first and last name, then the web name inside the FotMob name; a loose match
    # counts only when it fits one player alone (Conor Bradley is not Bradley Barcola)
    for test in (lambda n: _name_key(n) == full,
                 lambda n: _name_key(n).split()[-1:] == full.split()[-1:] and _name_key(n).split()[:1] == full.split()[:1],
                 # every word of the FotMob name is in his full name, and his web name is in it: "Gabriel Magalhães"
                 lambda n: set(_name_key(n).split()) <= set(full.split()) and set(_name_key(p["name"]).split()) <= set(_name_key(n).split())):
        hits = [n for n in names if test(n)]
        if len(hits) == 1:
            return names[hits[0]]
        if len(hits) > 1:
            return None
    return None


def intl_tables(store: dict, players: dict) -> dict:
    """Per player, his national-team matches this season: [[nation, opponent, minutes, kick-off, competition]]."""
    by_club = {}
    for rec in store.values():  # every squad member, so a name is matched against the whole squad
        by_club.setdefault(rec.get("club"), {})[rec["name"]] = rec.get("matches") or {}
    out = {}
    for p in players.values():
        ms = _fm_find(p, by_club.get(p["team"], {}))
        if ms:
            out[p["id"]] = sorted(([nat, _club_short(opp), mins, t, comp] for t, opp, mins, comp, nat in ms.values()), key=lambda x: x[3])
    return out


def cup_tables(fx: dict, store: dict, boot: dict, players: dict) -> tuple[dict, dict]:
    """Per player, cup and European minutes in each past gameweek window ([competition, opponent, minutes, kick-off]); per
    club, cup and European matches still to come in each gameweek window ([competition, opponent, kick-off])."""
    by_name = {t["name"]: t for t in boot["teams"]}
    squads = {}
    for p in players.values():
        squads.setdefault(p["team"], []).append(p)
    past, nxt = {}, {}
    for t in fx["teams"]:
        squad = squads.get(t["short"], [])
        for m in t["matches"]:
            if m["comp"] not in CUP_CODES:  # league, friendlies, Community Shield, Super Cup
                continue
            gw = gw_of_time(m.get("t"), fx["gws"])
            if gw is None and m.get("t") and fx["gws"] and pd.Timestamp(m["t"]) < pd.Timestamp(min(fx["gws"], key=lambda g: g["gw"])["deadline"]):
                gw = 0  # before the first deadline: European qualifiers in the summer
            if gw is None:
                continue
            opp = m["oppShort"].upper() if m["home"] else m["oppShort"].lower()
            if m.get("score") is None:
                nxt.setdefault(t["short"], {}).setdefault(str(gw), []).append([m["comp"], opp, m.get("t")])
                continue
            rec = store.get(str(m.get("mid"))) or {}
            # this club's side in FotMob's names: the one whose players match the squad best
            sides = rec.get("teams") or {}
            def hits(names):
                return sum(1 for p in squad for n in names if _name_key(n).split()[-1:] == _name_key(p.get("fullName") or p["name"]).split()[-1:])
            side = max(sides.values(), key=hits, default={}) if sides else {}
            for p in squad:
                mins = _fm_find(p, side) or 0  # not in the match squad (or a name that fits two players): 0
                past.setdefault(p["id"], {}).setdefault(str(gw), []).append([m["comp"], opp, int(mins), m.get("t")])
    return past, nxt


def club_fixtures(cache: Path, offline: bool) -> dict:
    """{"gws": [{gw, deadline}], "teams": [{name, short, matches: [{t, comp, opp, oppShort, home, score, gw, stage}]}]}"""
    boot = _api("bootstrap-static/", cache, offline)
    fpl_fx = _api("fixtures/", cache, offline)
    teams = {t["id"]: t for t in boot["teams"]}
    by_name = {t["name"]: t for t in boot["teams"]}
    key_short = {_euro_key(t["name"]): t["short_name"] for t in boot["teams"]}
    key_short.update({_euro_key(k): by_name[v]["short_name"] for k, v in EURO_ALIASES.items() if v in by_name})
    key_short.update({_euro_key(k): by_name[v]["short_name"] for k, v in FOTMOB_TEAMS.items() if v in by_name})
    out = {t["id"]: [] for t in boot["teams"]}
    for f in fpl_fx:
        for side, opp, home in (("team_h", "team_a", True), ("team_a", "team_h", False)):
            o = teams[f[opp]]
            score = f"{f['team_h_score']} - {f['team_a_score']}" if f.get("finished") and f.get("team_h_score") is not None else None
            out[f[side]].append({"t": f.get("kickoff_time"), "comp": "PL", "opp": o["name"], "oppShort": o["short_name"], "home": home,
                                 "score": score, "gw": f.get("event")})
    folder = cache / "fotmob"
    folder.mkdir(parents=True, exist_ok=True)
    note = ""
    try:
        idx = folder / "league_table.json"
        if offline or (idx.exists() and time.time() - idx.stat().st_mtime < 6 * 3600):
            table = json.loads(idx.read_text())
        else:
            table = [(t["id"], t["name"]) for t in _fotmob_get("leagues", {"id": FOTMOB_LEAGUE, "ccode3": "GBR"})["table"][0]["data"]["table"]["all"]]
            idx.write_text(json.dumps(table))
    except Exception as e:
        table, note = [], f"FotMob not read ({e}): only league matches are shown"
        print(note)
    missed, lineups, members = [], {}, {}
    for fm_id, fm_name in table:
        t = by_name.get(FOTMOB_TEAMS.get(fm_name, fm_name)) or next((x for x in boot["teams"] if _name_key(x["name"]).split()[0] == _name_key(fm_name).split()[0]), None)
        if not t:
            missed.append(fm_name)
            continue
        f = folder / f"team_{fm_id}.json"
        data = None
        if offline or (f.exists() and time.time() - f.stat().st_mtime < 6 * 3600):
            data = json.loads(f.read_text()) if f.exists() else None
        else:
            try:
                d = _fotmob_get("teams", {"id": fm_id, "ccode3": "GBR"})
                fxs = ((d.get("fixtures") or {}).get("allFixtures") or {}).get("fixtures") or []
                data = {"fixtures": fxs, "lineup": None,
                        "roles": {m["name"]: m.get("positionIds") or "" for g in ((d.get("squad") or {}).get("squad") or []) for m in g.get("members") or [] if m.get("name")},
                        "members": [[m["name"], m.get("id"), m.get("nationalTeamId"), m.get("cname")] for g in ((d.get("squad") or {}).get("squad") or [])
                                    for m in g.get("members") or [] if m.get("name") and m.get("id") and (m.get("role") or {}).get("key") != "coach"]}
                # the line-up of the club's last league match (a cup side is often rotated)
                lm = [m for m in fxs if (m.get("tournament") or {}).get("name") == "Premier League" and (m.get("status") or {}).get("finished")]
                if lm:
                    lm = lm[-1]
                    md = _fotmob_get("matchDetails", {"matchId": lm["id"]})
                    lu = ((md.get("content") or {}).get("lineup") or {})
                    side = next((x for x in (lu.get("homeTeam"), lu.get("awayTeam")) if x and x.get("id") == fm_id), None)
                    if side and side.get("starters"):
                        data["lineup"] = {"formation": side.get("formation"),
                                          "match": {"home": (lm.get("home") or {}).get("name"), "away": (lm.get("away") or {}).get("name"), "t": (lm.get("status") or {}).get("utcTime")},
                                          "starters": [{"name": x.get("name"), "pid": x.get("positionId"), "x": (x.get("verticalLayout") or {}).get("x"),
                                                        "y": (x.get("verticalLayout") or {}).get("y")} for x in side["starters"]]}
                    time.sleep(0.4)
                f.write_text(json.dumps(data))
                time.sleep(0.4)
            except Exception as e:
                print(f"FotMob team {fm_name} not read ({e})")
                data = json.loads(f.read_text()) if f.exists() else None
                if data is None:
                    missed.append(fm_name)
        if isinstance(data, dict):
            members[t["short_name"]] = data.get("members") or []
            if (data.get("lineup") or {}).get("starters"):
                lineups[t["short_name"]] = dict(data["lineup"], roles=data.get("roles") or {})
            data = data.get("fixtures")
        for m in data or []:
            tour = (m.get("tournament") or {}).get("name") or ""
            st = m.get("status") or {}
            if tour in ("Premier League", "Community Shield", "Club Friendlies") or st.get("cancelled"):
                continue
            home = (m.get("home") or {}).get("id") == fm_id
            opp = (m.get("away") if home else m.get("home")) or {}
            name = opp.get("name") or "TBC"
            short = key_short.get(_euro_key(name)) or _club_short(name)
            out[t["id"]].append({"t": st.get("utcTime"), "comp": CLUB_COMPS.get(tour, tour), "opp": name, "oppShort": short, "home": home,
                                 "score": st.get("scoreStr") if st.get("finished") else None, "stage": (m.get("tournament") or {}).get("stage") or "", "mid": m.get("id")})
    if missed:
        print(f"Club fixtures: no cup matches for {', '.join(missed)}")
    for ms in out.values():
        ms.sort(key=lambda m: m["t"] or "9999")
    (folder / "lineups.json").write_text(json.dumps(lineups, ensure_ascii=False))
    (folder / "members.json").write_text(json.dumps(members, ensure_ascii=False))
    n = sum(len(v) for v in out.values())
    print(f"Club fixtures: {n} matches for {len(out)} teams, " + ", ".join(f"{c} {sum(m['comp'] == c for v in out.values() for m in v)}" for c in ["PL", *dict.fromkeys(CLUB_COMPS.values())]))
    return {"updatedAt": int(time.time() * 1000), "note": note,
            "gws": [{"gw": e["id"], "deadline": e["deadline_time"], "current": bool(e.get("is_current")), "next": bool(e.get("is_next"))} for e in boot["events"]],
            "teams": [{"name": t["name"], "short": t["short_name"], "matches": out[t["id"]]} for t in sorted(boot["teams"], key=lambda t: t["name"])]}


# ---------------------------------------------------------------- team news (FPL's own player news)
YELLOW_LIMITS = ((19, 5), (32, 10), (38, 15))  # yellow cards by the end of these gameweeks that bring a ban


XI_KEEP = 45  # a player from the last line-up keeps his place if we expect at least this many minutes from him
XI_SWAP = 10
# FotMob position ids -> role. Ids on the pitch from the keeper out: 32 right back ... 38 left back, 51-59 / 62, 68
# wing-backs, 63-67 holding midfield, 71-72 right midfield, 73-77 central midfield, 78-79 left midfield, 82-83 right
# wing, 84-86 attacking midfield, 87-88 left wing, 100+ strikers.


def ROLE_OF(pid) -> str:
    """FotMob position id -> role, with the side for central places (RCB/CB/LCB, RDM/DM/LDM, RCM/CM/LCM, RAM/AM/LAM,
    RST/ST/LST): FotMob numbers each line from the team's right to its left."""
    pid = int(pid or 0)
    if pid <= 11:
        return "GK"
    if pid < 40:
        return {32: "RB", 33: "RCB", 34: "RCB", 35: "CB", 36: "LCB", 37: "LCB", 38: "LB"}.get(pid, "CB")
    if pid < 70:
        if pid in (51, 52, 62):
            return "RWB"
        if pid in (58, 59, 68):
            return "LWB"
        return {63: "RDM", 64: "RDM", 65: "DM", 66: "LDM", 67: "LDM"}.get(pid, "DM")
    if pid < 80:
        return {71: "RM", 72: "RM", 73: "RCM", 74: "RCM", 75: "CM", 76: "LCM", 77: "LCM", 78: "LM", 79: "LM"}.get(pid, "CM")
    if pid < 100:
        return {81: "RW", 82: "RW", 83: "RW", 84: "RAM", 85: "AM", 86: "LAM", 87: "LW", 88: "LW", 89: "LW"}.get(pid, "AM")
    return {104: "RST", 106: "LST"}.get(pid, "ST")


SIDE_BASE = {"RCB": "CB", "LCB": "CB", "RDM": "DM", "LDM": "DM", "RCM": "CM", "LCM": "CM", "RAM": "AM", "LAM": "AM", "RST": "ST", "LST": "ST"}


def role_base(r: str) -> str:
    """The role without its side (RCB -> CB); full-backs and wingers keep theirs."""
    return SIDE_BASE.get(r, r)


ROLE_NEAR = {"RB": ("RWB",), "RWB": ("RB", "RM"), "LB": ("LWB",), "LWB": ("LB", "LM"), "DM": ("CM",), "CM": ("DM", "AM"),
             "AM": ("CM",), "RM": ("RW", "RWB"), "LM": ("LW", "LWB"), "RW": ("RM", "LW"), "LW": ("LM", "RW")}


def slot_pos_role(role: str) -> str:
    return {"GK": "GK", "RB": "DEF", "LB": "DEF", "CB": "DEF", "RWB": "DEF", "LWB": "DEF", "ST": "FWD"}.get(role_base(role), "MID")  # a player outside it comes in for a starter of his position we expect at least this many fewer minutes from


def likely_xi(squad: list[dict], lineup: dict | None, gw: int) -> tuple[list[dict], str | None, dict | None]:
    """The club's last league line-up (FotMob: formation and each starter's place), every place filled with the
    players that make expected minutes times fit for the place add up to the most. Without a line-up: the keeper and
    ten outfield players with the most expected minutes, in rows by position."""
    xmin = lambda p: float((p["byGw"].get(str(gw)) or {}).get("xmin") or 0)
    full = lambda p: _name_key(p.get("fullName") or p["name"])

    def find(name):
        n = _name_key(name)
        for test in (lambda p: full(p) == n, lambda p: _name_key(p["name"]) == n, lambda p: set(n.split()) <= set(full(p).split()),
                     lambda p: set(_name_key(p["name"]).split()) <= set(n.split()), lambda p: n.split()[-1] == full(p).split()[-1]):
            hit = [p for p in squad if test(p)]
            if len(hit) == 1:
                return hit[0]
        # spelling differs (Yeremi / Yeremy): closest short name to any word of his name
        import difflib
        best = max(((max(difflib.SequenceMatcher(None, _name_key(p["name"]), w).ratio() for w in n.split() + [n]), p) for p in squad), key=lambda x: x[0], default=(0, None))
        return best[1] if best[0] >= 0.8 else None

    row = lambda p, x, y, new, was=None: {"name": p["name"], "pos": p["position"], "xmin": round(xmin(p)), "x": x, "y": y, "new": new, "for": was}
    if not lineup or not lineup.get("starters"):
        order = {"GK": 0, "DEF": 1, "MID": 2, "FWD": 3}
        gk = sorted((p for p in squad if p["position"] == "GK"), key=xmin, reverse=True)[:1]
        rest = sorted((p for p in squad if p["position"] != "GK"), key=xmin, reverse=True)[:10]
        pick = sorted(gk + rest, key=lambda p: (order[p["position"]], -xmin(p)))
        out = []
        for pos, y in (("GK", .1), ("DEF", .32), ("MID", .58), ("FWD", .84)):
            line = [p for p in pick if p["position"] == pos]
            out += [row(p, (i + .5) / len(line), y, False) for i, p in enumerate(line)]
        return out, None, None
    # Roles from FotMob's squad list (each player's positions, best first), matched to FPL players by name.
    roles = {}
    for nm, ids in (lineup.get("roles") or {}).items():
        q = find(nm)
        if q:
            roles[q["id"]] = [ROLE_OF(int(x)) for x in str(ids).split(",") if x.strip().isdigit()]
    def slot_role(st):
        """The role of a place in the line-up. FotMob gives wide forwards in a front three a striker's id, so in the
        front line the place's side decides: FotMob's x runs from the team's right (0) to its left (1)."""
        r = ROLE_OF(st["pid"])
        front = sum(1 for o in lineup["starters"] if int(o.get("pid") or 0) >= 100)
        if role_base(r) == "ST" and st.get("x") is not None:
            if front >= 3:
                return "RW" if st["x"] < 0.35 else "LW" if st["x"] > 0.65 else "ST"
            if front == 2:
                return "RST" if st["x"] < 0.5 else "LST"
        return r

    starters = [(st, find(st["name"] or "")) for st in lineup["starters"]]
    for st, q in starters:  # what he played last time is a role of his too
        if q:
            roles.setdefault(q["id"], [])
            if slot_role(st) not in roles[q["id"]]:
                roles[q["id"]].append(slot_role(st))

    last_slot = {q["id"]: slot_role(st) for st, q in starters if q}

    def fit(q, role):
        """How well he suits a place: 1 for his main FotMob position, a little less for each later one, 0.6 for a
        neighbouring role (RB and RWB, CM and DM...), 0 for none; without FotMob positions, 0.5 for any place of his FPL
        position. A little more for the very place he played last time."""
        rs = roles.get(q["id"])
        if rs is None:
            f = 0.5 if slot_pos_role(role) == q["position"] else 0  # unknown to FotMob: only when no one suits better
        elif role in rs:
            f = max(0.75, 1 - 0.07 * rs.index(role))
        elif any(role_base(r) == role_base(role) for r in rs):
            # the same place on the other side, or in the middle (a left centre back playing on the right)
            k = next(i for i, r in enumerate(rs) if role_base(r) == role_base(role))
            f = 0.9 * max(0.75, 1 - 0.07 * k)
        else:
            f = 0.6 if any(role_base(role) in ROLE_NEAR.get(role_base(r), ()) for r in rs) else 0
        if role == "GK" or q["position"] == "GK":
            f = f if role == "GK" and q["position"] == "GK" else 0
        return f * (1.08 if last_slot.get(q["id"]) == role else 1)

    # The XI: every place of the last line-up filled so that expected minutes times fit add up to the most (an
    # assignment problem), so a centre back's injury can move the right back inside and bring in another right back.
    from scipy.optimize import linear_sum_assignment
    cands = [q for q in squad if xmin(q) > 0]
    slot_roles = [slot_role(st) for st, _ in starters]
    value = np.array([[xmin(q) * fit(q, r) for q in cands] for r in slot_roles]) if cands else np.zeros((len(slot_roles), 0))
    out = []
    if value.size:
        rows_i, cols_i = linear_sum_assignment(-value)
        pick = dict(zip(rows_i, cols_i))
        before = {q["id"] for _, q in starters if q}
        for k, (st, q) in enumerate(starters):
            j = pick.get(k)
            if j is None or value[k, j] <= 0:
                continue
            c = cands[j]
            out.append(dict(row(c, st["x"], st["y"], c["id"] not in before, None), role=slot_roles[k]))
    chosen = {o["name"] for o in out}
    gone = [q["name"] if q else st["name"] for st, q in starters if (q["name"] if q else st["name"]) not in chosen]
    m = lineup.get("match") or {}
    return out, lineup.get("formation"), {"home": m.get("home"), "away": m.get("away"), "t": m.get("t"), "out": gone}


def team_news(cache: Path, offline: bool, players: dict, first_gw: int) -> dict:
    """Per club: next match, a likely XI from our xMin, and FPL's news for every flagged player (out, doubtful,
    banned), plus players one yellow card away from a ban."""
    boot = _api("bootstrap-static/", cache, offline)
    fx = _api("fixtures/", cache, offline)
    teams = {t["id"]: t for t in boot["teams"]}
    by_code = {f"c{p['code']}": p for p in boot["elements"]}
    pos = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
    limit = next(((gw, n) for gw, n in YELLOW_LIMITS if first_gw <= gw), None)
    lf = cache / "fotmob" / "lineups.json"
    lineups = json.loads(lf.read_text(encoding="utf-8")) if lf.exists() else {}
    out = []
    for tid, t in sorted(teams.items(), key=lambda x: x[1]["name"]):
        nxt = sorted((f for f in fx if not f.get("finished") and f.get("event") and f["event"] >= first_gw and tid in (f["team_h"], f["team_a"])),
                     key=lambda f: (f["event"], f.get("kickoff_time") or ""))
        nm = [{"gw": f["event"], "t": f.get("kickoff_time"), "home": f["team_h"] == tid,
               "opp": teams[f["team_a"] if f["team_h"] == tid else f["team_h"]]["short_name"]} for f in nxt if f["event"] == (nxt[0]["event"] if nxt else None)]
        squad = [p for p in players.values() if p["team"] == t["short_name"]]
        xmin = lambda p: float((p["byGw"].get(str(first_gw)) or {}).get("xmin") or 0)
        xi, formation, last = likely_xi(squad, lineups.get(t["short_name"]), first_gw)
        news, watch = [], []
        for e in boot["elements"]:
            if e["team"] != tid or e.get("status") == "u":
                continue
            item = {"name": e["web_name"], "pos": pos[e["element_type"]], "status": e.get("status"), "news": e.get("news") or "",
                    "added": e.get("news_added"), "chance": e.get("chance_of_playing_next_round"), "xmin": round(xmin(players[f"c{e['code']}"])) if f"c{e['code']}" in players else None}
            mine = players.get(f"c{e['code']}") or {}
            if e.get("status") in ("i", "d") and mine.get("status") == "a" and str(mine.get("news", "")).startswith("Played"):
                # played a full match since FPL's flag: taken as fit, listed under other news with the reason
                item.update(status="a", chance=None, news=mine["news"])
            if item["status"] in ("i", "n", "s", "d") or (item["news"] and item["status"] == "a"):
                news.append(item)
            if limit and e.get("yellow_cards", 0) == limit[1] - 1 and e.get("status") != "s":
                watch.append({"name": e["web_name"], "pos": pos[e["element_type"]], "yellows": e["yellow_cards"]})
        news.sort(key=lambda x: x["added"] or "", reverse=True)
        out.append({"name": t["name"], "short": t["short_name"], "next": nm, "xi": xi, "formation": formation, "lastXi": last, "news": news, "watch": watch,
                    "lastNews": max((x["added"] for x in news if x["added"]), default=None)})
    nev = next((e for e in boot["events"] if e["id"] == first_gw), None)
    print(f"Team news: {sum(len(t['news']) for t in out)} flagged players, {sum(len(t['watch']) for t in out)} one yellow from a ban")
    return {"updatedAt": int(time.time() * 1000), "gw": first_gw, "deadline": nev["deadline_time"] if nev else None,
            "yellowLimit": {"gw": limit[0], "cards": limit[1]} if limit else None, "teams": out}


def gw_span(a, b) -> str:
    return f"GW{a}" if int(a) == int(b) else f"GW{a}-GW{b}"


def absence_news(r: dict) -> str:
    """FPL's news for an absence, for the reasons on the Minutes page; absences filled in from Sofascore's record have
    no FPL news kept."""
    news = str(r.get("news") or "").strip()
    if not news:
        return ""
    if "from sofascore" in news.lower():
        return " (from Sofascore's injury record)"
    return f" (FPL: {news})"


def mark_injuries(df: pd.DataFrame, log: list[dict], admin: dict | None = None, hurt: set | None = None, covered: set | None = None) -> pd.DataFrame:
    """Flags matches inside each absence ("inj_skip"), so the formula leaves them out: the zero-minute ones for a
    logged absence, every match for one the admin added by hand (he may have gone off injured early), and for a
    logged injury the match just before it if he did not play all of it ("inj_hurt": he got hurt in it), and his
    recovery matches ("inj_rest": inside the return rule's window, under his usual minutes from before the injury)"""
    df = df.copy()
    df["inj_skip"] = False
    df["inj_hurt"] = False
    df["inj_rest"] = False
    df["inj_tac"] = False
    df["inj_note"] = ""  # what the absence was, for the reason shown on the Minutes page
    season = ~df["future"] & (df["season"] == CURRENT_SEASON) & df["minutes"].notna()
    manual_rows = set()  # matches inside an absence the admin set by hand: always left out
    for r in merged_injuries(log, admin or {"manual": [], "startOverrides": {}}):
        if r.get("season") != CURRENT_SEASON:
            continue
        end = r["endGw"] if r.get("manual") and r.get("endGw") is not None else (r["returnedGw"] - 1) if r.get("returnedGw") else 99
        rows = season & (df["pid"] == r["pid"]) & df["GW"].between(r["startGw"], end)
        df.loc[rows if r.get("manual") else rows & (df["minutes"] == 0), "inj_skip"] = True
        if r.get("manual"):
            manual_rows.update(df.index[rows])
        span = gw_span(r["startGw"], end) if r.get("returnedGw") or (r.get("manual") and r.get("endGw") is not None) else f"GW{r['startGw']} on, not back yet"
        if r.get("manual"):  # the admin's own type and note
            admin_note = str(r.get("news") or "").strip()
            note = f"{str(r.get('type') or 'Absence')} (set by the admin), {span}" + (f": {admin_note}" if admin_note else "")
        else:
            note = f"{str(r.get('type') or 'Absence')}, {span}" + absence_news(r)
        df.loc[(rows if r.get("manual") else rows & (df["minutes"] == 0)) & (df["inj_note"].eq("") | bool(r.get("manual"))), "inj_note"] = note
        # The match he got hurt in: his last match before an injury absence, if he did not play all of it, is left out too.
        if not r.get("manual") and str(r.get("type") or "Injury").lower().startswith("injur"):
            before = df.index[season & (df["pid"] == r["pid"]) & (df["GW"] < r["startGw"])]
            if len(before):
                last = df.loc[before].sort_values(["GW", "kickoff_time"]).index[-1]
                # with FotMob's match events for that gameweek, only a substitution for injury counts (below)
                if int(df.at[last, "GW"]) not in (covered or set()) and 0 < float(df.at[last, "minutes"]) < 90:
                    df.at[last, "inj_skip"] = True
                    df.at[last, "inj_hurt"] = True
                    df.at[last, "inj_note"] = (f"Played {int(df.at[last, 'minutes'])} minutes, his last match before the injury absence from GW{r['startGw']}"
                                               + absence_news(r) + ": taken to be the match he got hurt in")
        # Recovery: his matches back inside the return rule's window (RETURN_RULES: the first match, or up to 14 or 28
        # days after it, by how long he was out) count in the formula only when he played at least his usual minutes
        # from before the injury; a lower figure is the recovery, not his place, and is left out. Once he has played
        # his usual minutes again the recovery is over.
        if not r.get("manual") and str(r.get("type") or "Injury").lower().startswith("injur") and r.get("returnedGw"):
            mine = (df["pid"] == r["pid"]) & ~df["future"] & df["minutes"].notna()
            post = df.loc[season & mine & (df["GW"] >= r["returnedGw"])].sort_values(["GW", "kickoff_time"])
            missed = df.loc[season & mine & df["GW"].between(r["startGw"], int(r["returnedGw"]) - 1), "kickoff_time"]
            if len(post):
                k0 = pd.to_datetime(post["kickoff_time"].iloc[0], utc=True)
                out_days = (k0 - pd.to_datetime(missed, utc=True).min()).days if len(missed) else 7
                pre = df.loc[mine & (pd.to_datetime(df["kickoff_time"], utc=True) < (pd.to_datetime(missed, utc=True).min() if len(missed) else k0))
                             & ~df["inj_skip"] & ~df["yellow_ban"].fillna(False).astype(bool)].sort_values("kickoff_time")["minutes"].tail(5).to_numpy(float)[::-1]
                w = np.array(MINUTE_WEIGHTS[:len(pre)], float)
                usual_pre = float(np.dot(pre, w) / w.sum()) if len(pre) else 0.0
                window = return_window(out_days)
                for i, row in post.iterrows():
                    since = (pd.to_datetime(row["kickoff_time"], utc=True) - k0).days
                    if i != post.index[0] and since > window:
                        break
                    if float(row["minutes"]) >= usual_pre:
                        break  # back to his usual minutes: the recovery is over, later matches count as normal
                    if float(row["minutes"]) < usual_pre:
                        df.at[i, "inj_skip"] = True
                        df.at[i, "inj_rest"] = True
                        df.at[i, "inj_note"] = (f"Reduced minutes after injury: {int(row['minutes'])} minutes "
                                                f"{'in his first match back' if i == post.index[0] else f'{since} days after his first match back'} "
                                                f"from {out_days} days out ({gw_span(r['startGw'], int(r['returnedGw']) - 1)}), under his usual {round(usual_pre)} before it"
                                                + absence_news(r))
    # gameweeks whose matches FotMob's events cover (there, only a substitution for injury counts as getting hurt)
    df["fm_cov"] = season & df["GW"].isin(list(covered or []))
    # Taken off injured (FotMob): that match is left out, whatever came after.
    if hurt:
        keys = pd.Series(list(zip(df["pid"], df["GW"].fillna(-1).astype(int))), index=df.index)
        rows = season & keys.isin(hurt)
        df.loc[rows, "inj_skip"] = True
        df.loc[rows, "inj_hurt"] = True
        df.loc[rows, "inj_note"] = "Taken off injured after " + df.loc[rows, "minutes"].fillna(0).astype(int).astype(str) + " minutes (FotMob's match events)"
    if TACTICAL:
        keys = pd.Series(list(zip(df["pid"], df["GW"].fillna(-1).astype(int))), index=df.index)
        for (pid, gw), txt in TACTICAL.items():
            rows = season & (keys == (pid, gw)) & ~df["inj_skip"]
            df.loc[rows, ["inj_skip", "inj_tac"]] = True
            df.loc[rows, "inj_note"] = txt
    # A goalkeeper who came on for his injured team-mate: that part match says nothing of his role, left out too.
    df["gk_cover"] = False
    if "position" in df and df["inj_hurt"].any():
        gk = season & (df["position"] == "GK")
        hurt_fx = set(zip(df.loc[gk & df["inj_hurt"], "fixture"], df.loc[gk & df["inj_hurt"], "team"]))
        cover = gk & ~df["inj_hurt"] & (df["minutes"] > 0) & (df["minutes"] < 90) & pd.Series(list(zip(df["fixture"], df["team"])), index=df.index).isin(hurt_fx)
        df.loc[cover, "inj_skip"] = True
        df.loc[cover, "gk_cover"] = True
        df.loc[cover, "inj_note"] = "Came on for the injured starting goalkeeper and played " + df.loc[cover, "minutes"].fillna(0).astype(int).astype(str) + " minutes"
    # A match he got hurt in or a recovery match is left out only if it would pull his usual minutes down. Where he
    # played at least the usual minutes the formula gives without it (5-4-3-2-1 of his 5 counted matches before it),
    # keeping it can only raise them, so it counts as normal and is not flagged.
    cand = df.index[season & (df["inj_hurt"] | df["inj_rest"] | df["inj_tac"]) & ~df["gk_cover"] & (df["minutes"] > 0) & ~df.index.isin(list(manual_rows))]
    kept = 0
    for pid in df.loc[cand, "pid"].unique():
        g = df.loc[(df["pid"] == pid) & ~df["future"] & df["minutes"].notna()].sort_values("kickoff_time")
        for i in g.index:
            if i not in cand:
                continue
            prev = g.loc[:i].iloc[:-1]
            prev = prev.loc[~skipped(df.loc[prev.index]), "minutes"].tail(5).to_numpy(float)[::-1]
            if not len(prev):
                continue
            w = MINUTE_WEIGHTS[:len(prev)]
            usual = float(np.dot(prev, w) / w.sum())
            if float(df.at[i, "minutes"]) >= usual:
                df.loc[i, ["inj_skip", "inj_hurt", "inj_rest", "inj_tac"]] = False
                df.at[i, "inj_note"] = ""
                kept += 1
    if kept:
        print(f"Hurt or recovery matches kept in the formula, at or above his usual minutes without them: {kept}")
    print(f"Matches left out as injury absences: {int(df['inj_skip'].sum())}, of them matches he got hurt in: {int(df['inj_hurt'].sum())}, recovery matches under his usual: {int(df['inj_rest'].sum())}")
    return df


def build_features(df: pd.DataFrame, fm_oop: dict | None = None) -> pd.DataFrame:
    df = df.copy()
    last_hist = df.loc[~df["future"], "t"].max()
    df["tf"] = np.where(df["future"], last_hist + 1, df["t"])  # future GWs all see the same history

    ratings, venue = team_features(df)
    ratings = ratings.drop(columns="league_g")
    df = df.merge(ratings.rename(columns={"att_ratio": "team_att", "def_ratio": "team_def", "att_g_ratio": "team_att_g", "def_g_ratio": "team_def_g"}), on=["team", "tf"], how="left")
    df = df.merge(ratings.rename(columns={"team": "opp", "att_ratio": "opp_att", "def_ratio": "opp_def", "att_g_ratio": "opp_att_g", "def_g_ratio": "opp_def_g"}), on=["opp", "tf"], how="left")
    df["home_i"] = df["was_home"].astype(int)
    df = df.merge(venue[["team", "home", "tf", "def_gv"]].rename(columns={"home": "home_i", "def_gv": "team_def_gv"}), on=["team", "home_i", "tf"], how="left")
    df["opp_home_i"] = 1 - df["home_i"]
    df = df.merge(venue[["team", "home", "tf", "att_gv"]].rename(columns={"team": "opp", "home": "opp_home_i", "att_gv": "opp_att_gv"}), on=["opp", "opp_home_i", "tf"], how="left")

    obs = ~df["future"]
    mins = df["minutes"].where(obs, 0).fillna(0)
    # Penalties: rate players on non-penalty xG and goals. Core Insights counts penalties from 2024-25; before that,
    # each match's penalties are estimated from the season's FPL penalty order.
    known = df["has_core"].fillna(False).astype(bool) & obs if "has_core" in df else pd.Series(False, index=df.index)
    teams_matches = df.loc[known].drop_duplicates(["season", "fixture", "team"]).shape[0]
    taken = (df["core_pen_scored"].fillna(0) + df["core_pen_missed"].fillna(0)).where(known, 0)
    # Each taker's penalties and misses where they are counted, for his own miss rate.
    df["pen_taken_k"], df["pen_missed_k"] = taken, df["core_pen_missed"].fillna(0).where(known, 0)
    df["league_pen_miss"] = 1 - PEN_CONVERSION  # the long-run rate: a few hundred penalties are too few to measure it better
    # Share of penalties the goalkeeper saves, where penalties are counted.
    saved = df.loc[known & (df["position"] == "GK"), "penalties_saved"].fillna(0).sum()
    df["league_pen_save"] = float(np.clip(saved / taken.sum(), 0.05, 0.3)) if taken.sum() > 200 else PEN_SAVE_SHARE
    if teams_matches > 100:
        rate = taken.sum() / teams_matches
    else:
        teams_matches = df.loc[obs].drop_duplicates(["season", "fixture", "team"]).shape[0]
        rate = df.loc[obs, "penalties_missed"].fillna(0).sum() / (1 - PEN_CONVERSION) / max(teams_matches, 1)
    df["league_pen_rate"] = float(np.clip(rate, 0.08, 0.2))
    df["pen_share_hist"] = pd.to_numeric(df["pen_order"], errors="coerce").map(HIST_PEN_SHARE).fillna(0.0)
    expected_pens = df["pen_share_hist"] * df["league_pen_rate"] * mins / 90
    pens_taken = taken.where(known, expected_pens)
    pen_goals = df["core_pen_scored"].fillna(0).where(known, expected_pens * PEN_CONVERSION)
    df["np_xg"] = (df["expected_goals"] - pens_taken * PEN_XG).clip(lower=0)
    df["np_goals"] = (df["goals_scored"] - pen_goals).clip(lower=0)
    pen_xgot = df["core_pen_scored"].fillna(0) * PEN_XGOT_SCORED + df["core_pen_missed"].fillna(0) * PEN_XGOT_MISSED
    df["np_xgot"] = (df["core_xgot"] - pen_xgot).clip(lower=0).where(known, 0.0)
    df["np_xg_known"] = df["np_xg"].where(known, 0.0)
    dc = df["defensive_contribution"]
    thr = df["position"].map(DEFCON_THRESHOLD)
    can_defcon = obs & dc.notna() & thr.notna() & (mins >= 60)
    if "starts" in df and df["starts"].notna().any():
        started = df["starts"].fillna((mins >= 60).astype(float))
    else:
        started = (mins >= 60).astype(float)

    roll = pd.DataFrame({
        "pid": df["pid"], "tf": df["tf"], "position": df["position"], "future": df["future"],
        "mins": mins, "n90": mins / 90, "g": df["np_goals"], "a": df["assists"],
        "xg": df["np_xg"], "xa": df["expected_assists"], "bon": df["bonus"], "bps": df["bps"],
        "sv": df["saves"], "yc": df["yellow_cards"], "rc": df["red_cards"], "xgot": df["np_xgot"], "xgk": df["np_xg_known"], "ps": df["penalties_saved"], "pm": df["penalties_missed"], "og": df["own_goals"], "pts": df["total_points"],
        "ptk": df["pen_taken_k"], "pmk": df["pen_missed_k"],
        "box": df["core_box"].fillna(0), "boxn90": (mins / 90).where(df["has_core"].fillna(False).astype(bool), 0),
        "st": started.where(obs, 0), "n": obs.astype(float),
        "ban": (skipped(df) & obs).astype(float),
        "dh": (can_defcon & (dc >= thr)).astype(float), "do": can_defcon.astype(float),
        # defensive actions where FPL counts them (from 2025-26), any minutes
        "dcs": dc.where(obs & dc.notna() & (mins > 0), 0).fillna(0), "dcn": (mins / 90).where(obs & dc.notna() & (mins > 0), 0),
    })
    stat = ["mins", "n90", "g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "rc", "xgot", "xgk", "ps", "pm", "og", "pts", "box", "boxn90", "st", "n", "dh", "do", "ban", "ptk", "pmk", "dcs", "dcn"]
    roll[stat] = roll[stat].where(obs, 0).fillna(0.0)
    p = roll.groupby(["pid", "tf"], as_index=False, sort=True)[stat].sum()
    keys = p["pid"].to_numpy()
    n90 = p["n90"].to_numpy(float)
    for c in ["n90", "g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "rc", "ps", "pm", "og"]:
        p[f"L_{c}"] = decayed_pre(keys, p[c].to_numpy(float), HL_LONG)
        p[f"S_{c}"] = decayed_pre(keys, p[c].to_numpy(float), HL_SHORT)
    p["L_dcs"], p["L_dcn"] = decayed_pre(keys, p["dcs"].to_numpy(float), HL_LONG), decayed_pre(keys, p["dcn"].to_numpy(float), HL_LONG)
    for c in ("ptk", "pmk"):  # penalties taken and missed, equal weights over the latest 114 matches
        p[f"Q_{c}"] = decayed_pre(keys, p[c].to_numpy(float), 1e9, 114)
    for c, (hl, cap, _) in RARE_MEMORY.items():
        p[f"Q_{c}"] = decayed_pre(keys, p[c].to_numpy(float), hl, cap)
        p[f"Q_n90_{c}"] = decayed_pre(keys, p["n90"].to_numpy(float), hl, cap)
    for c, hl, tag in [("mins", HL_MIN_SHORT, "ms"), ("n", HL_MIN_SHORT, "ns"), ("st", HL_MIN_SHORT, "ss"),
                       ("mins", HL_MIN_LONG, "ml"), ("n", HL_MIN_LONG, "nl"), ("dh", HL_LONG, "dh"), ("do", HL_LONG, "do")]:
        p[f"X_{tag}"] = decayed_pre(keys, p[c].to_numpy(float), hl)
    g = p.groupby("pid")
    p["min_last"] = g["mins"].shift(1) / g["n"].shift(1).replace(0, np.nan)
    p["pts4"] = (g["pts"].transform(lambda s: s.shift(1).rolling(4, min_periods=1).sum())
                 / g["n"].transform(lambda s: s.shift(1).rolling(4, min_periods=1).sum()).replace(0, np.nan))
    p["ppg_all"] = g["pts"].transform(lambda s: s.shift(1).expanding().sum()) / g["n"].transform(lambda s: s.shift(1).expanding().sum()).replace(0, np.nan)
    p["n_hist"] = g["n"].transform(lambda s: s.shift(1).fillna(0).cumsum())
    for c in ["g", "xg", "xgot", "xgk"]:
        p[f"F_{c}"] = decayed_pre(keys, p[c].to_numpy(float), HL_FINISH)
    p["w5_min"], p["w5_p1"], p["w5_p60"], p["ret_min"], p["ret_p1"], p["ret_p60"], p["recent_mins"] = ai_minutes(keys, p["mins"].to_numpy(float), p["n"].to_numpy(float), p["rc"].to_numpy(float), p["ban"].to_numpy(float))
    p["w5_st"], p["w5_ms"], p["w5_mb"], p["ret_st"], p["ret_ms"], p["ret_mb"], p["w5_last"], p["ret_last"] = ai_starts(keys, p["mins"].to_numpy(float), p["st"].to_numpy(float), p["n"].to_numpy(float), p["rc"].to_numpy(float), p["ban"].to_numpy(float))
    for c in ["n90", "xg", "xa", "box", "boxn90"]:
        p[f"R_{c}"] = decayed_pre(keys, p[c].to_numpy(float), HL_ROLE)
    p = p.drop(columns=stat)
    p["min_short"] = p["X_ms"] / p["X_ns"].replace(0, np.nan)
    p["min_long"] = p["X_ml"] / p["X_nl"].replace(0, np.nan)
    p["start_rate"] = p["X_ss"] / p["X_ns"].replace(0, np.nan)

    # Playing role: a player listed in one position but playing a more attacking one (out of position, OOP).
    # Uses recent touches in the opposition box and non-penalty xG + xA per 90, against the medians of each position.
    prow = roll.groupby(["pid", "tf"], as_index=False).agg(position=("position", "first"))
    p = p.merge(prow, on=["pid", "tf"], how="left")
    p["role_box90"] = p["R_box"] / p["R_boxn90"].where(p["R_boxn90"] >= ROLE_MIN_90S)
    p["role_xgi90"] = (p["R_xg"] + p["R_xa"]) / p["R_n90"].where(p["R_n90"] >= ROLE_MIN_90S)
    known = p[p["role_box90"].notna() & p["role_xgi90"].notna()]
    med = known.groupby("position")[["role_box90", "role_xgi90"]].median()
    p["role"] = p["position"]
    for listed, played in (("DEF", "MID"),):  # only defenders playing in midfield or attack
        if played in med.index:
            up = (p["position"] == listed) & (p["role_box90"] >= med.at[played, "role_box90"]) & (p["role_xgi90"] >= med.at[played, "role_xgi90"])
            p.loc[up, "role"] = played
    # Where FotMob's line-ups know his recent places, they decide instead (coming gameweeks): the share below.
    if fm_oop:
        fut_tf = df.loc[df["future"], "tf"].max() if df["future"].any() else None
        if fut_tf is not None:
            p.loc[(p["position"] == "DEF") & p["pid"].isin(list(fm_oop)) & (p["tf"] == fut_tf), "role"] = "DEF"
    for played in ("MID", "FWD"):
        for c in ("role_box90", "role_xgi90"):
            p[f"med_{c}_{played}"] = med.at[played, c] if played in med.index else np.nan
    p = p.drop(columns="position")
    roll = roll.merge(p[["pid", "tf", "role"]], on=["pid", "tf"], how="left")
    roll["role"] = roll["role"].fillna(roll["position"])

    def priors(group: str) -> pd.DataFrame:
        cols = ["n90", "g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "rc", "ps", "pm", "og", "dh", "do", "dcs", "dcn"]
        t = roll[~roll["future"]].groupby([group, "tf"], as_index=False)[cols].sum()
        idx = pd.MultiIndex.from_product([POSITIONS, sorted(df["tf"].unique())], names=[group, "tf"])
        t = t.set_index([group, "tf"]).reindex(idx, fill_value=0.0).sort_index()
        raw = t.copy()
        t = t.groupby(group).cumsum().groupby(group).shift(1).fillna(0.0)
        for c in ["g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "rc", "ps", "pm", "og"]:
            t[f"p_{c}"] = (t[c] / t["n90"].replace(0, np.nan)).fillna(EPS)
        # Red cards: newer seasons count more (each season back about half as much), as the rate has been falling.
        ew = lambda c: raw[c].groupby(level=0).transform(lambda x: x.ewm(halflife=RED_HALFLIFE_TF, adjust=True).mean()).groupby(level=0).shift(1)
        t["p_rc"] = (ew("rc") / ew("n90").replace(0, np.nan)).fillna(t["p_rc"]).replace(0, EPS)
        t["p_dh"] = (t["dh"] / t["do"].replace(0, np.nan)).fillna(0.0)
        t["p_dc"] = (t["dcs"] / t["dcn"].replace(0, np.nan)).fillna(DC_PRIOR_DEFAULT)
        return t[[c for c in t.columns if c.startswith("p_")]].reset_index()

    df = df.merge(p, on=["pid", "tf"], how="left")
    df["role"] = df["role"].fillna(df["position"])
    by_role = priors("role").drop(columns="p_dh").rename(columns={"role": "role"})
    by_position = priors("position")[["position", "tf", "p_dh"]]  # noqa: keep p_dc from role  # DefCon thresholds follow the FPL position
    df = df.merge(by_role, on=["role", "tf"], how="left").merge(by_position, on=["position", "tf"], how="left")
    # Partly out of position (FotMob line-ups, coming gameweeks only): a defender who starts some matches in midfield or
    # on a wing gets the defender and midfielder averages mixed by that share (his own record is used as for anyone).
    df["oop_share"] = 0.0
    if fm_oop:
        rows = df["future"] & (df["position"] == "DEF") & (df["role"] == "DEF") & df["pid"].isin(list(fm_oop))
        if rows.any():
            sh = df.loc[rows, "pid"].map(lambda q: fm_oop[q]["share"]).astype(float)
            mid = by_role[by_role["role"] == "MID"].set_index("tf")
            for c in [c for c in by_role.columns if c.startswith("p_")]:
                df.loc[rows, c] = (1 - sh) * df.loc[rows, c] + sh * df.loc[rows, "tf"].map(mid[c]).astype(float)
            df.loc[rows, "oop_share"] = sh

    for c in ["g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "rc", "ps", "pm", "og"]:
        k = K_RED if c == "rc" else K_PEN if c in ("ps", "pm", "og") else K_FINISH if c in ("g", "a") else K_PLAYER
        if c == "rc":
            df["r_rc"] = df["p_rc"]
        elif c in RARE_MEMORY:
            k = RARE_MEMORY[c][2]
            df[f"r_{c}"] = (df[f"Q_{c}"] + k * df[f"p_{c}"]) / (df[f"Q_n90_{c}"] + k)
        else:
            df[f"r_{c}"] = (df[f"L_{c}"] + k * df[f"p_{c}"]) / (df["L_n90"] + k)
        df[f"f_{c}"] = (df[f"S_{c}"] + K_SHORT * df[f"r_{c}"]) / (df["S_n90"] + K_SHORT)
    df["defcon_rate"] = (df["X_dh"] + K_PLAYER * df["p_dh"]) / (df["X_do"] + K_PLAYER)
    # Defensive actions per 90 (the DefCon count), shrunk to the role average.
    df["r_dc"] = (df["L_dcs"].fillna(0) + K_PLAYER * df["p_dc"].fillna(DC_PRIOR_DEFAULT)) / (df["L_dcn"].fillna(0) + K_PLAYER)
    df["l_dc"] = np.log(df["r_dc"].clip(lower=0.1))
    # Bonus goes to the top 3 BPS in a match: his BPS rate against the best 3 regulars in the same fixture.
    top3 = (df[df["min_long"].fillna(0) >= 60].groupby(["season", "fixture"])["r_bps"]
            .apply(lambda s: s.nlargest(3).mean()))
    best = pd.MultiIndex.from_arrays([df["season"], df["fixture"]]).map(top3.to_dict().get)
    df["rel_bps"] = (np.log(df["r_bps"].clip(lower=EPS)) - np.log(pd.Series(best, index=df.index, dtype=float).clip(lower=EPS))).fillna(0.0)
    lm = df["league_pen_miss"] if "league_pen_miss" in df else 1 - PEN_CONVERSION
    df["pen_miss_rate"] = (df["Q_pmk"].fillna(0) + K_PEN_MISS * lm) / (df["Q_ptk"].fillna(0) + K_PEN_MISS)

    ln = lambda s: np.log(s.clip(lower=EPS))
    df["l_xg"], df["l_xa"] = ln(df["r_xg"]), ln(df["r_xa"])
    df["form_xg"], df["form_xa"] = ln(df["f_xg"]) - ln(df["r_xg"]), ln(df["f_xa"]) - ln(df["r_xa"])
    df["finish"], df["creat"] = ln(df["r_g"]) - ln(df["r_xg"]), ln(df["r_a"]) - ln(df["r_xa"])
    # Long-run finishing over several seasons: non-penalty goals and xGOT against non-penalty xG, shrunk by xG volume.
    df["finish_goals"] = np.log((df["F_g"] + K_FINISH_XG) / (df["F_xg"] + K_FINISH_XG))
    df["finish_xgot"] = np.log((df["F_xgot"] + K_XGOT) / (df["F_xgk"] + K_XGOT))
    # Fixed-weight blends of a player's goals, xG and xGOT rates (log scale); the xG weight is what is left over.
    for mode, (w_goals, w_xg, w_xgot, k) in GOAL_MODES.items():
        if mode != "learned":
            fg = np.log((df["F_g"] + k) / (df["F_xg"] + k))
            fo = np.log((df["F_xgot"] + k) / (df["F_xgk"] + k))
            df[f"blend_{mode}"] = df["l_xg"] + w_goals * fg + w_xgot * fo
    df["l_bon"], df["l_bps"], df["form_bps"] = ln(df["r_bon"]), ln(df["r_bps"]), ln(df["f_bps"]) - ln(df["r_bps"])
    df["l_sv"], df["l_yc"] = ln(df["r_sv"]), ln(df["r_yc"])
    for c in ["team_att", "team_def", "opp_att", "opp_def"]:
        df[f"l_{c}"] = ln(df[c].fillna(1.0))
        df[f"gap_{c}"] = ln(df[f"{c}_g"].fillna(1.0)) - df[f"l_{c}"]  # real goals relative to xG
    # Clean sheet inputs: real goals and xG blended with fixed weights, optionally from the venue-specific goal record.
    for mode, cfg in CS_MODES.items():
        if cfg is None:
            continue
        w, venue_only = cfg
        dg = df["team_def_gv"] if venue_only else df["team_def_g"]
        ag = df["opp_att_gv"] if venue_only else df["opp_att_g"]
        df[f"cs_def_{mode}"] = w * ln(dg.fillna(1.0)) + (1 - w) * df["l_team_def"]
        df[f"cs_att_{mode}"] = w * ln(ag.fillna(1.0)) + (1 - w) * df["l_opp_att"]
    for pos_name in POSITIONS[1:]:
        df[f"is_{pos_name}"] = (df["role"] == pos_name).astype(float)  # how he plays; points still follow the FPL position
    df["is_DEF"] -= df["oop_share"]
    df["is_MID"] += df["oop_share"]
    df["pos_code"] = df["position"].map({p: i for i, p in enumerate(POSITIONS)})
    return df


# ---------------------------------------------------------------- model
PDUM = ["is_DEF", "is_MID", "is_FWD"]
GLMS = {
    # Goals: one blend of the player's goals 50%, xG 25%, xGOT 25% (log scale, padded with 15 average xG), then form, team, opponent and venue.
    "goals": ("np_goals", ["blend_g50", "form_xg", "l_team_att", "gap_team_att", "l_opp_def", "gap_opp_def", "was_home"] + PDUM),
    "assists": ("assists", ["l_xa", "form_xa", "creat", "l_team_att", "gap_team_att", "l_opp_def", "gap_opp_def", "was_home"] + PDUM),
    "bonus": ("bonus", ["l_bon", "l_bps", "form_bps", "rel_bps", "l_team_att", "gap_team_att", "l_opp_def", "gap_opp_def", "l_opp_att", "gap_opp_att", "was_home"] + PDUM),
    "yellow": ("yellow_cards", ["l_yc", "was_home"] + PDUM),
}
TEAM_FEATS_LEARNED = ["l_team_def", "gap_team_def", "l_opp_att", "gap_opp_att", "was_home"]
# Clean sheets and goals conceded: real goals weighted 70%, xG 30%, with one home/away factor for all teams.
TEAM_FEATS_DEFAULT = ["cs_def_mix70", "cs_att_mix70", "was_home"]
TEAM_FEATS = TEAM_FEATS_DEFAULT
# Expected BPS and defensive actions per 90 (shown on Chance 90min; they feed bonus and DefCon%).
BPS_FEATS = ["l_bps", "form_bps", "rel_bps", "l_team_att", "gap_team_att", "l_team_def", "gap_team_def", "l_opp_att", "gap_opp_att", "l_opp_def", "gap_opp_def", "was_home"] + PDUM
DC_FEATS = ["l_dc", "l_opp_att", "gap_opp_att", "l_team_att", "gap_team_att", "was_home", "is_MID", "is_FWD"]
DC_MIN_ROWS = 800  # counted matches needed before the DefCon count model is used
SAVE_FEATS = ["l_sv", "l_opp_att", "gap_opp_att", "l_team_def", "gap_team_def", "was_home"]


def _glm():
    return make_pipeline(StandardScaler(), PoissonRegressor(alpha=1e-4, max_iter=2000))


def _fit_rate(train: pd.DataFrame, target: str, feats: list[str]):
    d = train[train["minutes"] > 0]
    e = d["minutes"] / 90
    return _glm().fit(d[feats], (d[target].fillna(0) / e).to_numpy(), poissonregressor__sample_weight=e.to_numpy())


def usual_minutes(df: pd.DataFrame) -> dict[str, np.ndarray]:
    """Minutes and chances of 1+ and 60+ minutes when he is available, before any injury or ban is applied."""
    ret = df["from_return"].fillna(False).astype(bool).to_numpy() if "from_return" in df else np.zeros(len(df), bool)
    out = {}
    for key, w5, r in (("min", "w5_min", "ret_min"), ("p1", "w5_p1", "ret_p1"), ("p60", "w5_p60", "ret_p60"),
                       ("st", "w5_st", "ret_st"), ("ms", "w5_ms", "ret_ms"), ("mb", "w5_mb", "ret_mb"), ("last", "w5_last", "ret_last")):
        if w5 not in df:
            out[key] = np.full(len(df), np.nan)
            continue
        normal = df[w5].fillna(np.nan if key in ("st", "ms", "mb", "last") else 0.0).to_numpy(float)
        back = df[r].to_numpy(float) if r in df else np.full(len(df), np.nan)
        out[key] = np.where(ret & ~np.isnan(back), back, normal)
    return out


BPS_GOAL = {"GK": 12, "DEF": 12, "MID": 18, "FWD": 24}
BPS_ASSIST, BPS_CS, BPS_CONCEDED = 9, 12, -2  # FPL: -4 per 2 goals conceded for GK and DEF, so about -2 a goal
BONUS_SIM_SHARE = 0.5
BONUS_SIM_SD = 6.0
ASSISTED_GOALS = 0.93  # share of goals with an FPL assist (2023-26)


def simulate_bonus(d: pd.DataFrame, sd: float = 6.0, sims: int = 2000, seed: int = 7) -> np.ndarray:
    """Expected bonus for a full 90, from simulating each match: team goals from the other side's expected goals
    conceded, each goal to a scorer by expected goals and an assister by expected assists, clean sheets for GK and
    DEF, the rest of his BPS from expected BPS plus noise; then the top 3 BPS get 3, 2 and 1.

    Needs per row: season, fixture, team, position, g90, a90, p_cs, conc90, bps90, p_60 (chance he plays 60+,
    used as the chance he is on the pitch in a simulation). Returns bonus per row, given he plays."""
    rng = np.random.default_rng(seed)
    out = np.full(len(d), np.nan)
    pos_all = d["position"].to_numpy()
    for _, idx in d.groupby(["season", "fixture"], sort=False).indices.items():
        g = d.iloc[idx]
        teams = g["team"].unique()
        if len(teams) != 2 or len(g) < 4:
            continue
        P = len(g)
        pos = pos_all[idx]
        defn = np.isin(pos, ["GK", "DEF"])
        g90, a90 = g["g90"].to_numpy(float).clip(0), g["a90"].to_numpy(float).clip(0)
        conc = g["conc90"].to_numpy(float)
        team = g["team"].to_numpy()
        on = rng.random((sims, P)) < g["p_60"].fillna(0).to_numpy(float).clip(0.02, 1)
        goal_pts = np.array([BPS_GOAL.get(p, 18) for p in pos], float)
        expected_events = goal_pts * g90 + BPS_ASSIST * a90 + defn * (BPS_CS * g["p_cs"].to_numpy(float) + BPS_CONCEDED * conc)
        bps = (g["bps90"].to_numpy(float) - expected_events)[None, :] + rng.normal(0, sd, (sims, P))
        def credit(weights: np.ndarray, pts: np.ndarray, live: np.ndarray, side: np.ndarray) -> None:
            """Give one event per live simulation to a player of this side on the pitch, picked by weight."""
            w = np.where(on & side[None, :], weights[None, :], 0.0)
            tot = w.sum(1)
            rows = np.where(live & (tot > 0))[0]
            if not len(rows):
                return
            cum = np.cumsum(w[rows] / tot[rows, None], 1)
            pick = (cum < rng.random((len(rows), 1))).sum(1).clip(0, P - 1)
            bps[rows, pick] += pts[pick]

        assist_pts = np.full(P, float(BPS_ASSIST))
        for t in teams:
            mine = team == t
            goals = rng.poisson(float(conc[~mine][0]), sims)  # his team scores what the other side is expected to concede
            for k in range(int(goals.max())):
                live = goals > k
                credit(g90, goal_pts, live, mine)
                credit(a90, assist_pts, live & (rng.random(sims) < ASSISTED_GOALS), mine)
            other_def = ~mine & defn
            bps[:, other_def] += np.where(goals[:, None] == 0, BPS_CS, BPS_CONCEDED * goals[:, None])
        bps = np.where(on, bps, -np.inf)
        top = np.argsort(-bps, axis=1)[:, :3]
        bonus = np.zeros((sims, P))
        for rank, pts in enumerate((3, 2, 1)):
            ok = np.isfinite(np.take_along_axis(bps, top[:, rank:rank + 1], 1))[:, 0]
            bonus[np.where(ok)[0], top[ok, rank]] = pts
        played = on.sum(0)
        out[idx] = np.where(played > 0, (bonus * on).sum(0) / np.maximum(played, 1), np.nan)
    return out


BONUS_CTX_FEATS = ["ctx_rank", "ctx_log_xbps", "ctx_gap_best", "ctx_gap_3rd", "ctx_share_top3", "ctx_n", "l_bon", "is_DEF", "is_MID", "is_FWD"]
BONUS_MODE = "blend"  # "context": learned from each player's BPS place in the match; "blend": model + simulation


def bonus_context(frame: pd.DataFrame, bps90: np.ndarray, mins: np.ndarray) -> pd.DataFrame:
    """Each player's expected BPS place among everyone in the same match, both teams.

    Expected BPS for the match = BPS per 90 x expected minutes / 90. Features: his rank, his BPS (log), the gap to
    the best other player, the gap to the 3rd best, his share of the top-3 total, and how many are expected to play."""
    x = pd.Series(np.clip(bps90 * np.clip(mins, 0, 90) / 90, 0, None), index=frame.index)
    key = [frame["season"], frame["fixture"]]
    g = x.groupby(key)
    rank = g.rank(ascending=False, method="first")
    first = g.transform("max")
    second = g.transform(lambda s: s.nlargest(2).iloc[-1] if len(s) > 1 else s.max())
    third = g.transform(lambda s: s.nlargest(3).iloc[-1] if len(s) > 2 else s.min())
    top3 = g.transform(lambda s: s.nlargest(3).sum())
    own = pd.Series(np.clip(bps90, 0, None), index=frame.index)  # his BPS if he plays the full match
    best_other = np.where(rank == 1, second, first)
    n = (x > 1).groupby(key).transform("sum")
    pos = frame["position"]
    return pd.DataFrame({
        "ctx_rank": rank.to_numpy(float), "ctx_log_xbps": np.log1p(own).to_numpy(float),
        "ctx_gap_best": (own - best_other).to_numpy(float), "ctx_gap_3rd": (own - third).to_numpy(float),
        "ctx_share_top3": (own / top3.replace(0, np.nan)).fillna(0).to_numpy(float), "ctx_n": n.to_numpy(float),
        "l_bon": frame["l_bon"].to_numpy(float) if "l_bon" in frame else np.zeros(len(frame)),
        "is_DEF": (pos == "DEF").to_numpy(float), "is_MID": (pos == "MID").to_numpy(float), "is_FWD": (pos == "FWD").to_numpy(float),
    }, index=frame.index)


def own_bps(df: pd.DataFrame, model_bps: np.ndarray) -> np.ndarray:
    """His own BPS record per 90 (shrunk a little to his role), falling back to the BPS model."""
    return df["r_bps"].fillna(pd.Series(model_bps, index=df.index)).to_numpy(float) if "r_bps" in df else model_bps


class XPointsModel:
    def fit(self, train: pd.DataFrame) -> "XPointsModel":
        train = train[~train["future"] & train["minutes"].notna()]
        # the first GWs of the data have no position priors or player history yet
        train = train[train["t"] >= train["t"].min() + BURN_IN_GWS]
        self.rates = {k: _fit_rate(train, tgt, f) for k, (tgt, f) in GLMS.items()}
        gk = train[train["position"] == "GK"]
        self.saves = _fit_rate(gk, "saves", SAVE_FEATS)
        self.bps = _fit_rate(train.assign(bps_pos=train["bps"].clip(lower=0)), "bps_pos", BPS_FEATS)
        # Bonus in match context: learned from past matches, his expected BPS place among everyone in the match
        # (pre-match figures only) against the bonus he got when he played 60+ minutes.
        self.bonus_ctx = None
        if {"season", "fixture"} <= set(train.columns):
            ctx = bonus_context(train, own_bps(train, self.bps.predict(train[BPS_FEATS])), train["w5_min"].fillna(0).to_numpy(float))
            rows = (train["minutes"] >= 60).to_numpy()
            if rows.sum() > 2000:
                self.bonus_ctx = HistGradientBoostingRegressor(loss="poisson", max_iter=300, learning_rate=0.05, max_leaf_nodes=15,
                                                               min_samples_leaf=80, random_state=0).fit(ctx[rows][BONUS_CTX_FEATS], train.loc[rows, "bonus"].fillna(0))
        # DefCon: count of defensive actions per 90, then the chance of reaching the threshold from that count and
        # his own record of reaching it, fitted on matches where FPL counts them.
        outf = train[(train["position"] != "GK") & train["defensive_contribution"].notna() & (train["minutes"] > 0)]
        self.dc, self.dc_combine = None, None
        if len(outf) >= DC_MIN_ROWS:
            self.dc = _fit_rate(outf, "defensive_contribution", DC_FEATS)
            full = outf[outf["minutes"] >= 60]
            X = self._dc_x(full, self.dc.predict(full[DC_FEATS]))
            hit = (full["defensive_contribution"] >= full["position"].map(DEFCON_THRESHOLD)).astype(int)
            if hit.nunique() == 2:
                self.dc_combine = LogisticRegression(C=1.0, max_iter=1000).fit(X, hit)
        tm = train.dropna(subset=["ga"]).groupby(["season", "fixture", "team"], as_index=False).first()
        self.conceded = _glm().fit(tm[TEAM_FEATS], tm["ga"].to_numpy())
        return self

    @staticmethod
    def _dc_x(df: pd.DataFrame, dc90: np.ndarray) -> np.ndarray:
        rate = df["defcon_rate"].clip(0.01, 0.99).to_numpy(float)
        thr = df["position"].map(DEFCON_THRESHOLD).fillna(12).to_numpy(float)
        return np.column_stack([np.log(rate / (1 - rate)), np.log(np.clip(dc90, 0.1, None) / thr)])

    def predict(self, df: pd.DataFrame, availability: pd.Series | None = None) -> pd.DataFrame:
        # xMin = weighted last-5 minutes, reduced by the FPL availability flag. FPL thresholds apply to that figure.
        # A player back from an injury or ban plays his usual minutes from before the absence (see minute_plan).
        avail = np.ones(len(df)) if availability is None else availability.fillna(1.0).to_numpy()
        base = usual_minutes(df)
        xmin = np.clip(base["min"] * avail, 0, 90)
        p_play = np.clip(base["p1"] * avail, 0, 1)
        p_60 = np.clip(base["p60"] * avail, 0, 1)
        pos = df["position"]
        n90 = xmin / 90
        rate90 = {k: self.rates[k].predict(df[f]) for k, (_, f) in GLMS.items()}
        # Penalties on top of open-play goals: his share of team penalties while on the pitch x team penalties per match.
        pen_cond = df["pen_cond"].to_numpy(float) if "pen_cond" in df else df["pen_share_hist"].fillna(0).to_numpy(float)
        pen_cond = np.nan_to_num(pen_cond)
        team_pens = df["league_pen_rate"].to_numpy(float) * df["team_att"].fillna(1.0).to_numpy(float)
        pen90 = pen_cond * team_pens  # penalties he takes in a full 90
        # His own miss rate over recent seasons, pulled to the league's (a saved penalty counts as a miss).
        miss = df["pen_miss_rate"].fillna(1 - PEN_CONVERSION).to_numpy(float) if "pen_miss_rate" in df else np.full(len(df), 1 - PEN_CONVERSION)
        rate90["goals"] = rate90["goals"] + pen90 * (1 - miss)
        lam = {k: rate90[k] * n90 for k in rate90}
        red90 = df["r_rc"].to_numpy(float)
        conc = self.conceded.predict(df[TEAM_FEATS])
        pcs = np.exp(-conc)
        is_gkdef = pos.isin(["GK", "DEF"]).to_numpy()

        pts_app = p_play + p_60  # FPL: 1 point for 1+ minutes, another for 60+
        pts_goal = lam["goals"] * pos.map(GOAL_PTS).to_numpy()
        pts_ast = lam["assists"] * 3
        # FPL gives clean-sheet points and the goals-conceded deduction only to players with 60+ minutes.
        pts_cs = p_60 * pcs * pos.map(CS_PTS).to_numpy()
        full_conc = -1.0 * is_gkdef * (conc - (1 - np.exp(-2 * conc)) / 2) / 2  # E[floor(G/2)] over 90
        pts_conc = full_conc * p_60
        gk = (pos == "GK").to_numpy()
        full_save = np.zeros(len(df))
        if gk.any():
            mu = self.saves.predict(df.loc[gk, SAVE_FEATS])
            full_save[gk] = sum(poisson.sf(3 * j - 1, mu) for j in range(1, 11))  # E[floor(S/3)] over 90
        pts_save = full_save * n90
        dc90 = self.dc.predict(df[DC_FEATS]) if self.dc is not None else df["r_dc"].to_numpy(float)
        p_def = (self.dc_combine.predict_proba(self._dc_x(df, dc90))[:, 1] if self.dc_combine is not None
                 else df["defcon_rate"].to_numpy(float))
        pts_def = (~gk) * n90 * p_def * DEFCON_PTS
        saves90 = np.zeros(len(df))
        if gk.any():
            saves90[gk] = mu
        # Penalty saves: penalties the opponent is expected to win (league rate x their attack) x share saved.
        opp_pens = df["league_pen_rate"].to_numpy(float) * df["opp_att"].fillna(1.0).to_numpy(float)
        save_share = df["league_pen_save"].to_numpy(float) if "league_pen_save" in df else np.full(len(df), PEN_SAVE_SHARE)
        ps90 = gk * opp_pens * save_share
        full_pensave = ps90 * PEN_SAVE_PTS
        pts_pensave = full_pensave * n90
        pm90, og90 = pen90 * miss, df["r_og"].to_numpy(float)
        full_penmiss, full_own = pm90 * PEN_MISS_PTS, og90 * OWN_GOAL_PTS
        pts_penmiss, pts_own = full_penmiss * n90, full_own * n90
        pts_card = -lam["yellow"] - 3 * red90 * n90
        out = pd.DataFrame({
            "xmin": xmin, "p_play": p_play, "p_60": p_60, "xg": lam["goals"], "xa": lam["assists"],
            "xbonus": lam["bonus"], "p_cs": pcs, "g90": rate90["goals"], "a90": rate90["assists"], "y90": rate90["yellow"], "r90": red90, "bonus90": rate90["bonus"], "pen90": pen90, "pen_cond_used": pen_cond, "team_pens": team_pens, "pts_app": pts_app, "pts_goal": pts_goal, "pts_ast": pts_ast,
            "pts_bonus": lam["bonus"], "pts_cs": pts_cs, "pts_conc": pts_conc, "pts_save": pts_save, "pts_pensave": pts_pensave, "pts_penmiss": pts_penmiss, "pts_own": pts_own, "pm90": pm90, "og90": og90, "saves90": saves90, "conc90": conc, "ps90": ps90,
            "pts_defcon": pts_def, "pts_card": pts_card,
        }, index=df.index)
        goal_pts, cs_pts = pos.map(GOAL_PTS).to_numpy(), pos.map(CS_PTS).to_numpy()
        # Value of each component if he plays a full 90, so the site can rescale when xMin is edited.
        out["full_goal"], out["full_assist"], out["full_bonus"] = rate90["goals"] * goal_pts, rate90["assists"] * 3, rate90["bonus"]
        out["full_cs"], out["full_conceded"], out["full_saves"] = pcs * cs_pts, full_conc, full_save
        out["full_pensave"], out["full_penmiss"], out["full_own"] = full_pensave, full_penmiss, full_own
        out["full_defcon"] = (~gk) * p_def * DEFCON_PTS
        out["full_cards"] = -rate90["yellow"] - 3 * red90
        out["p_defcon"] = (~gk) * p_def
        out["dc90"], out["bps90"] = (~gk) * dc90, self.bps.predict(df[BPS_FEATS])
        # Bonus: half the per-player model, half a simulation of each match, where he competes for the top 3 BPS with
        # everyone on the pitch, both teams (Accuracy page: best correlation of the versions tried).
        if {"season", "fixture", "team"} <= set(df.columns):
            out["bonus90_glm"] = out["bonus90"]
            # His BPS in the simulation is his own BPS record per 90 (r_bps), which keeps players like Bruno or
            # Gabriel, who earn BPS beyond goals, above the average more than the BPS model does.
            frame = pd.concat([df[["season", "fixture", "team", "position"]], out], axis=1)
            if "r_bps" in df:
                frame["bps90"] = df["r_bps"].fillna(out["bps90"]).to_numpy(float)
            sim = simulate_bonus(frame, sd=BONUS_SIM_SD)
            b90 = np.where(np.isnan(sim), out["bonus90"], BONUS_SIM_SHARE * sim + (1 - BONUS_SIM_SHARE) * out["bonus90"])
            out["bonus90_blend"] = b90
            if self.bonus_ctx is not None:
                ctx = bonus_context(df, own_bps(df, out["bps90"].to_numpy(float)), xmin)
                out["bonus90_ctx"] = self.bonus_ctx.predict(ctx[BONUS_CTX_FEATS])
                if BONUS_MODE == "context":
                    b90 = out["bonus90_ctx"].to_numpy(float)
            out["bonus90"], out["full_bonus"], out["xbonus"] = b90, b90, b90 * n90
            out["pts_bonus"] = b90 * n90
        out["xpts"] = out[[c for c in out.columns if c.startswith("pts_")]].sum(axis=1)
        return out

    def explain(self) -> pd.DataFrame:
        rows = []
        models = {k: (self.rates[k], f) for k, (_, f) in GLMS.items()} | {"saves": (self.saves, SAVE_FEATS), "conceded": (self.conceded, TEAM_FEATS)}
        for name, (m, feats) in models.items():
            coef = m[-1].coef_ / m[0].scale_
            rows += [{"target": name, "feature": f, "coef": round(float(c), 3)} for f, c in zip(feats, coef)]
        return pd.DataFrame(rows)


# ---------------------------------------------------------------- backtest
def load_history(data_dir: Path, seasons: list[str]) -> pd.DataFrame:
    raw = pd.concat([load_season(data_dir, s) for s in seasons], ignore_index=True)
    return historic_absences(yellow_bans(clean(add_core(raw, data_dir, seasons), seasons)))


INJURY_ARCHIVE = Path(__file__).resolve().parent / "archive" / "injuries"


def _plain(s) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z ]", "", re.sub(r"[-.']", " ", s)).split())


def _club(s) -> str:
    s = _plain(s).replace("afc ", "").replace(" fc", "")
    alias = {"manchester city": "man city", "manchester united": "man utd", "tottenham hotspur": "spurs", "nottingham forest": "nottm forest",
             "brighton hove albion": "brighton", "wolverhampton wanderers": "wolves"}
    return alias.get(s, s).split()[0]


def _one(name: str, pool: list) -> int | None:
    """The row in pool [(index, full name)] that a FotMob name means, or None when unsure."""
    n = _plain(name)
    tests = (lambda r: _plain(r) == n,
             lambda r: _plain(r).split()[-1:] == n.split()[-1:] and _plain(r).split()[:1] == n.split()[:1],
             lambda r: set(n.split()) <= set(_plain(r).split()),
             lambda r: n.split()[-1:] == _plain(r).split()[-1:])
    for t in tests:
        hit = [i for i, r in pool if t(r)]
        if len(hit) == 1:
            return hit[0]
        if len(hit) > 1:
            return None
    return None


def historic_absences(df: pd.DataFrame, folder: Path = INJURY_ARCHIVE) -> pd.DataFrame:
    """Injuries and absences of past seasons, from archive/injuries (tools/history_injuries.py for FotMob's lists of
    unavailable players per league match, tools/history_soccerway.py for Soccerway's injury spells), so past
    seasons are read the way the site reads the current one:
      hist_out   listed unavailable for the match (FotMob), or inside a Soccerway injury spell
      hist_skip  matches the minutes formula leaves out: the zero-minute ones he was out for, and the match he got
                 hurt in (a Soccerway spell starting that day or within 2 days, or the match before a FotMob injury
                 listing, when he did not play all of it)
      hist_back  his first match after an injury absence
      hist_ret   his share of usual minutes back from injury (the site's return rule, RETURN_RULES)
    Seasons with no archive are left as they are."""
    df["hist_out"] = False
    df["hist_skip"] = False
    df["hist_back"] = False
    if not folder.exists() or "kickoff_time" not in df:
        return df
    inj = pd.Series(False, index=df.index)
    for path in sorted(folder.glob("fotmob_*.json.gz")):
        season = path.name[len("fotmob_"):-len(".json.gz")]
        s = df[df["season"] == season]
        if s.empty:
            continue
        sides = s.groupby(["fixture", "was_home"])["team"].first().unstack()
        if 0 not in sides or 1 not in sides:
            continue
        fx = {(_club(h), _club(a)): f for f, h, a in zip(sides.index, sides[1], sides[0])}
        for m in json.loads(gzip.decompress(path.read_bytes()))["matches"]:
            f = fx.get((_club(m["home"]), _club(m["away"])))
            if f is None:
                continue
            for side, home in (("homeUnavailable", 1), ("awayUnavailable", 0)):
                rows = s[(s["fixture"] == f) & (s["was_home"] == home)]
                pool = list(zip(rows.index, rows["name"]))
                for u in m.get(side) or []:
                    i = _one(u.get("name"), pool)
                    if i is not None:
                        df.at[i, "hist_out"] = True
                        inj.at[i] = inj.at[i] or ((u.get("unavailability") or {}).get("type") == "injury")
    sw_path = folder / "soccerway_players.json.gz"
    hurt = pd.Series(False, index=df.index)
    if sw_path.exists():
        names = df.drop_duplicates("pid")[["pid", "name"]]
        tok = {pid: frozenset(_plain(n).split()) for pid, n in zip(names["pid"], names["name"])}
        spells = {}
        for p in json.loads(gzip.decompress(sw_path.read_bytes()))["players"]:
            t = frozenset(_plain(p["slug"].replace("-", " ")).split())
            hit = [pid for pid, tk in tok.items() if tk == t] or [pid for pid, tk in tok.items() if t <= tk or tk <= t]
            if len(hit) == 1 and p.get("injuries"):
                spells.setdefault(hit[0], []).extend(
                    (pd.Timestamp(pd.to_datetime(r["from"], format="%d.%m.%Y")),
                     pd.Timestamp(pd.to_datetime(r["until"], format="%d.%m.%Y")) if r.get("until") else pd.Timestamp.max)
                    for r in p["injuries"])
        day = pd.to_datetime(df["kickoff_time"], utc=True).dt.tz_localize(None).dt.normalize()
        lo, hi = (pd.Timestamp("2024-07-01"), pd.Timestamp("2026-07-01"))
        for i, pid, k, m in zip(df.index, df["pid"], day, df["minutes"].fillna(0)):
            if not (lo <= k < hi):
                continue
            for a, b in spells.get(pid, ()):
                if a < k < b or (a == k and m == 0):
                    df.at[i, "hist_out"] = True
                    inj.at[i] = True
                elif m > 0 and k <= a <= k + pd.Timedelta(days=2):
                    hurt.at[i] = True
    order = df.sort_values(["pid", "kickoff_time"]).index
    mins = df.loc[order, "minutes"].fillna(0)
    pid = df.loc[order, "pid"]
    nxt_inj = inj.loc[order].groupby(pid.to_numpy()).shift(-1).fillna(False).astype(bool)
    hurt.loc[order] |= (nxt_inj & (mins < 90) & (mins > 0) & ~df.loc[order, "hist_out"]).to_numpy()
    out = df.loc[order, "hist_out"].astype(bool)
    prev_inj = (out & inj.loc[order]).groupby(pid.to_numpy()).shift(1).fillna(False).astype(bool)
    df.loc[order, "hist_back"] = (prev_inj & ~out).to_numpy()
    df["hist_skip"] = (df["hist_out"] & (df["minutes"].fillna(0) == 0)) | (hurt & ~df["hist_out"])
    # Back from an injury absence, the site's return rule: his share of usual minutes by days out and days since his
    # first match back (hist_ret, what was known before each match), and his recovery matches under his usual minutes
    # from before the injury left out of the formula, until he plays his usual minutes again (as the site does).
    df["hist_ret"] = 1.0
    o = df.loc[order]
    kick = pd.to_datetime(o["kickoff_time"], utc=True).to_numpy()
    outv, injv, backv = o["hist_out"].astype(bool).to_numpy(), inj.loc[order].to_numpy(), o["hist_back"].to_numpy()
    mv, pv, skipv = o["minutes"].fillna(0).to_numpy(float), o["pid"].to_numpy(), o["hist_skip"].to_numpy().copy()
    ret = np.ones(len(o))
    recovered = 0
    for i in np.where(backv)[0]:
        f = i - 1
        while f >= 0 and pv[f] == pv[i] and outv[f]:
            f -= 1
        first_out = f + 1
        days_out = (kick[i] - kick[first_out]) / np.timedelta64(1, "D")
        prev = [mv[k] for k in range(first_out - 1, -1, -1) if pv[k] == pv[i] and not outv[k] and not skipv[k]][:5]
        w = MINUTE_WEIGHTS[:len(prev)]
        usual = float(np.dot(prev, w) / w.sum()) if prev else 0.0
        window = return_window(days_out)
        k = i
        while k < len(o) and pv[k] == pv[i] and not outv[k]:
            since = (kick[k] - kick[i]) / np.timedelta64(1, "D")
            if k > i and since > window:
                break
            ret[k] = return_share(days_out, since, k == i)
            if mv[k] >= usual:
                break  # back to his usual minutes: the recovery is over
            skipv[k] = True
            recovered += 1
            k += 1
    df.loc[order, "hist_ret"] = ret
    df.loc[order, "hist_skip"] = skipv
    print(f"Past-season absences from archive/injuries: {int(df['hist_out'].sum())} matches out, {int(hurt.sum())} matches he got hurt in, "
          f"{int(df['hist_back'].sum())} first matches back, {recovered} recovery matches under his usual left out")
    return df


PEN_ORDER_WINDOW = 38  # team matches looked back over for who has been taking the penalties


def pen_order_from_history(df: pd.DataFrame) -> pd.Series:
    """For past matches (the backtest): each team's penalty order before the match from who actually took its
    penalties in its previous PEN_ORDER_WINDOW matches (most taken first), where penalties are counted; FPL's order
    stored for old seasons is often wrong or out of date. Falls back to that stored order where nobody took one."""
    taken = (df["core_pen_scored"].fillna(0) + df["core_pen_missed"].fillna(0)).astype(float)
    known = df["core_pen_scored"].notna() | df["core_pen_missed"].notna()
    tm = df[["season", "fixture", "team", "kickoff_time"]].drop_duplicates(["season", "fixture", "team"]).sort_values("kickoff_time")
    tm["i"] = tm.groupby("team").cumcount()
    idx = df[["season", "fixture", "team"]].merge(tm[["season", "fixture", "team", "i"]], on=["season", "fixture", "team"], how="left")["i"].to_numpy()
    d = pd.DataFrame({"team": df["team"].to_numpy(), "pid": df["pid"].to_numpy(), "i": idx, "taken": taken.to_numpy(), "known": known.to_numpy()})
    count = np.zeros(len(d))
    have = np.zeros(len(d), bool)  # any counted match for the team in the window
    for team, g in d.groupby("team"):
        wide = g.pivot_table(index="i", columns="pid", values="taken", aggfunc="sum", fill_value=0.0)
        full = pd.RangeIndex(int(g["i"].min()), int(g["i"].max()) + 1)
        wide = wide.reindex(full, fill_value=0.0)
        before = wide.rolling(PEN_ORDER_WINDOW, min_periods=1).sum().shift(1).fillna(0.0)
        k = g.groupby("i")["known"].any().reindex(full, fill_value=False).astype(float)
        kb = k.rolling(PEN_ORDER_WINDOW, min_periods=1).sum().shift(1).fillna(0.0)
        st = before.stack()
        vals = st.reindex(pd.MultiIndex.from_arrays([g["i"].to_numpy(), g["pid"].to_numpy()])).fillna(0.0).to_numpy()
        pos = g.index.to_numpy()  # positions in d (a plain 0..n-1 index)
        count[pos] = vals
        have[pos] = kb.reindex(g["i"].to_numpy()).to_numpy() > 0
    d["count"] = count
    rank = d[d["count"] > 0].groupby(["team", "i"])["count"].rank(method="first", ascending=False)
    order = pd.Series(np.nan, index=df.index)
    order.loc[df.index[rank.index]] = rank.to_numpy()
    team_has = pd.Series(d["count"] > 0).groupby([d["team"], d["i"]]).transform("any").to_numpy()
    old = pd.to_numeric(df["pen_order"], errors="coerce")
    return order.where(team_has | have, old)


def walk_forward(feat: pd.DataFrame, season: str, step: int, min_train_seasons: int = 1) -> pd.DataFrame:
    test = feat[feat["season"] == season]
    # who takes the penalties, the way the site does it, with the order taken from who has been taking them
    test = test.assign(pen_order=pen_order_from_history(feat).loc[test.index].to_numpy())
    if "avail" not in test:
        test = test.assign(avail=1.0)
    test = test.assign(pen_cond=penalty_shares(test))
    if feat.loc[feat["season"] != season, "season"].nunique() < min_train_seasons:
        raise ValueError("Need at least one earlier season to backtest.")
    gws = sorted(test["GW"].unique())
    parts = []
    for i in range(0, len(gws), step):
        block = gws[i:i + step]
        cut = test.loc[test["GW"] == block[0], "t"].iloc[0]
        print(f"  training before {season} GW{block[0]}, predicting GW{block[0]}-{block[-1]}")
        model = XPointsModel().fit(feat[feat["t"] < cut])
        rows = test[test["GW"].isin(block)]
        # What was known before each match, as the site knows it now: out (0), back from injury (the return rule).
        avail = None
        if "hist_out" in rows:
            ret = rows["hist_ret"] if "hist_ret" in rows else pd.Series(1.0, index=rows.index)
            avail = pd.Series(np.where(rows["hist_out"].astype(bool), 0.0, ret.fillna(1.0)), index=rows.index)
        parts.append(pd.concat([rows, model.predict(rows, avail)], axis=1))
    return pd.concat(parts)


def _score(y: pd.Series, p: pd.Series) -> dict:
    ok = y.notna() & p.notna()
    y, p = y[ok], p[ok]
    return {"n": len(y), "RMSE": float(np.sqrt(((y - p) ** 2).mean())), "MAE": float((y - p).abs().mean()),
            "Pearson": float(y.corr(p)), "Spearman": float(y.corr(p, method="spearman"))}


def _auc(score: np.ndarray, hit: np.ndarray) -> float:
    """Chance a random match where it happened was rated above a random one where it did not (0.5 = no better than chance)."""
    pos, n = hit.sum(), len(hit)
    if pos == 0 or pos == n:
        return float("nan")
    ranks = pd.Series(score).rank().to_numpy()
    return float((ranks[hit == 1].sum() - pos * (pos + 1) / 2) / (pos * (n - pos)))


def _auc_ceiling(prob: np.ndarray) -> float:
    """The AUC the chances would get on average if each were exactly right: every match then happens with its own
    chance, and the score is how often one where it happened is rated above one where it did not. A rare or near
    coin-flip event cannot be sorted well even by perfect chances, so this is the most to expect from each row."""
    p = np.sort(np.asarray(prob, float))
    q = 1 - p
    # weight of "it happened" pairs above "it did not": for each match, its p times the (1 - p) of every match below
    # it, ties counting half, leaving out the match paired with itself
    s = pd.Series(q).groupby(p).sum()
    below = s.cumsum() - s
    tie = pd.Series(p).groupby(p).sum() * s - pd.Series(p * q).groupby(p).sum()
    num = float((pd.Series(p).groupby(p).sum() * below).sum() + 0.5 * tie.sum())
    den = float(p.sum() * q.sum() - (p * q).sum())
    return num / den if den > 0 else float("nan")


def chance_report(pred: pd.DataFrame) -> None:
    """How good each Chance 90min figure was on the test season, against what happened.

    The page shows chances for a full 90, so each is scaled to the minutes he really played. Baseline = the test
    season's own average for his position, the best you could do knowing only position (it even peeks at the
    season), so skill above 0 means the player-level figure adds something."""
    d = pred[pred["minutes"].notna()].copy()
    d["n90"] = d["minutes"] / 90
    # Goals are judged without penalties: past seasons have no penalty order, so penalty shares there are rough.
    d["np_g90"] = (d["g90"] - (d["pen90"].fillna(0) - d["pm90"].fillna(0))).clip(lower=0)
    played = d[d["minutes"] > 0]
    rows = []

    def binary(title, prob, hit, group):
        prob, hit = np.clip(np.asarray(prob, float), 1e-6, 1 - 1e-6), np.asarray(hit, float)
        base = pd.Series(hit).groupby(np.asarray(group)).transform("mean").clip(1e-6, 1 - 1e-6).to_numpy()
        brier, brier0 = np.mean((prob - hit) ** 2), np.mean((base - hit) ** 2)
        ll = -np.mean(hit * np.log(prob) + (1 - hit) * np.log(1 - prob))
        ll0 = -np.mean(hit * np.log(base) + (1 - hit) * np.log(1 - base))
        none = hit.sum() == 0 or hit.sum() == len(hit)
        rows.append({"figure": title, "n": len(hit), "predicted": prob.mean(), "actual": hit.mean(),
                     "Brier skill": np.nan if none else 1 - brier / brier0, "log-loss skill": np.nan if none else 1 - ll / ll0, "AUC": _auc(prob, hit),
                     "AUC ceiling": _auc_ceiling(prob)})
        return prob, hit

    def per90(title, rate, actual, frame, cap_one=True):
        prob = 1 - np.exp(-frame[rate].to_numpy(float) * frame["n90"].to_numpy(float))
        hit = (frame[actual].fillna(0).to_numpy(float) >= 1).astype(float)
        return binary(title, prob, hit, frame["position"])

    calib = {}
    p, h = binary("Appearance 1+", d["p_play"], d["minutes"] > 0, d["position"]); calib["Appearance 1+"] = (p, h)
    p, h = binary("Appearance 60+", d["p_60"], d["minutes"] >= 60, d["position"]); calib["Appearance 60+"] = (p, h)
    p, h = per90("Score 1+ (no pens)", "np_g90", "np_goals", played); calib["Score 1+ (no pens)"] = (p, h)
    p, h = per90("Assist 1+", "a90", "assists", played); calib["Assist 1+"] = (p, h)
    teams = d.dropna(subset=["ga"]).groupby(["season", "fixture", "team"], as_index=False).first()
    p, h = binary("Clean sheet (team)", teams["p_cs"], teams["ga"] == 0, np.zeros(len(teams))); calib["Clean sheet (team)"] = (p, h)
    dc = played[(played["minutes"] >= 60) & played["defensive_contribution"].notna() & (played["position"] != "GK")]
    if len(dc):
        p, h = binary("DefCon (60+ min)", dc["p_defcon"], dc["defensive_contribution"] >= dc["position"].map(DEFCON_THRESHOLD), dc["position"]); calib["DefCon (60+ min)"] = (p, h)
        binary("DefCon, own record only", dc["defcon_rate"], dc["defensive_contribution"] >= dc["position"].map(DEFCON_THRESHOLD), dc["position"])
    gks = played[played["position"] == "GK"]
    per90("Pen save (GK)", "ps90", "penalties_saved", gks)
    per90("Pen miss", "pm90", "penalties_missed", played)
    per90("Own goal", "og90", "own_goals", played)
    per90("Red card", "r90", "red_cards", played)
    p, h = per90("Yellow card", "y90", "yellow_cards", played); calib["Yellow card"] = (p, h)
    t = pd.DataFrame(rows)
    print("\n=== Chance 90min: each chance against what happened (test season) ===")
    print("Skill: 1 - error / error of the position average (0 = no better, 1 = perfect). AUC: 0.5 = coin flip, 1 = perfect order; ceiling: the AUC if every chance were exactly right.")
    print(t.to_string(index=False, formatters={"predicted": "{:.2%}".format, "actual": "{:.2%}".format, "Brier skill": "{:+.3f}".format,
                                                 "log-loss skill": "{:+.3f}".format, "AUC": "{:.3f}".format, "AUC ceiling": "{:.3f}".format}))

    counts = []
    def count(title, rate, actual, frame, scale=True):
        pr = frame[rate].to_numpy(float) * (frame["n90"].to_numpy(float) if scale else 1.0)
        ac = frame[actual].fillna(0).to_numpy(float)
        base = pd.Series(ac / np.maximum(frame["n90"].to_numpy(float), 1e-9) if scale else ac).groupby(frame["position"].to_numpy()).transform("mean").to_numpy() * (frame["n90"].to_numpy(float) if scale else 1.0)
        mae, mae0 = np.mean(np.abs(pr - ac)), np.mean(np.abs(base - ac))
        corr = float(np.corrcoef(pr, ac)[0, 1]) if np.std(pr) > 0 and np.std(ac) > 0 else float("nan")
        counts.append({"figure": title, "n": len(ac), "predicted": pr.mean(), "actual": ac.mean(), "MAE": mae, "MAE skill": 1 - mae / mae0, "correlation": corr})
    count("xGoals (no pens)", "np_g90", "np_goals", played)
    count("xAssists", "a90", "assists", played)
    count("Saves (GK)", "saves90", "saves", gks)
    count("Bonus", "bonus90", "bonus", played)
    # Bonus: the per-player model, simulations of each match at several noise levels, and blends; scored per match
    # and per player over the season (slope above 1 = the best bonus takers are predicted too low).
    glm = "bonus90_glm" if "bonus90_glm" in d else "bonus90"
    variants = {"Per-player model": d[glm]}
    if "bonus90_blend" in d:
        variants["Model + simulation (previous)"] = d["bonus90_blend"]
    if "bonus90_ctx" in d:
        variants["Match context model (new)"] = d["bonus90_ctx"].fillna(d[glm])
        variants["50/50 context + previous"] = 0.5 * variants["Match context model (new)"] + 0.5 * d.get("bonus90_blend", d[glm])
    full = d[d["minutes"] >= 60]
    rows_b, star = [], None
    for name, v in variants.items():
        pr, ac = v.loc[full.index].to_numpy(float), full["bonus"].fillna(0).to_numpy(float)
        per = pd.DataFrame({"pid": full["pid"], "name": full["web_name"] if "web_name" in full else full["name"], "p": pr, "a": ac}).groupby(["pid", "name"]).agg(p=("p", "mean"), a=("a", "mean"), n=("a", "size"))
        per = per[per["n"] >= 15]
        slope = float(np.polyfit(per["p"], per["a"], 1)[0])
        top = per.sort_values("a", ascending=False).head(20)
        picked = per.sort_values("p", ascending=False).head(20)
        rows_b.append({"bonus version": name, "match corr": float(np.corrcoef(pr, ac)[0, 1]), "match MAE": float(np.mean(np.abs(pr - ac))),
                       "player corr": float(per["p"].corr(per["a"])), "slope": slope,
                       "top-20 predicted: pred": picked["p"].mean(), "top-20 predicted: actual": picked["a"].mean(),
                       "top-20 actual: pred": top["p"].mean(), "top-20 actual: actual": top["a"].mean()})
        if star is None:
            star = top.head(10).rename(columns={"p": name})
        else:
            star[name] = per.loc[star.index, "p"]
    print("\n=== Bonus versions, matches with 60+ minutes; players with 15+ such matches ===")
    print(pd.DataFrame(rows_b).round(3).to_string(index=False))
    print("\nTop 10 bonus takers per 60+ minute match (actual a) and each version's prediction:")
    print(star.round(2).to_string())
    count("BPS", "bps90", "bps", played)
    dca = played[(played["position"] != "GK") & played["defensive_contribution"].notna()]
    if len(dca):
        count("DefCon actions", "dc90", "defensive_contribution", dca)
    count("Conceded (team)", "conc90", "ga", teams.assign(position="team", n90=1.0), scale=False)
    print("\n=== Chance 90min: expected counts against what happened (test season) ===")
    print(pd.DataFrame(counts).to_string(index=False, formatters={"predicted": "{:.3f}".format, "actual": "{:.3f}".format, "MAE": "{:.3f}".format,
                                                                   "MAE skill": "{:+.3f}".format, "correlation": "{:.3f}".format}))

    # Same test as FPL Review's "Massive Data" article (2019/20 GW9-26, 2,021 samples): outfield players who played
    # 90 minutes with 450+ minutes of earlier data; expected goals against goals and against xG, R2 and RMSE.
    # Their simple baseline on the same season: xG per 90 over his last 5 matches with minutes (xG5).
    hist = played.sort_values(["pid", "kickoff_time", "fixture"])
    gx = hist.groupby("pid")
    xg5 = (gx["expected_goals"].transform(lambda s: s.fillna(0).shift(1).rolling(5, min_periods=5).sum())
           / gx["minutes"].transform(lambda s: s.shift(1).rolling(5, min_periods=5).sum()) * 90)
    # and the position average for the season (a stand-in for their "basic" position-and-fixture model)
    played = played.assign(xg5=xg5.reindex(played.index))
    fr = played[(played["position"] != "GK") & (played["minutes"] >= 90) & (played["L_n90"] >= 5) & played["GW"].between(9, 26)]
    fr = fr[fr["xg5"].notna()]
    if len(fr) > 50:
        def scores(pr):
            out = {}
            for target, label in (("expected_goals", "xG"), ("goals_scored", "Goals")):
                ac = fr[target].fillna(0).to_numpy(float)
                out[label] = (1 - np.sum((pr - ac) ** 2) / np.sum((ac - ac.mean()) ** 2), np.sqrt(np.mean((pr - ac) ** 2)))
            hit = (fr["goals_scored"].fillna(0) >= 1).to_numpy(float)
            return out, _auc(1 - np.exp(-pr), hit)
        print(f"\n=== FPL Review comparison (outfield, 90 min, 450+ min before, GW9-26, 5 earlier matches), n={len(fr)} ===")
        pos_avg = fr.groupby("position")["goals_scored"].transform("mean").to_numpy(float)
        for label, pr in (("Model", fr["g90"].to_numpy(float)), ("xG5", fr["xg5"].to_numpy(float)), ("Position average", pos_avg)):
            out, auc = scores(pr)
            print(f"{label:17s} xG R2 {out['xG'][0]:.3f} RMSE {out['xG'][1]:.3f}; Goals R2 {out['Goals'][0]:.3f} RMSE {out['Goals'][1]:.3f}; anytime AUC {auc:.3f}")
        print("FPL Review 2019/20 (n=2021): Massive Data xG R2 0.353 RMSE 0.213, Goals R2 0.129 RMSE 0.345; "
              "bookmakers xG R2 0.321, Goals R2 0.112 RMSE 0.348; xG over last 5 xG R2 0.288, Goals R2 0.098")

    # Where goals and assists are missed: penalties vs open play, and by minutes played.
    pg = played.assign(pen_pred=played["pen90"] * (1 - played["pen_miss_rate"].fillna(1 - PEN_CONVERSION)) * played["n90"],
                       g_pred=played["g90"] * played["n90"], a_pred=played["a90"] * played["n90"])
    kn = pg[pg["has_core"].fillna(False).astype(bool)] if "has_core" in pg else pg.iloc[0:0]
    if len(kn):
        print("\n=== Goals split, matches with counted penalties ===")
        print(f"Penalty goals: predicted {kn['pen_pred'].sum():.0f}, actual {kn['core_pen_scored'].fillna(0).sum():.0f}; "
              f"open-play goals: predicted {(kn['g_pred'] - kn['pen_pred']).sum():.0f}, actual {(kn['goals_scored'].fillna(0) - kn['core_pen_scored'].fillna(0)).sum():.0f}; "
              f"all goals: predicted {kn['g_pred'].sum():.0f}, actual {kn['goals_scored'].fillna(0).sum():.0f}; assists: predicted {kn['a_pred'].sum():.0f}, actual {kn['assists'].fillna(0).sum():.0f}")
    band = pd.cut(pg["minutes"], [0, 30, 60, 89, 90], labels=["1-30", "31-60", "61-89", "90"])
    pg = pg.assign(g_np=(pg["np_g90"] * pg["n90"]) if "np_g90" in pg else pg["g_pred"])
    tab = pg.groupby(band, observed=True).agg(n=("minutes", "size"), g_pred=("g_np", "sum"), g_act=("np_goals", "sum"), a_pred=("a_pred", "sum"), a_act=("assists", "sum"))
    tab["goals actual/pred"], tab["assists actual/pred"] = tab["g_act"] / tab["g_pred"], tab["a_act"] / tab["a_pred"]
    print("\n=== Goals (no pens) and assists by minutes played (actual / predicted, 1.00 = right) ===")
    print(tab.round(2).to_string())

    print("\n=== Chance 90min: calibration, predicted vs actual by predicted band ===")
    for title, (p, h) in calib.items():
        bands = pd.qcut(pd.Series(p), 5, duplicates="drop")
        tab = pd.DataFrame({"p": p, "h": h}).groupby(bands, observed=True).agg(predicted=("p", "mean"), actual=("h", "mean"), n=("h", "size"))
        print(f"{title}: " + "; ".join(f"{r.predicted:.1%}->{r.actual:.1%}" for r in tab.itertuples()))


TOP_SCORERS = {"GK": 10, "DEF": 20, "MID": 20, "FWD": 10}
POINT_PARTS = ["Appearance", "Goals", "Assists", "Bonus", "Clean sheet", "Goals conceded", "Saves", "Penalty saves", "Own goals", "Cards", "DefCon and other"]


def parts_at_real_minutes(pred: pd.DataFrame) -> pd.DataFrame:
    """The model's points per part with the minutes he really played instead of xMin: the Chance 90min figures
    (full-90 values) times real minutes / 90, clean sheet and goals conceded only with 60+, appearance points as
    earned. This takes the minutes guess out, to judge the per-90 figures alone. Penalty goals and misses are left
    out: past seasons have no penalty order to share them by."""
    m = pred["minutes"].fillna(0).to_numpy(float)
    n90, on60 = m / 90, (m >= 60).astype(float)
    g = lambda c: pred[c].fillna(0).to_numpy(float) if c in pred else np.zeros(len(pred))
    pen_goal90 = (g("pen90") - g("pm90")) * pred["position"].map(GOAL_PTS).to_numpy(float)  # penalty goals, left out
    return pd.DataFrame({
        "Appearance": (m > 0).astype(float) + on60, "Goals": (g("full_goal") - pen_goal90) * n90, "Assists": g("full_assist") * n90, "Bonus": g("full_bonus") * n90,
        "Clean sheet": g("full_cs") * on60, "Goals conceded": g("full_conceded") * on60, "Saves": g("full_saves") * n90,
        "Penalty saves": g("full_pensave") * n90, "Own goals": g("full_own") * n90, "Cards": g("full_cards") * n90,
        "DefCon and other": g("full_defcon") * n90}, index=pred.index)


def real_no_pens(pred: pd.DataFrame) -> np.ndarray:
    """His real points without penalty goals and penalty misses."""
    g = lambda c: pred[c].fillna(0).to_numpy(float) if c in pred else np.zeros(len(pred))
    pen_goals = np.clip(g("goals_scored") - g("np_goals"), 0, None)
    return g("total_points") - pen_goals * pred["position"].map(GOAL_PTS).to_numpy(float) - g("penalties_missed") * PEN_MISS_PTS


def real_parts(pred: pd.DataFrame) -> pd.DataFrame:
    """His real points per part (clean sheet and goals conceded from his team's goals against when he played 60+;
    whatever is left of his total, mostly DefCon, under DefCon and other), without penalty goals and misses."""
    m = pred["minutes"].fillna(0).to_numpy(float)
    on60 = m >= 60
    pos = pred["position"]
    g = lambda c: pred[c].fillna(0).to_numpy(float) if c in pred else np.zeros(len(pred))
    ga = g("ga")
    gkdef = pos.isin(["GK", "DEF"]).to_numpy()
    out = pd.DataFrame({
        "Appearance": (m > 0).astype(float) + on60, "Goals": g("np_goals") * pos.map(GOAL_PTS).to_numpy(float), "Assists": g("assists") * 3,
        "Bonus": g("bonus"), "Clean sheet": (on60 & (ga == 0)) * pos.map(CS_PTS).to_numpy(float), "Goals conceded": -(on60 & gkdef).astype(float) * np.floor(ga / 2),
        "Saves": np.floor(g("saves") / 3), "Penalty saves": g("penalties_saved") * PEN_SAVE_PTS,
        "Own goals": g("own_goals") * OWN_GOAL_PTS, "Cards": -g("yellow_cards") - 3 * g("red_cards")}, index=pred.index)
    out["DefCon and other"] = real_no_pens(pred) - out.sum(axis=1)
    return out


CORE_GROUP = {"GK": 15, "DEF": 35, "MID": 35, "FWD": 15}  # the "core": the top scorers of the test season by position


def team_report(pred: pd.DataFrame) -> None:
    """Team odds tested: each club's expected goals (the other side's expected goals conceded) and clean sheet chance
    in every match of the test season, against what happened."""
    t = pred.dropna(subset=["ga", "gf"]).groupby(["season", "fixture", "team"], as_index=False).agg(
        conc=("conc90", "first"), cs=("p_cs", "first"), gf=("gf", "first"), ga=("ga", "first"), home=("was_home", "first"))
    t["opp_team"] = t.groupby(["season", "fixture"])["team"].transform(lambda x: x.iloc[::-1].to_numpy() if len(x) == 2 else x.to_numpy())
    t = t.merge(t[["season", "fixture", "team", "conc"]].rename(columns={"team": "opp_team", "conc": "xg"}), on=["season", "fixture", "opp_team"], how="left").dropna(subset=["xg"])
    if t.empty:
        return
    t["clean"] = (t["ga"] == 0).astype(float)
    print("\n=== Team goals and clean sheets: each club's expected goals and clean sheet chance per match against what happened ===")
    base_g = t.groupby("home")["gf"].transform("mean")  # the league's home / away average
    print("\nGoals per match")
    print("figure | value")
    print(f"matches | {len(t)}")
    print(f"expected goals, average | {t['xg'].mean():.2f}")
    print(f"real goals, average | {t['gf'].mean():.2f}")
    print(f"average miss | {(t['xg'] - t['gf']).abs().mean():.2f}")
    print(f"average miss, everyone at the league home/away average | {(base_g - t['gf']).abs().mean():.2f}")
    print(f"correlation with real goals | {np.corrcoef(t['xg'], t['gf'])[0, 1]:.2f}")
    print("\nGoals by expected band")
    print("expected | matches | expected average | real average")
    for lo, hi in ((0, 0.8), (0.8, 1.1), (1.1, 1.4), (1.4, 1.7), (1.7, 2.1), (2.1, 9)):
        x = t[(t["xg"] >= lo) & (t["xg"] < hi)]
        if len(x):
            print(f"{lo:.1f}-{hi:.1f} | {len(x)} | {x['xg'].mean():.2f} | {x['gf'].mean():.2f}".replace("-9.0", "+"))
    brier = ((t["cs"] - t["clean"]) ** 2).mean()
    base_cs = t.groupby("home")["clean"].transform("mean")
    brier0 = ((base_cs - t["clean"]) ** 2).mean()
    print("\nClean sheets")
    print("figure | value")
    print(f"predicted share | {t['cs'].mean():.1%}")
    print(f"real share | {t['clean'].mean():.1%}")
    print(f"Brier skill against the league home/away average | {1 - brier / brier0:.3f}")
    print(f"AUC | {_auc(t['cs'].to_numpy(float), t['clean'].to_numpy(float)):.3f}")
    print("\nClean sheets by predicted band")
    print("predicted | matches | predicted average | real share")
    for lo, hi in ((0, 0.15), (0.15, 0.25), (0.25, 0.35), (0.35, 0.45), (0.45, 1.01)):
        x = t[(t["cs"] >= lo) & (t["cs"] < hi)]
        if len(x):
            print(f"{lo:.0%}-{min(hi, 1):.0%} | {len(x)} | {x['cs'].mean():.1%} | {x['clean'].mean():.1%}")
    print("\nSeason totals by club")
    print("club | matches | expected goals | real goals | expected clean sheets | real clean sheets")
    s = t.groupby("team").agg(n=("xg", "size"), xg=("xg", "sum"), gf=("gf", "sum"), cs=("cs", "sum"), clean=("clean", "sum")).sort_values("gf", ascending=False)
    for team, r in s.iterrows():
        print(f"{team} | {int(r['n'])} | {r['xg']:.1f} | {int(r['gf'])} | {r['cs']:.1f} | {int(r['clean'])}")
    print(f"correlation of season totals | goals {np.corrcoef(s['xg'], s['gf'])[0, 1]:.2f}, clean sheets {np.corrcoef(s['cs'], s['clean'])[0, 1]:.2f}")


def core_report(pred: pd.DataFrame, gw: pd.DataFrame) -> None:
    """The core group (CORE_GROUP by real season points): how right xMin is for them, how right the Chance 90min figures
    are once their real minutes are put in, and whether the season ranking is right."""
    tot = gw.groupby(["pid", "position"], as_index=False).agg(real=("total_points", "sum"), pred=("xpts", "sum"), name=("name", "last"), team=("team", "last"),
                                                             mins=("minutes", "sum"), xmin=("xmin", "sum"), am=("xpts_real_min", "sum"), real_np=("real_no_pens", "sum"))
    core = pd.concat([tot[tot["position"] == p].nlargest(n, "real") for p, n in CORE_GROUP.items()])
    d = pred[pred["pid"].isin(core["pid"]) & pred["minutes"].notna()].copy()
    print(f"\n=== Core group: the top {sum(CORE_GROUP.values())} by real points ({', '.join(f'{n} {p}' for p, n in CORE_GROUP.items())}) ===")
    # 1. xMin, per match
    print("\nxMin, per match (all their league matches; 'known out' = listed injured or banned before the match)")
    print("group | matches | xMin | real | bias | average miss | within 10 min | chance of 60+ | real 60+")
    out = d.get("hist_out", pd.Series(False, index=d.index)).astype(bool)
    for pos in list(CORE_GROUP) + ["All"]:
        x = d if pos == "All" else d[d["position"] == pos]
        for lab, y in (("", x), (" (not known out)", x[~out.loc[x.index]])):
            e = y["xmin"] - y["minutes"]
            print(f"{pos}{lab} | {len(y)} | {y['xmin'].mean():.1f} | {y['minutes'].mean():.1f} | {e.mean():+.1f} | {e.abs().mean():.1f} | {(e.abs() <= 10).mean():.0%} | {y['p_60'].mean():.0%} | {(y['minutes'] >= 60).mean():.0%}")
    # 2. Chance 90min at real minutes, season totals per part
    print("\nChance 90min at their real minutes, season totals by part (penalty goals and misses left out): real | at real minutes | real / predicted")
    print("group | part | real | at real minutes | ratio")
    for pos in list(CORE_GROUP) + ["All"]:
        x = d if pos == "All" else d[d["position"] == pos]
        for c in POINT_PARTS:
            r, a = x[f"rp_{c}"].sum(), x[f"am_{c}"].sum()
            if abs(r) + abs(a) >= 1:
                print(f"{pos} | {c} | {r:.0f} | {a:.1f} | {r / a if a else float('nan'):.2f}")
        print(f"{pos} | Total | {real_no_pens(x).sum():.0f} | {x['xpts_real_min'].sum():.1f} | {real_no_pens(x).sum() / x['xpts_real_min'].sum():.2f}")
    # chances per match, when he played: predicted against what happened
    pl = d[d["minutes"] > 0]
    n90 = pl["minutes"] / 90
    np90 = (pl["g90"] - (pl["pen90"] - pl["pm90"])).clip(lower=0)
    print("\nChance 90min per match at real minutes (matches he played): predicted share against real share, and sorting (AUC, 0.5 = coin flip)")
    print("figure | matches | predicted | real | AUC")
    checks = [("Score 1+ (no pens)", 1 - np.exp(-np90 * n90), pl["np_goals"] >= 1),
              ("Assist 1+", 1 - np.exp(-pl["a90"] * n90), pl["assists"] >= 1)]
    on = pl[pl["minutes"] >= 60]
    checks.append(("Clean sheet (60+)", on["p_cs"], on["ga"].fillna(9) == 0))
    if "p_defcon" in on:
        dcm = on[on["position"] != "GK"]
        checks.append(("DefCon (60+)", dcm["p_defcon"], real_parts(dcm)["DefCon and other"] >= 2))
    for name, prob, hit in checks:
        prob, hit = np.asarray(prob, float), np.asarray(hit, float)
        print(f"{name} | {len(hit)} | {prob.mean():.1%} | {hit.mean():.1%} | {_auc(prob, hit):.3f}")
    # 2b. season totals: real against predicted
    print("\nCore season totals by position: real points | xPoints (with xMin) | real without pens | xPoints at real minutes (no pens)")
    print("group | players | real | xPoints | real / xPoints | real no pens | at real minutes | real / at real minutes")
    for pos in list(CORE_GROUP) + ["All"]:
        x = core if pos == "All" else core[core["position"] == pos]
        print(f"{pos} | {len(x)} | {x['real'].sum():.0f} | {x['pred'].sum():.0f} | {x['real'].sum() / x['pred'].sum():.2f} | {x['real_np'].sum():.0f} | {x['am'].sum():.0f} | {x['real_np'].sum() / x['am'].sum():.2f}")
    # 3. ranking
    print("\nRanking inside the core, season totals: rank correlation (1 = same order) of the prediction and of the prediction at real minutes")
    print("group | predicted (xMin) | at real minutes | xMin total vs real minutes")
    for pos in list(CORE_GROUP) + ["All"]:
        x = core if pos == "All" else core[core["position"] == pos]
        print(f"{pos} | {x['real'].corr(x['pred'], method='spearman'):.2f} | {x['real_np'].corr(x['am'], method='spearman'):.2f} | {x['mins'].corr(x['xmin'], method='spearman'):.2f}")
    # finding them: the model's own top by position (same sizes) against the core
    print("\nFinding the core: the model's top by predicted season points, same numbers by position, and how many are in the core")
    print("group | found | of | real points of its picks | real points of the core")
    fnd = rp_ = rc_ = 0
    for pos, n in CORE_GROUP.items():
        x = tot[tot["position"] == pos]
        picks = set(x.nlargest(n, "pred")["pid"])
        real_top = set(core.loc[core["position"] == pos, "pid"])
        a, b = x[x["pid"].isin(picks)]["real"].sum(), x[x["pid"].isin(real_top)]["real"].sum()
        fnd, rp_, rc_ = fnd + len(picks & real_top), rp_ + a, rc_ + b
        print(f"{pos} | {len(picks & real_top)} | {n} | {a:.0f} | {b:.0f}")
    print(f"All | {fnd} | {sum(CORE_GROUP.values())} | {rp_:.0f} | {rc_:.0f}")
    # why a position ranks worse: how far apart the players are, and each part's own ranking
    print("\nSpread inside the core (standard deviation of season totals; a small spread of real points is hard to rank) and the rank correlation of each part at real minutes")
    print("group | sd real | sd xPoints | sd real / mean | Goals | Assists | Bonus | Clean sheet | DefCon and other | Appearance")
    sums = d.groupby("pid")[[f"rp_{c}" for c in POINT_PARTS] + [f"am_{c}" for c in POINT_PARTS]].sum()
    for pos in CORE_GROUP:
        x = core[core["position"] == pos]
        y = sums.loc[sums.index.isin(x["pid"])]
        rc = [y[f"rp_{c}"].corr(y[f"am_{c}"], method="spearman") for c in ("Goals", "Assists", "Bonus", "Clean sheet", "DefCon and other", "Appearance")]
        print(f"{pos} | {x['real'].std():.1f} | {x['pred'].std():.1f} | {x['real'].std() / x['real'].mean():.2f} | " + " | ".join(f"{v:.2f}" for v in rc))
    print("\nCore midfielders by part, season (real / at real minutes): goals, assists, bonus, DefCon, clean sheet")
    print("name | team | real rank | model rank | goals | assists | bonus | defcon | cs | xG (FPL) | xA (FPL)")
    xm = tot[tot["position"] == "MID"].copy()
    xm["rr"], xm["mr"] = xm["real"].rank(ascending=False, method="min"), xm["pred"].rank(ascending=False, method="min")
    agg = d.groupby("pid").agg(xg=("expected_goals", "sum"), xa=("expected_assists", "sum"))
    for r in xm.nsmallest(CORE_GROUP["MID"], "rr").itertuples():
        y = sums.loc[r.pid]
        cell = lambda c: f"{y[f'rp_{c}']:.0f}/{y[f'am_{c}']:.0f}"
        print(f"{r.name} | {r.team} | {int(r.rr)} | {int(r.mr)} | {cell('Goals')} | {cell('Assists')} | {cell('Bonus')} | {cell('DefCon and other')} | {cell('Clean sheet')} | "
              f"{agg.loc[r.pid, 'xg']:.1f} | {agg.loc[r.pid, 'xa']:.1f}")
    print("\nCore players: real rank, model rank (predicted total), predicted, real, at real minutes (no pens), real without pens, minutes, xMin")
    print("position | real rank | model rank | name | team | predicted | real | at real minutes | real no pens | minutes | xMin")
    for pos, n in CORE_GROUP.items():
        x = tot[tot["position"] == pos].copy()
        x["rr"] = x["real"].rank(ascending=False, method="min").astype(int)
        x["mr"] = x["pred"].rank(ascending=False, method="min").astype(int)
        for r in x.nsmallest(n, "rr").itertuples():
            print(f"{pos} | {r.rr} | {r.mr} | {r.name} | {r.team} | {r.pred:.1f} | {r.real:.0f} | {r.am:.1f} | {r.real_np:.0f} | {r.mins:.0f} | {r.xmin:.0f}")


def report(pred: pd.DataFrame, out_csv: Path) -> pd.DataFrame:
    pred = pred.copy()
    pred["pred_pts4"] = pred["pts4"].fillna(pred["ppg_all"]).fillna(0.0)
    pred["pred_ppg"] = pred["ppg_all"].fillna(0.0)
    pred["pred_w5"] = pred["w5_min"].fillna(0.0)
    am, rp = parts_at_real_minutes(pred), real_parts(pred)
    pred["xpts_real_min"] = am.sum(axis=1)
    pred["real_no_pens"] = real_no_pens(pred)
    for c in POINT_PARTS:
        pred[f"am_{c}"], pred[f"rp_{c}"] = am[c], rp[c]
    models = {"Model": "xpts", "Trailing 4 GW": "pred_pts4", "Long-run PPG": "pred_ppg"}
    agg = {c: "sum" for c in ["total_points", "minutes", "xpts", "pred_pts4", "pred_ppg", "xmin", "pred_w5", "xpts_real_min", "real_no_pens"]
           + [f"am_{c}" for c in POINT_PARTS] + [f"rp_{c}" for c in POINT_PARTS]}
    agg |= {"name": "last", "team": "last", "position": "last", "min_long": "last"}
    gw = pred.groupby(["season", "GW", "pid"], as_index=False).agg(agg)
    gw.to_csv(out_csv, index=False)

    regular = gw[gw["min_long"] >= 45]
    tables = {"All player-GWs": gw, "Regulars (prior avg >=45 min)": regular}
    print("\n=== Prediction accuracy ===")
    for title, d in tables.items():
        print(f"\n{title}")
        print(pd.DataFrame({m: _score(d["total_points"], d[c]) for m, c in models.items()}).T.round(3).to_string())

    print("\n=== Regulars, by position (Model) ===")
    print(pd.DataFrame({p: _score(g["total_points"], g["xpts"]) for p, g in regular.groupby("position")}).T.round(3).to_string())

    # Picking players ahead: a season total of "points in his last 4 GWs" would be his real points a few weeks late,
    # so the fair test is each 4-gameweek stretch: each way's top players by what it predicted for those 4 GWs
    # (made before them: its figure for the first of the 4) against the real top over the same 4 GWs, averaged over the stretches.
    print("\n=== Finding the best players, each 4 GWs: top by predicted points for the next 4 GWs (core sizes: GK 15, DEF 35, MID 35, FWD 15) against the real top, average over the season ===")
    TOP4 = CORE_GROUP  # the same numbers as the core group
    gws = sorted(gw["GW"].unique())
    acc = {}
    for b in range(0, len(gws), 4):
        # every way judged only on what it said before the stretch began: its figure for the first gameweek
        # (a later one would already know the real points of the gameweeks before it inside the stretch)
        real = gw[gw["GW"].isin(gws[b:b + 4])].groupby(["pid", "position"], as_index=False)["total_points"].sum().rename(columns={"total_points": "real"})
        first = gw[gw["GW"] == gws[b]][["pid"] + list(models.values())]
        blk = real.merge(first, on="pid", how="left").fillna(0.0)
        for pos, n in TOP4.items():
            d = blk[blk["position"] == pos]
            real_top = set(d.nlargest(n, "real")["pid"])
            for m, c in models.items():
                picks = set(d.nlargest(n, c)["pid"])
                a = acc.setdefault((pos, m), [0, 0, 0.0, 0.0])
                a[0] += len(picks & real_top); a[1] += n; a[2] += d[d["pid"].isin(picks)]["real"].sum(); a[3] += d[d["pid"].isin(real_top)]["real"].sum()
    print("position | way | share of the real top found | real points of its picks / real points of the real top")
    for pos in list(TOP4) + ["All"]:
        for m in models:
            keys = [(p, m) for p in TOP4] if pos == "All" else [(pos, m)]
            t = [sum(acc[k][i] for k in keys) for i in range(4)]
            print(f"{pos} | {m} | {t[0] / t[1]:.0%} | {t[2] / t[3]:.0%}")

    core_report(pred, gw)
    try:
        team_report(pred)
    except Exception as e:  # the rest of the test still runs
        print(f"Team goals and clean sheets not tested ({e})")

    print("\n=== Decisions: mean actual points per GW ===")
    rows = {}
    for m, c in models.items():
        cap = gw.loc[gw.groupby("GW")[c].idxmax().dropna().astype(int), "total_points"].mean()
        top10 = gw.sort_values(c, ascending=False).groupby("GW").head(10)["total_points"].mean()
        rows[m] = {"Captain (top 1)": cap, "Top 10 average": top10}
    print(pd.DataFrame(rows).T.round(2).to_string())

    print("\n=== Top 100 by predicted points each GW (bias above 0 = predicted too high) ===")
    print(pd.DataFrame({m: top100_scores(gw, c) for m, c in models.items()}).T.round(3).to_string())

    print("\n=== Calibration, regulars ===")
    bins = pd.qcut(regular["xpts"], 10, duplicates="drop")
    cal = regular.groupby(bins, observed=True).agg(predicted=("xpts", "mean"), actual=("total_points", "mean"), n=("xpts", "size"))
    print(cal.round(2).to_string(index=False))
    print("\n=== Chance to score / assist: predicted vs actual (players who played; goals without penalties) ===")
    played = pred[pred["minutes"] > 0]
    played = played.assign(np_g90=(played["g90"] - (played["pen90"].fillna(0) - played["pm90"].fillna(0))).clip(lower=0))
    for title, rate, actual in [("Goals (no pens)", "np_g90", "np_goals"), ("Assists", "a90", "assists")]:
        prob = 1 - np.exp(-played[rate] * played["minutes"] / 90)
        hit = (played[actual] >= 1).astype(float)
        groups = pd.cut(prob, [0, .03, .06, .1, .15, .2, .3, .4, .5, 1], include_lowest=True)
        table = pd.DataFrame({"predicted": prob, "actual": hit}).groupby(groups, observed=True).agg(predicted=("predicted", "mean"), actual=("actual", "mean"), n=("actual", "size"))
        print(f"\n{title}")
        print(table.round(3).to_string())
    print("\n=== Minutes by weighted last-5 average: predicted vs actual, per match ===")
    groups = pd.cut(pred["w5_min"], [-1, 30, 60, 75, 85, 88, 91])
    by_recent = pred.assign(actual_60=(pred["minutes"] >= 60).astype(float)).groupby(groups, observed=True).agg(
        xmin=("xmin", "mean"), actual_min=("minutes", "mean"), p60=("p_60", "mean"), actual_60=("actual_60", "mean"), n=("xmin", "size"))
    print(by_recent.round(2).to_string())
    print("\n=== Minutes, regulars ===")
    minutes = {}
    for label, col in [("xMin", "xmin")]:
        err = regular[col] - regular["minutes"]
        minutes[label] = {"MAE": err.abs().mean(), "RMSE": float(np.sqrt((err ** 2).mean()))}
    print(pd.DataFrame(minutes).T.round(2).to_string())
    print("\n=== Cards and DEFCON: predicted vs actual ===")
    for title, rate, actual in [("Yellow", "y90", "yellow_cards"), ("Red", "r90", "red_cards"), ("Penalty miss", "pm90", "penalties_missed"), ("Own goal", "og90", "own_goals")]:
        prob = 1 - np.exp(-played[rate] * played["minutes"] / 90)
        print(f"{title}: predicted {prob.mean():.3%}, actual {(played[actual] >= 1).mean():.3%}, n={len(played)}")
    need = {"has_core", "core_pen_scored", "core_pen_missed", "pen90", "pm90"}
    known = played[played["has_core"].fillna(False).astype(bool)] if need <= set(played.columns) else played.iloc[0:0]
    if len(known):
        att = known["core_pen_scored"].fillna(0) + known["core_pen_missed"].fillna(0)
        print(f"Penalties taken per player match: predicted {(known['pen90'] * known['minutes'] / 90).mean():.4f}, actual {att.mean():.4f}, "
              f"missed predicted {(known['pm90'] * known['minutes'] / 90).mean():.4f}, actual {known['core_pen_missed'].fillna(0).mean():.4f}, n={len(known)}")
    gks = played[played["position"] == "GK"]
    share = gks["minutes"] / 90
    print(f"Saves per GK match: predicted {(gks['saves90'] * share).mean():.3f}, actual {gks['saves'].mean():.3f}, n={len(gks)}")
    prob = 1 - np.exp(-gks["ps90"] * share)
    print(f"Penalty save: predicted {prob.mean():.3%}, actual {(gks['penalties_saved'] >= 1).mean():.3%}")
    teams = pred.dropna(subset=["ga"]).groupby(["season", "fixture", "team"], as_index=False).first()
    print(f"Goals conceded per team match: predicted {teams['conc90'].mean():.3f}, actual {teams['ga'].mean():.3f}, n={len(teams)}")
    known = pred[(pred["minutes"] >= 60) & pred["defensive_contribution"].notna() & (pred["position"] != "GK")]
    if len(known):
        hit = (known["defensive_contribution"] >= known["position"].map(DEFCON_THRESHOLD)).astype(float)
        groups = pd.cut(known["p_defcon"], [-.01, .1, .2, .3, .4, .5, .6, .8, 1])
        table = pd.DataFrame({"predicted": known["p_defcon"], "actual": hit}).groupby(groups, observed=True).agg(predicted=("predicted", "mean"), actual=("actual", "mean"), n=("actual", "size"))
        print("\nDEFCON, players with 60+ minutes")
        print(table.round(3).to_string())
    print(f"\nMinutes MAE, regulars: {(regular['xmin'] - regular['minutes']).abs().mean():.1f}")
    print(f"Saved player-GW predictions: {out_csv}")
    return gw


# ---------------------------------------------------------------- live prediction
def _api(path: str, cache: Path, offline: bool):
    f = cache / (path.strip("/").replace("/", "_") + ".json")
    if offline or (f.exists() and time.time() - f.stat().st_mtime < 3600):
        return json.loads(f.read_text())
    data = json.loads(_get(f"{API}/{path}"))
    cache.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data))
    time.sleep(0.12)
    return data


MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
RETURN_DATE = re.compile(r"(?:expected back|suspended until|until|back)\s+(\d{1,2})\s+([A-Za-z]{3})", re.I)


def return_date(news: str, news_added: str | None) -> pd.Timestamp | None:
    """The date FPL news gives for a player's return ("Expected back 22 Nov", "Suspended until 29 Nov"), or None.

    FPL leaves out the year: it is the year that puts the date nearest the day the news was written (a date a few weeks
    before it is stale news, one in January written in December is next year)."""
    m = RETURN_DATE.search(news or "")
    if not m or m.group(2).lower() not in MONTHS:
        return None
    t = pd.Timestamp(news_added) if news_added else pd.Timestamp.now()
    added = (t.tz_localize(None) if t.tzinfo is None else t.tz_convert(None)).normalize()
    best = None
    for year in (added.year - 1, added.year, added.year + 1):
        try:
            d = pd.Timestamp(year=year, month=MONTHS[m.group(2).lower()], day=int(m.group(1)))
        except ValueError:
            return None
        if best is None or abs((d - added).days) < abs((best - added).days):
            best = d
    return best


# Typical days out for an injury FPL gives no return date for, by the words in the news: the median days out of
# 1,898 injuries of Premier League squad players in 2024-25 and 2025-26 on Soccerway (archive/injuries, checked by
# tools/soccerway_days.py); the first match back counts half. The first match listed wins.
INJURY_DAYS = [(("acl", "cruciate", "achilles"), 270, "a long-term injury"), (("surgery", "operation"), 70, "surgery"),
               (("fracture", "broken"), 56, "a fracture"), (("hamstring",), 42, "a hamstring injury"), (("knee",), 24, "a knee injury"),
               (("thigh", "muscle", "muscular"), 21, "a muscle injury"), (("calf",), 21, "a calf injury"), (("ankle",), 21, "an ankle injury"),
               (("foot", "toe"), 33, "a foot injury"), (("groin", "adductor"), 16, "a groin injury"), (("hip",), 11, "a hip injury"),
               (("shoulder",), 10, "a shoulder injury"), (("back",), 14, "a back injury"), (("concussion", "head"), 10, "a head injury"),
               (("illness", " ill"), 7, "illness"), (("knock",), 7, "a knock")]
INJURY_DAYS_DEFAULT = (7, "an injury")
INJURY_WEEKS = INJURY_DAYS  # (the words are also used to tell an injury from other absences)


def injury_days(news: str) -> tuple[int, str]:
    """Typical days out for an injury, from the words in FPL's news."""
    text = f" {(news or '').lower()}"
    for words, days, label in INJURY_DAYS:
        if any(w in text for w in words):
            return days, label
    return INJURY_DAYS_DEFAULT


NPXG_PEN = PEN_XG  # Opta's xG of a penalty (0.79), for non-penalty xG
# Back from an injury, by how long he was out (days from the first match missed, or from the news, to his return):
# his share of usual minutes in the first match back, and in the matches up to 14 and 28 days after that one.
# From 484 returns of regular starters in 2024-25 and 2025-26 (real minutes against his usual before the injury,
# against the 88-90% a fit regular plays): counted in days, not matches, so an international break in between
# counts as recovery time and a busy Christmas puts more matches inside it.
RETURN_RULES = [(14, 0.80, 1.0, 1.0),    # out under 2 weeks: 80% in the first match back, then full
                (28, 0.55, 0.90, 1.0),   # 2-4 weeks: 55%, 90% for 14 days, then full
                (None, 0.40, 0.70, 0.85)]  # 4 weeks or more: 40%, 70% for 14 days, 85% to day 28, then full
LONG_TERM_DAYS = 28  # from this long out, the slow ramp


def return_rule(days_out: float | None) -> tuple[float, float, float]:
    """(first match, to day 14, to day 28) shares of usual minutes after an injury absence of days_out days."""
    d = 0 if days_out is None else days_out
    for upto, first, d14, d28 in RETURN_RULES:
        if upto is None or d < upto:
            return first, d14, d28
    return 1.0, 1.0, 1.0


def return_window(days_out: float | None) -> int:
    """Days after the first match back that still count as recovery (0: the first match only)."""
    first, d14, d28 = return_rule(days_out)
    return 28 if d28 < 1 else 14 if d14 < 1 else 0


def return_share(days_out: float | None, since: float, first_match: bool) -> float:
    """His share of usual minutes in a match `since` days after his first match back (first_match: it is that one)."""
    first, d14, d28 = return_rule(days_out)
    if first_match:
        return first
    return d14 if since <= 14 else d28 if since <= 28 else 1.0


def ramp_after(out: list[float], days_out: float | None, kicks: list[pd.Timestamp]) -> list[float]:
    """The shares once he is back: from the first fixture with a share above 0, the return rule by days."""
    i = next((j for j, v in enumerate(out) if v > 0), None)
    if i is None:
        return out
    t0 = kicks[i]
    return [v if j < i else min(v, 1.0) * return_share(days_out, (kicks[j] - t0).days, j == i) for j, v in enumerate(out)]


def rule_text(days_out: float | None) -> str:
    first, d14, d28 = return_rule(days_out)
    parts = [f"{round(first * 100)}% of his minutes in the first match back"]
    if d14 < 1:
        parts.append(f"{round(d14 * 100)}% for 14 days")
    if d28 < 1:
        parts.append(f"{round(d28 * 100)}% to day 28")
    return ", ".join(parts) + ", then full"


def minute_plan(status: str | None, news: str, news_added: str | None, chance: float | None,
                fixtures: list[tuple[int, pd.Timestamp]], first: int, red_last: bool, news_gw: int | None = None) -> tuple[list[float], bool, str, int | None]:
    """How much of his usual minutes a player is expected to play in each upcoming fixture (gameweek, kickoff in UK time).

    Returns the share per fixture, whether his minutes should come from the matches before his current absence,
    a short note, and the gameweek he is back.
    - A return date in the news (injury or ban): 0 before it, then his usual minutes from the 5-4-3-2-1 formula on
      the matches before the absence.
    - Injured with no return date: out for the typical days for that injury (see INJURY_DAYS), counted from the date
      of the news, at least the next gameweek.
    - Not available for another reason (left the club, on loan) with no return date: 0 in every gameweek.
    - Suspended with no date, or a red card in his last match before FPL has flagged it: out for one match.
    - Doubtful (25/50/75%): xMin times FPL's chance in the next gameweek, full after that.
    - Back from an injury (with or without a date): the return rule by days out (RETURN_RULES): 80%, 55% or 40% in
      the first match back, then 90% / 70% and 85% for up to 28 days, by how long he was out.
    """
    status = status or "a"
    n = len(fixtures)
    back = lambda i: (fixtures[i][0] if i < n else None)
    if status == "u":
        return [0.0] * n, False, "Unavailable", None
    when = return_date(news, news_added) if status != "a" else None
    if when is not None:
        out = [0.0 if k.normalize() < when else 1.0 for _, k in fixtures]
        span = None
        if news_added:
            t0 = pd.Timestamp(news_added)
            span = (when - (t0.tz_convert(None) if t0.tzinfo else t0).normalize()).days
        injured = status != "s"  # a ban needs no ramp
        if injured:
            out = ramp_after(out, span, [k for _, k in fixtures])
        i = next((j for j, v in enumerate(out) if v > 0), n)
        note = f"Back GW{back(i)} ({when:%d %b})" if i < n else f"Out until {when:%d %b}, after these gameweeks"
        if injured and i < n:
            note += f": {span if span is not None else '?'} days out, {rule_text(span)}"
        return out, True, note, back(i)
    is_injury = status == "i" or (status == "n" and any(w in f" {(news or '').lower()}" for ws, _, _ in INJURY_WEEKS for w in ws))
    if is_injury:
        days, label = injury_days(news)
        start = pd.Timestamp(news_added) if news_added else pd.Timestamp.now(tz="UTC")
        start = start.tz_localize("UTC") if start.tzinfo is None else start
        due = start + pd.Timedelta(days=days)
        # out until the date (FPL has him at 0% for the next gameweek in any case), half his minutes the first match back
        out = []
        for gw, k in fixtures:
            kick = k.tz_localize("Europe/London") if k.tzinfo is None else k
            out.append(0.0 if gw == first or kick < due else 1.0)
        out = ramp_after(out, days, [k for _, k in fixtures])
        i = next((j for j, v in enumerate(out) if v > 0), n)
        local = due.tz_convert("Europe/London")
        back_txt = f"back around {local:%d %b}, GW{back(i)}" if i < n else f"back around {local:%d %b}, after these gameweeks"
        if i < n:
            back_txt += f", then {rule_text(days)}"
        # no return gameweek is passed on: the injury log and the site only show return dates FPL gave
        return out, True, f"No return date: about {days} days out for {label} from the news on {start.tz_convert('Europe/London'):%d %b}, {back_txt} (estimate)", None
    if status in ("i", "n"):
        return [0.0] * n, False, "Unavailable, no return date: 0", None
    if status == "s" or red_last:
        out = [0.0 if j == 0 else 1.0 for j in range(n)]
        why = "Suspended, no date given" if status == "s" else "Red card in his last match"
        return out, True, f"{why}: out 1 match, back GW{back(1)}" if n > 1 else f"{why}: out 1 match", back(1)
    if status == "d":
        c = 1.0 if chance is None else chance / 100
        out = [c if gw == first else 1.0 for gw, _ in fixtures]  # FPL's chance is for the next gameweek
        return out, False, f"Doubtful {round(c * 100)}% for GW{first}", None
    return [1.0] * n, False, "", None


def outside_matches(cache: Path, offline: bool) -> dict:
    """Matches outside the league this season, per club and FotMob player name: [(kick-off, minutes, what)], from
    cup and European matches (CUP_MINUTES with FotMob's fixtures) and national-team matches (INTL_MINUTES)."""
    out: dict = {}
    try:
        fx = club_fixtures(cache, offline)
        mf = cache / "fotmob" / "members.json"
        members = json.loads(mf.read_text()) if mf.exists() else {}
        store = json.loads(CUP_MINUTES.read_text(encoding="utf-8")) if CUP_MINUTES.exists() else {}
        for t in fx["teams"]:
            squad = {_name_key(m[0]) for m in members.get(t["short"], [])}
            for m in t["matches"]:
                rec = store.get(str(m.get("mid"))) if m["comp"] in CUP_CODES and m.get("score") is not None else None
                if not rec or not rec.get("teams"):
                    continue
                side = max(rec["teams"].values(), key=lambda names: sum(_name_key(n) in squad for n in names))
                for n, mins in side.items():
                    out.setdefault(t["short"], {}).setdefault(n, []).append((m.get("t") or "", int(mins), f"{m['comp']} v {m['opp']}"))
    except Exception as e:
        print(f"Cup minutes for flags not read ({e})")
    try:
        intl = json.loads(INTL_MINUTES.read_text(encoding="utf-8")) if INTL_MINUTES.exists() else {}
        for rec in intl.values():
            for t, opp, mins, comp, nat in (rec.get("matches") or {}).values():
                out.setdefault(rec.get("club"), {}).setdefault(rec["name"], []).append((t, int(mins), f"{nat} v {opp}"))
    except Exception as e:
        print(f"International minutes for flags not read ({e})")
    return out


FIT_AFTER_FLAG_MIN = 90  # a full match outside the league after FPL's injury flag: taken as fit


def replay_status(gw: int, deadline: str | None) -> dict:
    """Each player's FPL flag just before GW gw's deadline, from the injury log (every FPL news change it saw, with
    its time). An absence the log rebuilt from missed matches, with no news seen by then, counts as injured with no
    date. Players with no open entry are fit."""
    if not INJURY_LOG.exists():
        return {}
    code = {"Injury": "i", "Illness": "i", "Doubtful": "d", "Suspended": "s", "Unavailable": "u"}
    out = {}
    for e in json.loads(INJURY_LOG.read_text(encoding="utf-8")):
        if e.get("season") != CURRENT_SEASON or e.get("manual"):
            continue
        seen = [u for u in e.get("updates") or [] if deadline and u.get("at") and u["at"] <= deadline[:16] + "Z"]
        returned = e.get("returnedGw")
        open_then = (e.get("startGw") or 99) <= gw and (returned is None or returned > gw)
        if seen:
            u = seen[-1]
            if e.get("closedAt") and e["closedAt"] <= (deadline or "")[:16] + "Z":
                continue
            out[e["pid"]] = {"status": code.get(u.get("type"), "i"), "news": u.get("news") or "", "news_added": u["at"].replace("Z", ":00Z"),
                             "chance_of_playing_next_round": u.get("chance")}
        elif open_then and (e.get("startGw") or 99) < gw:
            out[e["pid"]] = {"status": code.get(e.get("type"), "i"), "news": "", "news_added": None, "chance_of_playing_next_round": 0}
    return out


def live_frames(cache: Path, offline: bool, horizon: int) -> tuple[pd.DataFrame, pd.DataFrame, int]:
    boot = _api("bootstrap-static/", cache, offline)
    fixtures = _api("fixtures/", cache, offline)
    teams = {t["id"]: t["name"] for t in boot["teams"]}
    short = {t["id"]: t.get("short_name", t["name"]) for t in boot["teams"]}
    pos = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
    fix = {f["id"]: f for f in fixtures}
    deadlines = {e["id"]: e.get("deadline_time") for e in boot["events"]}  # stands in for a kickoff not yet scheduled
    upcoming = [e["id"] for e in boot["events"] if e.get("is_next")] or [e["id"] for e in boot["events"] if not e.get("finished")]
    if REPLAY_GW:
        upcoming = [REPLAY_GW]
    if not upcoming:
        raise SystemExit("No upcoming gameweek.")
    first = upcoming[0]
    replay_flags = replay_status(first, deadlines.get(first)) if REPLAY_GW else {}
    gws = set(range(first, first + horizon))
    hist, fut = [], []

    def news_gw(added: str | None) -> int:
        """The gameweek being played when the news was written: the last one whose deadline had passed."""
        past = [g for g, d in deadlines.items() if d and added and d <= added]
        return max(past) if past else first

    outside = outside_matches(cache, offline)
    cleared = []
    for p in boot["elements"]:
        if pos.get(p["element_type"]) is None:
            continue
        name = f'{p.get("first_name", "")} {p.get("second_name", "")}'.strip() or p["web_name"]
        if REPLAY_GW:  # FPL's flag as it stood before that deadline, from the injury log's record of FPL's news
            p = dict(p, **replay_flags.get(f'c{p["code"]}', {"status": "a", "news": "", "news_added": None, "chance_of_playing_next_round": None}))
        # Flagged injured or doubtful, but has played a full match for his country or in a cup since: fit.
        if p.get("status") in ("i", "d") and p.get("news_added") and not REPLAY_GW:
            seen = _fm_find({"name": p["web_name"], "fullName": name}, outside.get(short[p["team"]], {})) or []
            full = sorted(x for x in seen if x[0] > p["news_added"] and x[1] >= FIT_AFTER_FLAG_MIN)
            if full:
                t90, _, what = full[-1]
                p = dict(p, status="a", chance_of_playing_next_round=None,
                         news=f"Played {FIT_AFTER_FLAG_MIN} minutes ({what}, {t90[:10]}) after FPL's flag: taken as fit. FPL: {p.get('news', '')}")
                cleared.append(p["web_name"])
        base = {"name": name, "position": pos[p["element_type"]], "element": p["id"], "code": p["code"], "season": CURRENT_SEASON,
                **{new: p.get(old) for old, new in SET_PIECE_COLS.items()}}
        played = []
        for row in _api(f"element-summary/{p['id']}/", cache, offline)["history"]:
            f = fix.get(row["fixture"])
            # Use every match that has been played: FPL marks a whole gameweek finished only some time later.
            if f is None or not (f.get("finished") or f.get("finished_provisional")):
                continue
            if REPLAY_GW and (f.get("event") or 99) >= REPLAY_GW:
                continue  # not played yet at that deadline
            played.append(row)
            hist.append(row | base | {"GW": row["round"], "team": teams[f["team_h"] if row["was_home"] else f["team_a"]], "opponent_team": row["opponent_team"], "future": False})
        last = max(played, key=lambda r: r.get("kickoff_time") or "", default=None)
        red_last = bool(last and float(last.get("red_cards") or 0) > 0)
        # Doubtful: the match he got hurt in (the last one before FPL flagged him) is left out of xMin, and so are
        # matches since then that he missed; matches he played while flagged count.
        flag_cut = None
        if p.get("status") == "d" and p.get("news_added"):
            before = [r["kickoff_time"] for r in played if r.get("kickoff_time") and r["kickoff_time"] <= p["news_added"]]
            flag_cut = max(before) if before else None
        mine = []
        for f in sorted((f for f in fixtures if f.get("event") in gws and (REPLAY_GW or not f.get("finished")) and p["team"] in (f["team_h"], f["team_a"])),
                        key=lambda f: (f["event"], f.get("kickoff_time") or "")):
            kick = pd.Timestamp(f.get("kickoff_time") or deadlines[f["event"]]).tz_convert("Europe/London").tz_localize(None)
            mine.append((f, kick))
        share, from_return, note, back_gw = minute_plan(p.get("status"), p.get("news", ""), p.get("news_added"), p.get("chance_of_playing_next_round"),
                                                       [(f["event"], k) for f, k in mine], first, red_last, news_gw(p.get("news_added")))
        # Already back (no flag now) from an injury absence: the rest of the return rule, by days since his first match
        # back. The absence is the run of league matches he missed (0 minutes) right before his matches since.
        if (p.get("status") or "a") == "a" and played and mine:
            seq = sorted(played, key=lambda r: r.get("kickoff_time") or "")
            since = 0
            while since < len(seq) and float(seq[-1 - since].get("minutes") or 0) > 0:
                since += 1
            j = len(seq) - since
            zeros = 0
            while j - 1 - zeros >= 0 and float(seq[j - 1 - zeros].get("minutes") or 0) == 0:
                zeros += 1
            if since and zeros and j < len(seq):
                t0 = pd.Timestamp(seq[j]["kickoff_time"]).tz_convert("Europe/London").tz_localize(None)
                gap = (t0 - pd.Timestamp(seq[j - zeros]["kickoff_time"]).tz_convert("Europe/London").tz_localize(None)).days
                before = [float(r.get("minutes") or 0) for r in seq[max(0, j - zeros - 5):j - zeros]]
                window = return_window(gap)
                w = MINUTE_WEIGHTS[:len(before)]
                usual_before = float(np.dot(before[::-1], w) / w.sum()) if before else 0.0
                done = any(float(r.get("minutes") or 0) >= usual_before for r in seq[j:])  # back to his usual minutes already
                if window and before and not done and np.mean(before) >= 45 and (mine[0][1] - t0).days <= window:  # a regular, still recovering
                    share = [v * return_share(gap, (k - t0).days, False) for v, (_, k) in zip(share, mine)]
                    from_return = True
                    note = f"Back from {gap} days out ({t0:%d %b}): {rule_text(gap)}" + (f"; {note}" if note else "")
        for (f, _), avail in zip(mine, share):
            home = f["team_h"] == p["team"]
            team_id = p["team"]
            fut.append(base | {"GW": f["event"], "fixture": f["id"], "team": teams[team_id], "opponent_team": f["team_a"] if home else f["team_h"],
                                "was_home": home, "kickoff_time": f.get("kickoff_time"), "value": p["now_cost"], "minutes": np.nan, "future": True,
                                "avail": avail, "from_return": from_return, "min_note": note, "return_gw": back_gw, "flag_cut": flag_cut,
                                "news_added": p.get("news_added"), "chance": p.get("chance_of_playing_next_round"), "news_gw": news_gw(p.get("news_added")),
                                "team_short": short[team_id], "opp_short": short[f["team_a"] if home else f["team_h"]], "web_name": p["web_name"], "status": p.get("status"), "news": p.get("news", ""),
                                "pen_text": p.get("penalties_text") or "", "fk_text": p.get("direct_freekicks_text") or "", "corner_text": p.get("corners_and_indirect_freekicks_text") or ""})
    if cleared:
        print(f"Flagged but played {FIT_AFTER_FLAG_MIN} minutes outside the league since, taken as fit: {', '.join(cleared)}")
    return pd.DataFrame(hist), pd.DataFrame(fut), first


def goalkeeper_cover(target: pd.DataFrame) -> pd.DataFrame:
    """Only one goalkeeper plays. When a team's first-choice goalkeeper is out or flagged and expected back (60+
    usual minutes when fit), the stand-in's share of a match is cut by the starter's: 0 once the starter is fully
    back, a quarter where the starter is 75% to play, half where he is expected to play half."""
    t = target.copy()
    if "position" not in t or "from_return" not in t:
        return t
    usual = pd.Series(usual_minutes(t)["min"], index=t.index)
    gk = t["position"] == "GK"
    cut = 0
    for team, g in t[gk].groupby("team"):
        # the first choice: out or flagged now (absent, doubtful, back from an absence), 60+ usual minutes when fit
        away = g["from_return"].fillna(False).astype(bool) | g["status"].fillna("a").isin(["d", "i", "s", "n"])
        starters = g.loc[away & (usual[g.index] >= 60), "pid"].unique()
        for sp in starters:
            share = g[g["pid"] == sp].set_index("fixture")["avail"].fillna(0.0)
            share = share[~share.index.duplicated()]
            if not (share > 0).any():
                continue
            back_gw = int(g.loc[(g["pid"] == sp) & (g["avail"].fillna(0) > 0), "GW"].min())
            sp_name = str(g.loc[g["pid"] == sp, "web_name"].iloc[0]) if "web_name" in g else str(sp)
            for op in g.loc[g["pid"] != sp, "pid"].unique():
                rows = t.index[(t["pid"] == op) & gk]
                s_ = t.loc[rows, "fixture"].map(share)
                factor = (1 - s_.fillna(0.0)).clip(0.0, 1.0)
                t.loc[rows, "avail"] = t.loc[rows, "avail"].fillna(1.0) * factor
                if (factor < 1).any():
                    cut += 1
                    old = t.loc[rows, "min_note"].fillna("") if "min_note" in t else pd.Series("", index=rows)
                    note = f"{sp_name} expected back GW{back_gw}: his minutes go to him from then"
                    t.loc[rows, "min_note"] = np.where(old != "", old + "; " + note, note)
    if cut:
        print(f"Stand-in goalkeepers cut for a returning first choice: {cut}")
    return t


def doubtful_minutes(target: pd.DataFrame, df: pd.DataFrame) -> pd.DataFrame:
    """For a player flagged doubtful, xMin leaves out the match he got hurt in (see flag_cut; not if he still played
    the full 90) and the matches since in which he did not play. A match he played while flagged (a 25% flag but he still started) counts as usual."""
    if "flag_cut" not in target:
        return target
    target = target.copy()
    obs = df[~df["future"] & df["minutes"].notna()]
    for pid, cut in target.loc[target["flag_cut"].notna(), ["pid", "flag_cut"]].drop_duplicates("pid").itertuples(index=False):
        g = obs[obs["pid"] == pid]
        # the match he got hurt in is left out only if FotMob shows him taken off injured (or, for a gameweek FotMob
        # does not cover, if he did not play the full 90)
        cov = g["fm_cov"].fillna(False).astype(bool) if "fm_cov" in g else pd.Series(False, index=g.index)
        hurt = g["inj_hurt"].fillna(False).astype(bool) if "inj_hurt" in g else pd.Series(False, index=g.index)
        knock = (g["kickoff_time"] == pd.Timestamp(cut)) & (hurt | (~cov & (g["minutes"].fillna(0) < 90)))
        after = g["kickoff_time"] > pd.Timestamp(cut)
        g = g[~knock & ~(after & (g["minutes"].fillna(0) == 0))].sort_values(["kickoff_time", "fixture"])
        if g.empty:
            continue
        n = len(g) + 1  # one extra row with no match gives the figures after all of them
        mins = np.append(g["minutes"].to_numpy(float), 0.0)
        reds = np.append(g["red_cards"].fillna(0).to_numpy(float), 0.0)
        bans = np.append(skipped(g).astype(float).to_numpy(), 0.0)
        out = ai_minutes(np.array([pid] * n), mins, np.append(np.ones(n - 1), 0.0), reds, bans)
        rows = target["pid"] == pid
        target.loc[rows, "w5_min"], target.loc[rows, "w5_p1"], target.loc[rows, "w5_p60"] = out[0][-1], out[1][-1], out[2][-1]
        target.loc[rows, "recent_mins"] = out[-1][-1] + " (without the knock match)"
    return target


PEN_GRID = np.arange(90) + 0.5  # minutes of a match, for who is on the pitch when a penalty is given
PEN_PATTERN_MATCHES, PEN_PATTERN_MIN = 5, 3  # the club's last 5 matches with all its listed takers fit (at least 3)


def pitch_profile(frame: pd.DataFrame) -> pd.DataFrame:
    """Per row: the chance he starts (Start), his minutes when he starts and when he does not, and the chance he is
    there at all (his expected minutes over his usual ones), so that they add up to his expected minutes."""
    u = usual_minutes(frame)
    usual = np.nan_to_num(u["min"])
    xmin = np.clip(usual * frame["avail"].fillna(1).to_numpy(float), 0, 90)
    st = np.where(np.isnan(u["st"]), np.nan_to_num(u["p60"]), u["st"])
    ms = np.where(np.isnan(u["ms"]), np.clip(usual / np.maximum(st, 1e-6), 0, 90), u["ms"])
    mb = np.where(np.isnan(u["mb"]), 0.0, u["mb"])
    base = st * ms + (1 - st) * mb
    k = np.where(base > 0, usual / np.maximum(base, 1e-9), 0.0)  # the 5-match averages to his usual minutes
    there = np.where(usual > 0, np.clip(xmin / np.maximum(usual, 1e-9), 0, 1), 0.0)
    last = np.where(np.isnan(u["last"]), np.round(st), u["last"])  # did he start his last match (counted as in Usual)
    return pd.DataFrame({"start": st, "last": last, "ms": np.clip(ms * k, 0, 90), "mb": np.clip(mb * k, 0, 90), "there": there,
                         "p_start": st * there}, index=frame.index)


def start_patterns(hist: pd.DataFrame | None, team, pids: list) -> list[tuple[float, tuple]]:
    """Which of these players started together in the club's last matches with all of them fit, newest weighted
    5-4-3-2-1: [(weight, started flags)]. Empty when fewer than PEN_PATTERN_MIN such matches."""
    if hist is None or len(pids) < 2:
        return []
    h = hist[(hist["team"] == team) & hist["pid"].isin(pids)]
    out = []
    for _, g in sorted(h.groupby(["season", "fixture"]), key=lambda kv: -pd.Timestamp(kv[1]["kickoff_time"].iloc[0]).value):
        if g["pid"].nunique() < len(pids) or g["skip"].any():
            continue
        st = g.groupby("pid")["started"].max()
        out.append(tuple(float(st.get(x, 0)) for x in pids))
        if len(out) == PEN_PATTERN_MATCHES:
            break
    if len(out) < PEN_PATTERN_MIN:
        return []
    w = MINUTE_WEIGHTS[:len(out)]
    return [(float(wi / w.sum()), f) for wi, f in zip(w, out)]


def start_cases(starts: list[float], patterns: list) -> list[tuple[float, tuple]]:
    """Every case of who starts among these players with its chance. Each player starts as often as his own Start
    says; the club's recent start patterns only decide who starts together (fitted to those chances, iterative
    proportional fitting, with a little of the independent cases mixed in so no case is ruled out)."""
    k = len(starts)
    cells = [tuple(float(b >> i & 1) for i in range(k)) for b in range(2 ** k)]
    indep = np.array([float(np.prod([s if f else 1 - s for s, f in zip(starts, c)])) for c in cells])
    if not patterns:
        return [(w, c) for w, c in zip(indep, cells) if w > 0]
    seen = np.zeros(len(cells))
    for w, fl in patterns:
        seen[cells.index(tuple(float(f) for f in fl))] += w
    p = 0.9 * seen / max(seen.sum(), 1e-12) + 0.1 * indep + 1e-9
    p /= p.sum()
    for _ in range(60):
        for i, s in enumerate(starts):
            on = np.array([c[i] == 1 for c in cells])
            m = p[on].sum()
            if 0 < m < 1:
                p[on] *= s / m
                p[~on] *= (1 - s) / (1 - m)
            p /= p.sum()
    return [(float(w), c) for w, c in zip(p, cells) if w > 1e-9]


def pen_time_shares(listed: list[dict], fks: list[dict], patterns: list) -> tuple[dict, dict]:
    """Share of the team's penalties each player takes while on the pitch, minute by minute: in every case of who
    starts (the club's recent start patterns, else each player's Start on its own) and who is there at all, the
    first listed taker on the pitch takes them; when none is on, the free kick and corner takers on the pitch share
    them. A starter is on from the start for his starting minutes, a substitute at the end for his. Returns
    (share while on the pitch, share if he played the whole match) by id."""
    k = len(listed)
    on_s = [(PEN_GRID < x["ms"]).astype(float) for x in listed]
    on_b = [(PEN_GRID >= 90 - x["mb"]).astype(float) for x in listed]
    cases = start_cases([x["start"] for x in listed], patterns)
    took, on_t, free = np.zeros(k), np.zeros(k), np.zeros(k)
    uncovered = np.zeros(90)
    for w, fl in cases:
        for there in range(2 ** k):
            wt = w * float(np.prod([x["there"] if there >> i & 1 else 1 - x["there"] for i, x in enumerate(listed)]))
            if wt <= 0:
                continue
            covered = np.zeros(90)
            for i in range(k):
                on = (on_s[i] if fl[i] else on_b[i]) if there >> i & 1 else np.zeros(90)
                free[i] += wt * float((1 - covered).mean())
                take = on * (1 - covered)
                took[i] += wt * float(take.mean())
                on_t[i] += wt * float(on.mean())
                covered = np.maximum(covered, on)
            uncovered += wt * (1 - covered)
    share, whole = {}, {}
    for i, x in enumerate(listed):
        whole[x["id"]] = PEN_TAKE_ON_PITCH * free[i]
        share[x["id"]] = PEN_TAKE_ON_PITCH * (took[i] / on_t[i] if on_t[i] > 1e-9 else free[i])
    if fks:
        # penalties while no listed taker is on go to the free kick and corner takers, split by their expected
        # minutes (the same extra share for each while he is on the pitch; starting or not does not matter here)
        left = float(uncovered.mean())
        mins = sum(x["m"] for x in fks)
        for x in fks:
            if x["m"] > 0 and mins > 0:
                share[x["id"]] = min(1.0, share.get(x["id"], 0) + left / mins)
    return share, whole


def penalty_shares(target: pd.DataFrame, hist: pd.DataFrame | None = None, fixed_order: bool = False) -> np.ndarray:
    """Share of his team's penalties a player takes while on the pitch, per future match, minute by minute (see
    pen_time_shares): each listed taker with a Start above 50% is on from the kick-off for his usual minutes, one
    below comes on for them at the end; the first listed taker on the pitch takes the penalty, and penalties while
    none of them is on go to the free kick and corner takers, split by their expected minutes. So two takers who both
    started leave the next one only the end of the match, after they have gone off.

    hist: not used any more (start patterns), kept for the callers."""
    out = np.zeros(len(target))
    prof = pitch_profile(target)
    order = pd.to_numeric(target["pen_order"], errors="coerce")
    if fixed_order:  # the site: one order per player, from his first coming match (the order it shows)
        by_gw = target.sort_values(["GW", "fixture"])
        order = pd.to_numeric(by_gw.groupby("pid")["pen_order"].transform(lambda x: x.iloc[0]), errors="coerce").reindex(target.index)
    listed_col = lambda c: pd.to_numeric(target[c], errors="coerce").notna().to_numpy() if c in target else np.zeros(len(target), bool)
    fk_any = listed_col("fk_order") | listed_col("corner_order")
    frame = pd.DataFrame({"fixture": target["fixture"].to_numpy(), "team": target["team"].to_numpy(), "pid": target["pid"].to_numpy(),
                          "order": order.to_numpy(), "fk": fk_any, "pos": np.arange(len(target))})
    for c in ("start", "ms", "mb", "there"):
        frame[c] = prof[c].to_numpy()
    # Kept simple for penalties: a Start above 50% means he starts and is on from the kick-off for his usual minutes,
    # otherwise he comes on for them at the end (either way his expected minutes add up)
    frame["start"] = (prof["start"].to_numpy() > 0.5).astype(float)
    usual_m = np.clip(np.nan_to_num(usual_minutes(target)["min"]), 0, 90)
    frame["ms"] = usual_m
    frame["mb"] = usual_m
    frame["m"] = np.clip(np.nan_to_num(usual_minutes(target)["min"]) * target["avail"].fillna(1).to_numpy(float), 0, 90) / 90
    memo: dict = {}
    gone = (target["status"] == "u").to_numpy() if "status" in target else np.zeros(len(target), bool)
    frame = frame[~gone]  # players no longer at the club (not on the site either)
    for (fx, team), g in frame.groupby(["fixture", "team"]):
        lst = g[g["order"].notna()].sort_values("order")
        listed = [dict(id=r.pid, start=r.start, ms=r.ms, mb=r.mb, there=r.there) for r in lst.itertuples()]
        fkr = g[g["fk"] & g["order"].isna() & (g["there"] > 0)]
        fks = [dict(id=r.pid, m=r.m) for r in fkr.itertuples()]
        share, _ = pen_time_shares(listed, fks, [])
        for r in g.itertuples():
            if r.pid in share:
                out[r.pos] = share[r.pid]
    PEN_PATTERNS.clear()
    PEN_PATTERNS.update({k: v for k, v in memo.items() if v})
    return out


PEN_PATTERNS: dict = {}  # (team, listed taker ids) -> start patterns, for the site


def pattern_history(df: pd.DataFrame) -> pd.DataFrame:
    """Played league matches with whether he started and whether the match is left out of his minutes formula."""
    h = df[~df["future"] & df["minutes"].notna()]
    started = h["starts"].fillna((h["minutes"] >= 60).astype(float)) if "starts" in h else (h["minutes"] >= 60).astype(float)
    return pd.DataFrame({"pid": h["pid"], "team": h["team"], "season": h["season"], "fixture": h["fixture"], "kickoff_time": h["kickoff_time"],
                         "started": (started > 0).astype(float), "skip": skipped(h).to_numpy() | (h["red_cards"].fillna(0) > 0).to_numpy()})


# ---------------------------------------------------------------- European weeks
# Clubs in the Champions League, Europa League or Conference League rest players in the league match just after a
# European match. Fixture lists come from fixturedownload.com (one JSON feed per competition and season).
EURO_COMPS = {"champions-league": "UCL", "europa-league": "UEL", "conference-league": "UECL"}
EURO_FEED = "https://fixturedownload.com/feed/json/{comp}-{year}"
EURO_DAYS = 4.5           # a league match up to this many days after a European match counts as "just after"
EURO_K_PLAYER = 6.0       # post-European matches a player needs before his own rate counts as much as his team's
EURO_K_TEAM = 10.0        # the same for a team against the league-wide rate
EURO_SEASON_W = {0: 1.0, 1: 0.5, 2: 0.25}  # weight by seasons back from the current one
# Names in the fixture feeds of English clubs (lower case, no punctuation) -> FPL team names.
EURO_ALIASES = {
    "arsenal": "Arsenal", "aston villa": "Aston Villa", "chelsea": "Chelsea", "liverpool": "Liverpool",
    "man city": "Man City", "manchester city": "Man City", "man utd": "Man Utd", "man united": "Man Utd", "manchester united": "Man Utd",
    "newcastle": "Newcastle", "newcastle united": "Newcastle", "newcastle utd": "Newcastle", "tottenham": "Spurs", "tottenham hotspur": "Spurs", "spurs": "Spurs",
    "brighton": "Brighton", "brighton  hove albion": "Brighton", "brighton and hove albion": "Brighton", "west ham": "West Ham", "west ham united": "West Ham",
    "nottm forest": "Nott'm Forest", "nott m forest": "Nott'm Forest", "nottingham forest": "Nott'm Forest", "nott forest": "Nott'm Forest", "crystal palace": "Crystal Palace",
    "fulham": "Fulham", "brentford": "Brentford", "bournemouth": "Bournemouth", "afc bournemouth": "Bournemouth", "everton": "Everton",
    "wolves": "Wolves", "wolverhampton": "Wolves", "wolverhampton wanderers": "Wolves", "leeds": "Leeds", "leeds united": "Leeds",
    "sunderland": "Sunderland", "leicester": "Leicester", "leicester city": "Leicester", "southampton": "Southampton", "burnley": "Burnley",
    "ipswich": "Ipswich", "ipswich town": "Ipswich", "hull": "Hull", "hull city": "Hull", "coventry": "Coventry", "coventry city": "Coventry",
}


def _euro_key(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z ]", " ", (name or "").lower().replace("&", " "))).strip()


def euro_fixtures(cache: Path, seasons: list[str], offline: bool) -> pd.DataFrame:
    """European matches of English clubs: team (FPL name), kickoff (UTC), competition. Cached for a day."""
    rows = []
    for season in seasons:
        year = int(season[:4])
        for comp, short in EURO_COMPS.items():
            f = cache / f"euro_{comp}_{year}.json"
            fresh = f.exists() and (season != CURRENT_SEASON or time.time() - f.stat().st_mtime < 86400)
            data = None
            if offline or fresh:
                data = json.loads(f.read_text()) if f.exists() else None
            else:
                try:
                    data = json.loads(_get(EURO_FEED.format(comp=comp, year=year)))
                    cache.mkdir(parents=True, exist_ok=True)
                    f.write_text(json.dumps(data))
                except (urllib.error.URLError, ValueError, OSError) as e:
                    print(f"European fixtures {comp} {year} not read ({e})")
                    data = json.loads(f.read_text()) if f.exists() else None
            for m in data or []:
                for side in ("HomeTeam", "AwayTeam"):
                    team = EURO_ALIASES.get(_euro_key(m.get(side)))
                    if team and m.get("DateUtc"):
                        rows.append({"team": team, "euro_time": pd.Timestamp(m["DateUtc"].replace("Z", "+00:00")), "comp": short, "season": season})
    out = pd.DataFrame(rows, columns=["team", "euro_time", "comp", "season"]).drop_duplicates(["team", "euro_time"])
    if len(out):
        out["euro_time"] = pd.to_datetime(out["euro_time"], utc=True)
    return out


def euro_flags(df: pd.DataFrame, euro: pd.DataFrame) -> pd.DataFrame:
    """For each league match: days since the team's last European match ("euro_gap", NaN if none within EURO_DAYS),
    and which competition."""
    out = pd.DataFrame(index=df.index, data={"euro_gap": np.nan, "euro_comp": ""})
    if euro.empty:
        return out
    kick = pd.to_datetime(df["kickoff_time"], utc=True, errors="coerce", format="ISO8601")
    for team, g in euro.groupby("team"):
        times = np.sort(g["euro_time"].values.astype("datetime64[ns]"))
        comps = g.sort_values("euro_time")["comp"].to_numpy()
        rows = df.index[(df["team"] == team).to_numpy() & kick.notna().to_numpy()]
        if not len(rows):
            continue
        k = kick.loc[rows].dt.tz_convert(None).values.astype("datetime64[ns]")
        j = np.searchsorted(times, k, side="left") - 1
        ok = j >= 0
        gap = np.full(len(rows), np.nan)
        gap[ok] = (k[ok] - times[j[ok]]) / np.timedelta64(1, "h") / 24
        hit = ok & (gap > 0) & (gap <= EURO_DAYS)
        out.loc[rows[hit], "euro_gap"] = gap[hit]
        out.loc[rows[hit], "euro_comp"] = comps[j[hit]]
    return out


def euro_rotation_rates(hist: pd.DataFrame, current: str = CURRENT_SEASON) -> tuple[dict, dict, float, pd.DataFrame]:
    """Minutes in the league match just after a European match, against the player's usual minutes that season.

    Only players who usually play (30+ minutes a match in the season, counting matches he was available for) and
    seasons when the team was in Europe. Returns player rates (pid -> (rate, matches)), team rates, the league-wide
    rate, and the per player-season table."""
    h = hist[hist["minutes"].notna()].copy()
    if "inj_skip" in h:
        h = h[~h["inj_skip"].fillna(False).astype(bool)]
    h["post"] = h["euro_gap"].notna()
    seasons_in_europe = h.groupby(["season", "team"])["post"].transform("any")
    h = h[seasons_in_europe]
    g = h.groupby(["pid", "season", "team"])
    tab = g.agg(m_all=("minutes", "mean"), n=("minutes", "size")).reset_index()
    post = h[h["post"]].groupby(["pid", "season", "team"]).agg(m_post=("minutes", "mean"), n_post=("minutes", "size")).reset_index()
    tab = tab.merge(post, on=["pid", "season", "team"], how="inner")
    tab = tab[(tab["m_all"] >= 30) & (tab["n"] >= 8)]
    if tab.empty:
        return {}, {}, 1.0, tab
    order = sorted(set(tab["season"]) | {current})
    back = {s: len(order) - 1 - order.index(s) for s in order}
    tab["w"] = tab["season"].map(lambda s: EURO_SEASON_W.get(back[s], 0.0)) * tab["n_post"]
    tab["ratio"] = tab["m_post"] / tab["m_all"]
    tab = tab[tab["w"] > 0]
    league = float((tab["ratio"] * tab["w"]).sum() / tab["w"].sum())
    teams = {}
    for team, t in tab.groupby("team"):
        w = t["w"].sum()
        teams[team] = float(((t["ratio"] * t["w"]).sum() + EURO_K_TEAM * league) / (w + EURO_K_TEAM))
    players = {}
    for pid, t in tab.groupby("pid"):
        team = t.sort_values("season")["team"].iloc[-1]
        w = t["w"].sum()
        base = teams.get(team, league)
        players[pid] = (float(((t["ratio"] * t["w"]).sum() + EURO_K_PLAYER * base) / (w + EURO_K_PLAYER)), float(t["n_post"].sum()))
    return players, teams, league, tab


def european_rotation(target: pd.DataFrame, df: pd.DataFrame, cache: Path, offline: bool) -> pd.DataFrame:
    """Flags upcoming league matches that come just after a European match (shown on the Minutes page)."""
    target = target.copy()
    seasons = sorted(set(df["season"].dropna().astype(str)) | {CURRENT_SEASON})
    try:
        euro = euro_fixtures(cache, seasons, offline)
    except Exception as e:  # never stop the site for this
        print(f"European fixtures not used ({e})")
        return target
    if euro.empty:
        print("European fixtures: none found")
        return target
    hist = df[~df["future"]].copy()
    hist = hist.join(euro_flags(hist, euro))
    players, teams, league, tab = euro_rotation_rates(hist)
    flags = euro_flags(target, euro)
    target["euro_gap"], target["euro_comp"] = flags["euro_gap"], flags["euro_comp"]
    post = target["euro_gap"].notna()
    # Shown only: measured over 2023-27, minutes in these matches were about the same as usual (x0.996), and scaling
    # them made the forecasts slightly worse (see euro-check), so xMin is not changed.
    days = target["euro_gap"].round(0).astype("Int64").astype(str)
    target["euro_note"] = np.where(post, target["euro_comp"].astype(str) + " " + days + "d", "")
    print(f"European weeks: {target.loc[post].drop_duplicates(['team', 'fixture']).shape[0]} upcoming league matches just after a European match flagged "
          f"(league-wide minutes in such matches x{league:.3f} of usual; not applied)")
    return target


def euro_check(data_dir: Path, seasons: list[str], offline: bool) -> None:
    """How much minutes drop in the league match after a European match, by season and team, and whether the rates
    from earlier seasons predict the next season's better than no change."""
    cache = data_dir / "api_cache"
    hist, fut, first = live_frames(cache, offline, 1)
    old = pd.concat([load_season(data_dir, s) for s in seasons], ignore_index=True)
    df = clean(pd.concat([old, hist, fut], ignore_index=True), seasons + [CURRENT_SEASON])
    log = json.loads(INJURY_LOG.read_text(encoding="utf-8")) if INJURY_LOG.exists() else []
    df = mark_injuries(df, log, load_admin_injuries())
    all_seasons = seasons + [CURRENT_SEASON]
    euro = euro_fixtures(cache, all_seasons, offline)
    print(f"European matches of English clubs found: {len(euro)}")
    print(euro.groupby(["season", "comp"])["team"].apply(lambda x: ", ".join(sorted(set(x)))).to_string())
    names = set()
    for fpath in cache.glob("euro_*.json"):
        for m in json.loads(fpath.read_text()):
            for side in ("HomeTeam", "AwayTeam"):
                names.add(m.get(side) or "")
    hints = ("man", "united", "utd", "city", "ham", "forest", "palace", "villa", "spurs", "tott", "brigh", "chel", "liver", "newc", "arse", "fulh", "brent", "bourn", "evert", "wolv", "leeds", "sunder", "hull", "covent", "ipsw", "leic")
    print("Feed names that look English but are not matched:", sorted(n for n in names if any(h in n.lower() for h in hints) and _euro_key(n) not in EURO_ALIASES))
    h = df[~df["future"]].copy().join(euro_flags(df[~df["future"]], euro))
    players, teams, league, tab = euro_rotation_rates(h)
    print(f"\nLeague-wide: minutes after a European match = x{league:.3f} of usual (regular players, weighted to recent seasons)")
    by = tab.groupby("season").apply(lambda t: pd.Series({"players": len(t), "post matches": t["n_post"].sum(), "ratio": (t["ratio"] * t["n_post"]).sum() / t["n_post"].sum()}))
    print(by.to_string())
    print("\nBy team and season (minutes ratio, post matches):")
    tt = tab.groupby(["team", "season"]).apply(lambda t: f'{(t["ratio"] * t["n_post"]).sum() / t["n_post"].sum():.2f} ({int(t["n_post"].max())})').unstack()
    print(tt.to_string())
    print("\nTeam rates used:", ", ".join(f"{k} {v:.2f}" for k, v in sorted(teams.items())))
    top = sorted(((v[0], v[1], p) for p, v in players.items() if v[1] >= 4))[:20]
    names_by_pid = df.drop_duplicates("pid", keep="last").set_index("pid")["name"].to_dict() if "name" in df else {}
    print("Most rested (rate, post matches):", "; ".join(f"{names_by_pid.get(p, p)} {r:.2f} ({int(n)})" for r, n, p in top))
    # Next season from earlier ones: per player-season, predicted post-European minutes = his season mean x rate.
    print("\nPredicting each season from the ones before (post-European matches of regular players):")
    hh = h[h["minutes"].notna() & ~h.get("inj_skip", pd.Series(False, index=h.index)).fillna(False).astype(bool)]
    for i, s in enumerate(all_seasons[1:], 1):
        prior = h[h["season"].isin(all_seasons[:i])]
        pl, tm, lg, _ = euro_rotation_rates(prior, current=s)
        cur = hh[hh["season"] == s]
        m_all = cur.groupby("pid")["minutes"].transform("mean")
        n_all = cur.groupby("pid")["minutes"].transform("size")
        sel = cur["euro_gap"].notna() & (m_all >= 30) & (n_all >= 8)
        c = cur[sel]
        if c.empty:
            continue
        rate = c["pid"].map(lambda p: pl.get(p, (np.nan, 0))[0]).fillna(c["team"].map(tm)).fillna(lg)
        base = m_all[sel]
        e0 = (c["minutes"] - base).abs().mean()
        e1 = (c["minutes"] - base * rate).abs().mean()
        e2 = (c["minutes"] - base * lg).abs().mean()
        print(f"  {s}: {len(c)} player matches, actual/usual {c['minutes'].sum() / base.sum():.3f}; error in minutes: no change {e0:.2f}, "
              f"league rate {e2:.2f}, player/team rate {e1:.2f}")


ADMIN_FILE = Path("admin_minutes.json")  # set on the Admin page: {"c<code>": {"min": 90, "name": "..."}}


def admin_minutes(target: pd.DataFrame, path: Path = ADMIN_FILE) -> pd.DataFrame:
    """Usual minutes set by the admin replace the formula's for every upcoming gameweek; injuries, bans and
    doubtful flags still apply on top. 1+ and 60+ minutes follow the figure: certain if he gets 1+ or 60+."""
    target = target.copy()
    target["min_model"] = usual_minutes(target)["min"]
    target["admin_min"] = np.nan
    if not path.exists():
        return target
    try:
        admin = {pid: float(v["min"]) for pid, v in json.loads(path.read_text(encoding="utf-8")).items() if v.get("min") is not None}
    except (ValueError, TypeError, AttributeError) as e:
        print(f"{path} not read ({e}); admin minutes ignored")
        return target
    rows = target["pid"].isin(list(admin))
    m = target.loc[rows, "pid"].map(admin).clip(0, 90)
    for col in ("w5_min", "ret_min"):
        target.loc[rows, col] = m
    for col in ("w5_p1", "ret_p1"):
        target.loc[rows, col] = (m > 0).astype(float)
    for col in ("w5_p60", "ret_p60"):
        target.loc[rows, col] = (m >= 60).astype(float)
    for col in ("w5_st", "ret_st", "w5_last", "ret_last"):  # admin minutes: a starter from 45, his minutes when starting are those
        target.loc[rows, col] = (m >= 45).astype(float)
    for col in ("w5_ms", "ret_ms"):
        target.loc[rows, col] = m.where(m >= 45)
    for col in ("w5_mb", "ret_mb"):
        target.loc[rows, col] = m.where(m < 45)
    target.loc[rows, "admin_min"] = m
    print(f"Admin minutes: {len(admin)} set, {target.loc[rows, 'pid'].nunique()} players found")
    return target


def predict_frame(data_dir: Path, seasons: list[str], horizon: int, offline: bool, with_history: bool = False):
    cache = data_dir / "api_cache"
    hist, fut, first = live_frames(cache, offline, horizon)
    old = pd.concat([load_season(data_dir, s) for s in seasons], ignore_index=True)
    df = yellow_bans(clean(add_core(pd.concat([old, hist, fut], ignore_index=True), data_dir, seasons + [CURRENT_SEASON]), seasons + [CURRENT_SEASON]))
    if REPLAY_GW:  # as known before that deadline: absences that had begun, returns that had happened
        log = [dict(e, returnedGw=e["returnedGw"] if (e.get("returnedGw") or 99) < first else None)
               for e in (json.loads(INJURY_LOG.read_text(encoding="utf-8")) if INJURY_LOG.exists() else [])
               if e.get("season") != CURRENT_SEASON or (e.get("startGw") or 99) < first]
    else:
        log = json.loads(INJURY_LOG.read_text(encoding="utf-8")) if offline and INJURY_LOG.exists() else ([] if offline else update_injury_log(df, first))
    hurt, covered, fm_oop = injury_subs(cache, offline, _api("bootstrap-static/", cache, offline))
    FM_PLACES.clear()
    FM_PLACES.update({k: v["last"] for k, v in fm_oop.items() if v["share"] > 0})
    FM_SHARE.clear()
    FM_SHARE.update({k: v["share"] for k, v in fm_oop.items() if v["share"] > 0})
    admin = load_admin_injuries()
    if REPLAY_GW:  # what the admin recorded about matches before that deadline
        admin = {"manual": [dict(a, endGw=min(int(a.get("endGw") or a.get("startGw") or 0), first - 1)) for a in admin["manual"] if int(a.get("startGw") or 99) < first],
                 "startOverrides": admin["startOverrides"]}
    df = mark_injuries(df, log, admin, hurt, covered)
    feat = build_features(df, fm_oop)
    model = XPointsModel().fit(feat)
    target = feat[feat["future"]].copy()
    target = doubtful_minutes(target, df)
    if not REPLAY_GW:
        target = admin_minutes(target)
        target = manual_absences(target, load_admin_injuries())
    target = goalkeeper_cover(target)
    try:
        target = european_rotation(target, df, cache, offline)
    except Exception as e:  # a display flag only: never stop the site for it
        print(f"European weeks not flagged ({e})")
    target["pen_cond"] = penalty_shares(target, pattern_history(df[df["season"].isin([CURRENT_SEASON, seasons[-1] if seasons else CURRENT_SEASON])]), fixed_order=True)
    res = pd.concat([target, model.predict(target, target["avail"].where(target["GW"] >= first))], axis=1)
    return (res, df) if with_history else res


PART_NAMES = {"pts_app": "app", "pts_goal": "goal", "pts_ast": "assist", "pts_bonus": "bonus", "pts_cs": "cs",
              "pts_conc": "conceded", "pts_save": "saves", "pts_pensave": "pensave", "pts_penmiss": "penmiss", "pts_own": "own", "pts_defcon": "defcon", "pts_card": "cards"}


def set_piece_table(res: pd.DataFrame, gw: int) -> dict:
    """Set piece takers per team for one gameweek, with each penalty taker's share of team penalties."""
    rows = res[res["GW"] == gw].sort_values("fixture").drop_duplicates(["pid"])
    num = lambda v: None if pd.isna(v) else int(v)
    teams = []
    for team, g in rows.groupby("team_short"):
        g = g.copy()
        for c in ("pen_order", "fk_order", "corner_order"):
            g[c] = pd.to_numeric(g[c], errors="coerce")
        pens = g[g["pen_order"].notna() | (g["pen_cond_used"] * g["xmin"] / 90 >= 0.0005)].sort_values(["pen_order", "xmin"], ascending=[True, False], na_position="last")
        def takers(col: str) -> list:
            t = g[g[col].notna()].sort_values(col)
            return [{"name": r["web_name"], "order": num(r[col]), "adjMin": round(float(r["xmin"]), 1)} for _, r in t.iterrows()]
        notes = sorted({str(t) for c in ("pen_text", "fk_text", "corner_text") for t in g.get(c, pd.Series(dtype=str)).dropna() if str(t).strip()})
        teams.append({
            "team": team, "name": str(g["team"].iloc[0]), "opp": [str(g["opp_short"].iloc[0]).upper() if g["was_home"].iloc[0] else str(g["opp_short"].iloc[0]).lower()],
            "penRate": round(float(g["team_pens"].iloc[0]), 3),
            "pens": [{"id": r["pid"], "name": r["web_name"], "order": num(r["pen_order"]), "adjMin": round(float(r["xmin"]), 1),
                      "share": round(float(r["pen_cond_used"] * r["xmin"] / 90), 3),
                      "xPenGoals": round(float(r["pen_cond_used"] * r["xmin"] / 90 * r["team_pens"] * (1 - r["pen_miss_rate"])), 3)} for _, r in pens.iterrows()],
            "fk": takers("fk_order"), "corners": takers("corner_order"), "notes": notes,
        })
    return {"gw": int(gw), "teams": teams}


def export_site(data_dir: Path, seasons: list[str], horizon: int, out_dir: Path, offline: bool) -> None:
    res, df = predict_frame(data_dir, seasons, horizon, offline, with_history=True)
    # FPL marks players who have left the club (or are out on loan) as unavailable: drop them from the site.
    gone = res["status"] == "u"
    left = res.loc[gone].drop_duplicates("pid")
    print(f"Removed {len(left)} unavailable players, e.g. " + ", ".join(f'{n} ({str(w)[:40]})' for n, w in zip(left["web_name"].head(8), left["news"].head(8))))
    res = res[~gone]
    # Minutes actually played in every gameweek of this season so far, one entry per match.
    played = df[(df["season"] == CURRENT_SEASON) & ~df["future"]].sort_values(["kickoff_time", "fixture"])
    past_gws = sorted(int(g) for g in played["GW"].dropna().unique() if int(g) < int(res["GW"].min()))[-PAST_GWS:]
    past = {pid: {str(int(gw)): [int(round(m)) for m in gg["minutes"].fillna(0)] for gw, gg in g.groupby("GW") if int(gw) in past_gws}
            for pid, g in played[played["GW"].isin(past_gws)].groupby("pid")}
    # Opponent of each of those matches, written like upcoming ones: capitals at home, lower case away.
    short_of = dict(zip(res["team"].astype(str), res["team_short"].astype(str)))
    short_of.update(dict(zip(res["opp"].astype(str), res["opp_short"].astype(str))) if "opp" in res else {})
    lab = lambda o, h: (short_of.get(str(o), str(o)[:3]).upper() if h else short_of.get(str(o), str(o)[:3]).lower())
    past_opp = {pid: {str(int(gw)): [lab(o, h) for o, h in zip(gg["opp"], gg["was_home"])] for gw, gg in g.groupby("GW")}
                for pid, g in played[played["GW"].isin(past_gws)].groupby("pid")}
    # Why a played-gameweek 0 was left out of the formula: "i" injury or other absence, "b" ban (yellow cards or red).
    why = pd.Series("", index=played.index)
    why[played["minutes"].fillna(0).eq(0) & played.get("inj_skip", pd.Series(False, index=played.index)).fillna(False).astype(bool)] = "i"
    why[played.get("yellow_ban", pd.Series(False, index=played.index)).fillna(False).astype(bool)] = "b"
    # "h": the match he got hurt in, before a logged injury; "m": a match in an absence the admin added by hand
    why[played.get("inj_hurt", pd.Series(False, index=played.index)).fillna(False).astype(bool)] = "h"
    why[played.get("inj_rest", pd.Series(False, index=played.index)).fillna(False).astype(bool)] = "r"
    why[played.get("gk_cover", pd.Series(False, index=played.index)).fillna(False).astype(bool)] = "g"
    why[played["minutes"].fillna(0).gt(0) & played.get("inj_skip", pd.Series(False, index=played.index)).fillna(False).astype(bool) & why.eq("")] = "m"
    # "d": flagged doubtful now, the match he got hurt in and the ones since that he missed (see doubtful_minutes)
    cut = res.drop_duplicates("pid").set_index("pid")["flag_cut"] if "flag_cut" in res else pd.Series(dtype=object)
    cut = cut[cut.notna()]
    if len(cut):
        kick = pd.to_datetime(played["kickoff_time"], utc=True, errors="coerce", format="ISO8601")
        cutt = pd.to_datetime(played["pid"].map(cut), utc=True, errors="coerce", format="ISO8601")
        cov = played.get("fm_cov", pd.Series(False, index=played.index)).fillna(False).astype(bool)
        dmask = cutt.notna() & (((kick == cutt) & ~cov & played["minutes"].fillna(0).lt(90)) | ((kick > cutt) & played["minutes"].fillna(0).eq(0))) & why.eq("")
        why[dmask] = "d"
    note = played.get("inj_note", pd.Series("", index=played.index)).fillna("").astype(str).copy()
    for _, g in played.groupby("pid"):
        left, red_gw, k = 0, None, 0
        counted = []
        for i, mins, red, gw in zip(g.index, g["minutes"].fillna(0), g["red_cards"].fillna(0), g["GW"]):
            if red > 0:
                left, red_gw, k = MAX_BAN_MATCHES, int(gw), 0
                last5 = np.array(counted[-5:][::-1], float)
                usual_now = float(np.dot(last5, MINUTE_WEIGHTS[:len(last5)]) / MINUTE_WEIGHTS[:len(last5)].sum()) if len(last5) else 0.0
                if why[i] == "" and len(last5) and mins >= usual_now:
                    counted.append(float(mins))  # sent off after his usual minutes: counted, not flagged
                elif why[i] == "":
                    why[i] = "c"  # sent off: the match itself is left out of the formula too (see ai_minutes)
                    note[i] = f"Sent off in this match: a red card after playing {int(mins)} minutes"
            elif left > 0 and mins == 0:
                k += 1
                why[i], left = "b", left - 1
                if not note[i]:
                    note[i] = f"Banned after his red card in GW{red_gw}: match {k} of the ban"
            else:
                left = 0
                if why[i] == "":
                    counted.append(float(mins))
    yb = played.get("yellow_ban", pd.Series(False, index=played.index)).fillna(False).astype(bool)
    note[yb & why.eq("b") & note.eq("")] = "Banned for reaching the yellow card limit (5 by GW19, 10 by GW32)"
    if len(cut):
        news_now = res.drop_duplicates("pid").set_index("pid")["news"] if "news" in res else pd.Series(dtype=object)
        dn = why.eq("d") & note.eq("")
        note[dn] = played.loc[dn].apply(lambda r: (f"Flagged doubtful now ({news_now.get(r['pid'], '')}): "
                                                  + (f"the match he got hurt in, played {int(r['minutes'] or 0)} minutes" if (r["minutes"] or 0) > 0
                                                     else "a match missed since he got hurt")), axis=1)
    note[why.eq("i") & note.eq("")] = "Injured or unavailable (FPL flag), 0 minutes"
    # Any other match the Usual minutes do not use, among its latest 5, in red too: a player out now has his 0s since
    # the absence began left out (the formula runs on the matches before it).
    back = res.drop_duplicates("pid").set_index("pid")["from_return"].fillna(False).astype(bool) if "from_return" in res else pd.Series(dtype=bool)
    admin_set = set(res.loc[res["admin_min"].notna(), "pid"]) if "admin_min" in res else set()
    for pid, g in played[played["minutes"].notna()].groupby("pid"):
        if pid in admin_set:
            continue
        idx = [i for i in g.index if why[i] == ""]
        if back.get(pid, False):
            while idx and float(played.at[idx[-1], "minutes"] or 0) == 0:
                i = idx.pop()
                why[i] = "x"
                note[i] = "0 minutes while he is out now: the Usual minutes use the matches before this absence"
    note[why.eq("")] = ""
    played = played.assign(why=why, why_note=note)
    past_why = {pid: {str(int(gw)): list(gg["why"]) for gw, gg in g.groupby("GW") if gg["why"].ne("").any()}
                for pid, g in played[played["GW"].isin(past_gws)].groupby("pid")}
    past_note = {pid: {str(int(gw)): list(gg["why_note"]) for gw, gg in g.groupby("GW") if gg["why"].ne("").any()}
                 for pid, g in played[played["GW"].isin(past_gws)].groupby("pid")}
    usual = usual_minutes(res)
    res = res.assign(min_usual=usual["min"])
    prof = pitch_profile(res)
    res = res.assign(pit_start=prof["start"].fillna(0), pit_last=prof["last"].fillna(0), pit_ms=prof["ms"].fillna(0), pit_mb=prof["mb"].fillna(0))
    # This season so far, for the Statistics page and the player popup
    num = lambda c: pd.to_numeric(played[c], errors="coerce").fillna(0) if c in played else pd.Series(0.0, index=played.index)
    cur = pd.DataFrame({"pid": played["pid"], "GW": played["GW"], "mins": num("minutes"), "starts": num("starts"), "xg": num("expected_goals"), "xa": num("expected_assists"),
                        "dc": num("defensive_contribution"), "goals": num("goals_scored"), "assists": num("assists"), "pts": num("total_points"),
                        "bonus": num("bonus"), "bps": num("bps"), "saves": num("saves"), "pensave": num("penalties_saved"),
                        "xgot": num("core_xgot"), "pens": num("core_pen_scored") + num("core_pen_missed"), "has_core": played.get("has_core", pd.Series(False, index=played.index)).fillna(False).astype(bool),
                        "yc": num("yellow_cards"), "rc": num("red_cards"),
                        "cs": num("clean_sheets") if "clean_sheets" in played else (num("minutes").ge(60) & num("ga").eq(0)).astype(float)})
    cur["apps"] = (cur["mins"] > 0).astype(float)
    last_gw = int(cur["GW"].max()) if len(cur) else 0
    season_stats = {}
    for pid, g in cur.groupby("pid"):
        t = g.sum(numeric_only=True)
        n90 = t["mins"] / 90
        per = lambda v: round(float(v / n90), 2) if n90 > 0 else None
        npxg = max(0.0, float(t["xg"] - NPXG_PEN * t["pens"]))  # penalties taken at Opta's 0.79 xG each
        core = bool(g["has_core"].any())
        season_stats[pid] = {"apps": int(t["apps"]), "starts": int(t["starts"]), "mins": int(t["mins"]), "goals": int(t["goals"]), "assists": int(t["assists"]),
                             "gi": int(t["goals"] + t["assists"]), "pts": int(t["pts"]), "ppm": round(float(t["pts"] / t["apps"]), 2) if t["apps"] else None,
                             "gwPts": int(g.loc[g["GW"] == last_gw, "pts"].sum()), "bonus": int(t["bonus"]), "bps": int(t["bps"]), "cs": int(t["cs"]),
                             "saves": int(t["saves"]), "pensave": int(t["pensave"]),
                             "xg": round(float(t["xg"]), 2), "xa": round(float(t["xa"]), 2), "xgi": round(float(t["xg"] + t["xa"]), 2),
                             "npxg": round(npxg, 2) if core else None, "npxgxa": round(npxg + float(t["xa"]), 2) if core else None,
                             "xgot": round(float(t["xgot"]), 2) if core else None,
                             "dc": int(t["dc"]), "xg90": per(t["xg"]), "xa90": per(t["xa"]), "xgi90": per(t["xg"] + t["xa"]),
                             "npxgxa90": per(npxg + t["xa"]) if core else None, "dc90": per(t["dc"]), "matches": int(len(g)), "lastGw": last_gw,
                             "yc": int(t["yc"]), "rc": int(t["rc"])}
    # each match of this season, for the Statistics page (gameweek range, the player's matches): SEASON_KEYS order
    opp_lab = pd.Series([lab(o, h) for o, h in zip(played["opp"], played["was_home"])], index=played.index) if "opp" in played else pd.Series("", index=played.index)
    cur["opp"] = opp_lab
    season_rows = {}
    for pid, g in cur.groupby("pid"):
        season_rows[pid] = [[int(r.GW), r.opp, int(r.mins), int(r.starts), int(r.pts), int(r.goals), int(r.assists), round(float(r.xg), 2), round(float(r.xa), 2),
                             round(float(r.xgot), 2) if r.has_core else None, int(r.pens) if r.has_core else None, int(r.dc), int(r.bonus), int(r.bps), int(r.cs),
                             int(r.saves), int(r.pensave), int(r.yc), int(r.rc)] for r in g.itertuples()]
    players: dict[str, dict] = {}
    for r in res.sort_values(["GW", "fixture"]).to_dict("records"):
        p = players.setdefault(r["pid"], {
            "id": r["pid"], "name": r["web_name"], "fullName": r["name"], "team": r["team_short"], "position": r["position"],
            "price": float(r["value"]) / 10, "status": r["status"] if isinstance(r["status"], str) else "a",
            "news": r["news"] if isinstance(r["news"], str) else "",
            "w5Min": None if pd.isna(r["w5_min"]) else round(float(r["w5_min"]), 1),
            "role": r["role"], "places": FM_PLACES.get(r["pid"]), "oopShare": FM_SHARE.get(r["pid"]), "box90": None if pd.isna(r["role_box90"]) else round(float(r["role_box90"]), 2),
            "xgi90": None if pd.isna(r["role_xgi90"]) else round(float(r["role_xgi90"]), 3),
            "minUsual": round(float(r["min_usual"]), 1),
            "minModel": round(float(r["min_model"]), 1) if "min_model" in r and pd.notna(r["min_model"]) else None,
            "adminMin": None if pd.isna(r.get("admin_min", np.nan)) else round(float(r["admin_min"])), "minNote": r["min_note"] if isinstance(r["min_note"], str) else "",
            "returnGw": None if pd.isna(r["return_gw"]) else int(r["return_gw"]), "pastMin": past.get(r["pid"], {}), "pastOpp": past_opp.get(r["pid"], {}), "pastWhy": past_why.get(r["pid"], {}), "pastNote": past_note.get(r["pid"], {}), "byGw": {},
            # penalty order and miss rate, so the site can move penalties to the next taker when minutes are edited
            "penOrder": None if pd.isna(pd.to_numeric(r.get("pen_order"), errors="coerce")) else int(pd.to_numeric(r["pen_order"], errors="coerce")),
            "fkOrder": None if pd.isna(pd.to_numeric(r.get("fk_order"), errors="coerce")) else int(pd.to_numeric(r["fk_order"], errors="coerce")),
            "cornerOrder": None if pd.isna(pd.to_numeric(r.get("corner_order"), errors="coerce")) else int(pd.to_numeric(r["corner_order"], errors="coerce")),
            "penMiss": round(float(r["pen_miss_rate"]), 4) if pd.notna(r.get("pen_miss_rate")) else None,
            # Start (5-4-3-2-1 over his last 5 matches) and his minutes when starting and not, for penalty shares
            "pitch": {"start": round(float(r["pit_start"]), 3), "last": int(r["pit_last"]), "ms": round(float(r["pit_ms"]), 1), "mb": round(float(r["pit_mb"]), 1)},
            "season": season_stats.get(r["pid"]), "seasonGw": season_rows.get(r["pid"], [])})
        g = p["byGw"].setdefault(str(int(r["GW"])), {"xpts": 0.0, "xmin": 0.0, "mins": [], "xg": 0.0, "xa": 0.0, "opp": [], "parts": {}, "full": {}, "lg": 0.0, "la": 0.0, "ly": 0.0, "lr": 0.0, "lps": 0.0, "lpm": 0.0, "log": 0.0, "xSaves": 0.0, "xConceded": 0.0, "bonus": 0.0, "xDefcon": 0.0, "xBps": 0.0, "noCs": 1.0, "noDef": 1.0, "noApp": 1.0, "no60": 1.0})
        for k in ("xpts", "xmin", "xg", "xa"):
            g[k] = round(g[k] + float(r[k]), 3)
        g["mins"].append(round(float(r["xmin"]), 1))
        # per match: fixture, his share of team penalties while on the pitch, team penalties per match
        g.setdefault("fx", []).append(int(r["fixture"]))
        g.setdefault("pc", []).append(round(float(r["pen_cond_used"]), 4))
        g.setdefault("tp", []).append(round(float(r["team_pens"]), 4))
        if isinstance(r.get("euro_note"), str) and r["euro_note"]:
            g.setdefault("euro", []).append(r["euro_note"])  # e.g. "UCL 3d": a European match 3 days before
        for name in ("goal", "assist", "bonus", "cs", "conceded", "saves", "pensave", "penmiss", "own", "defcon", "cards"):
            g["full"][name] = round(g["full"].get(name, 0.0) + float(r[f"full_{name}"]), 3)
        g["full"]["xg"] = round(g["full"].get("xg", 0.0) + float(r["g90"]), 3)
        g["full"]["xa"] = round(g["full"].get("xa", 0.0) + float(r["a90"]), 3)
        g["lg"] += float(r["g90"])
        g["la"] += float(r["a90"])
        g["ly"] += float(r["y90"])
        g["lr"] += float(r["r90"])
        g["lps"] += float(r["ps90"])
        g["lpm"] += float(r["pm90"])
        g["log"] += float(r["og90"])
        g["xSaves"] += float(r["saves90"])
        g["xConceded"] += float(r["conc90"])
        g["bonus"] += float(r["bonus90"])
        g["xDefcon"] += float(r["dc90"])
        g["xBps"] += float(r["bps90"])
        g["noCs"] *= 1 - float(r["p_cs"])
        g["noDef"] *= 1 - float(r["p_defcon"])
        g["noApp"] *= 1 - float(r["p_play"])
        g["no60"] *= 1 - float(r["p_60"])
        g["opp"].append(str(r["opp_short"]).upper() if r["was_home"] else str(r["opp_short"]).lower())
        for col, name in PART_NAMES.items():
            g["parts"][name] = round(g["parts"].get(name, 0.0) + float(r[col]), 3)
    # Chance of at least one goal/assist/clean sheet in the gameweek if he plays every minute.
    for p in players.values():
        for g in p["byGw"].values():
            g["xGoals"], g["xAssists"] = round(g["lg"], 3), round(g["la"], 3)
            g["pScore"] = round(1 - np.exp(-g.pop("lg")), 4)
            g["pAssist"] = round(1 - np.exp(-g.pop("la")), 4)
            g["pCs"] = round(1 - g.pop("noCs"), 4)
            g["pDefcon"] = round(1 - g.pop("noDef"), 4)
            g["pApp1"] = round(1 - g.pop("noApp"), 4)
            g["pApp60"] = round(1 - g.pop("no60"), 4)
            g["pYellow"] = round(1 - np.exp(-g.pop("ly")), 4)
            g["pRed"] = round(1 - np.exp(-g.pop("lr")), 5)
            g["pPenSave"] = round(1 - np.exp(-g.pop("lps")), 5)
            g["pPenMiss"] = round(1 - np.exp(-g.pop("lpm")), 5)
            g["pOwnGoal"] = round(1 - np.exp(-g.pop("log")), 5)
            g["xSaves"], g["xConceded"] = round(g["xSaves"], 3), round(g["xConceded"], 3)
            g["bonus"] = round(g["bonus"], 3)
            g["xDefcon"], g["xBps"] = round(g["xDefcon"], 2), round(g["xBps"], 1)
    payload = {"gws": sorted(int(g) for g in res["GW"].unique()), "pastGws": past_gws, "players": list(players.values()),
               "updatedAt": int(time.time() * 1000), "warnings": []}
    payload["setPieces"] = set_piece_table(res, payload["gws"][0])
    payload["setPiecesByGw"] = {str(g): set_piece_table(res, g) for g in payload["gws"]}  # every gameweek, for the GW picker
    # who started together among each club's listed penalty takers (the site moves penalties with them when minutes change)
    to_short = dict(zip(res["team"].astype(str), res["team_short"].astype(str)))
    payload["penPatterns"] = {}
    for (team, ids), pats in PEN_PATTERNS.items():
        payload["penPatterns"].setdefault(to_short.get(str(team), str(team)), []).append({"ids": list(ids), "pats": [[round(w, 4), [int(f) for f in fl]] for w, fl in pats]})
    first_rows = res[res["GW"] == payload["gws"][0]]
    payload["roleMedians"] = {pos: {"box90": round(float(first_rows[f"med_role_box90_{pos}"].iloc[0]), 2), "xgi90": round(float(first_rows[f"med_role_xgi90_{pos}"].iloc[0]), 3)}
                              for pos in ("MID", "FWD") if len(first_rows) and pd.notna(first_rows[f"med_role_box90_{pos}"].iloc[0])}
    oop = first_rows[first_rows["role"] != first_rows["position"]].drop_duplicates("pid")
    print(f"Out of position: {len(oop)} players, medians {payload['roleMedians']}")
    for _, r in oop.sort_values("role_xgi90", ascending=False).head(15).iterrows():
        print(f'  OOP {r["web_name"]} ({r["team_short"]}) {r["position"]} plays as {r["role"]}: box touches/90 {r["role_box90"]:.1f}, npxGI/90 {r["role_xgi90"]:.2f}, goals/90 {r["g90"]:.3f}')
    for t in payload["setPieces"]["teams"]:
        print(f'Set pieces {t["team"]} ({t["penRate"]:.3f} pens/match): ' + "; ".join(f'{p["order"]}.{p["name"]} {p["adjMin"]:.0f}m {p["share"]:.0%}' for p in t["pens"])
              + " | FK " + ", ".join(x["name"] for x in t["fk"][:2]) + " | corners " + ", ".join(x["name"] for x in t["corners"][:2]))
    source = Path(__file__).resolve().parent / "site"
    shutil.copytree(source, out_dir, dirs_exist_ok=True)
    # Stamp script and style links with this build, so browsers fetch the new files instead of a cached copy.
    for page in out_dir.glob("*.html"):
        page.write_text(re.sub(r'((?:src|href)="[\w.-]+\.(?:js|css))"', rf'\1?v={payload["updatedAt"]}"', page.read_text(encoding="utf-8")), encoding="utf-8")
    if INJURY_LOG.exists() or ADMIN_INJURIES.exists():
        log = json.loads(INJURY_LOG.read_text(encoding="utf-8")) if INJURY_LOG.exists() else []
        (out_dir / "injury_log.json").write_text(json.dumps(merged_injuries(log, load_admin_injuries()), ensure_ascii=False), encoding="utf-8")
    try:
        (out_dir / "fdr.json").write_text(json.dumps(fdr_table(res), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    except Exception as e:  # never stop the site for this page
        print(f"FDR not written ({e})")
    fx = None
    try:
        fx = club_fixtures(data_dir / "api_cache", offline)
        (out_dir / "fixtures.json").write_text(json.dumps(fx, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    except Exception as e:  # never stop the site for this page
        print(f"Club fixtures not written ({e})")
    if fx:
        try:  # cup and European minutes and matches, for reference on the Minutes page
            past_cup, next_cup = cup_tables(fx, cup_minutes(fx, offline), _api("bootstrap-static/", data_dir / "api_cache", offline), players)
            for pid, d in past_cup.items():
                if pid in players:
                    players[pid]["cupPast"] = {g: v for g, v in d.items() if int(g) in past_gws or int(g) == 0}
            payload["cupNext"] = {t: {g: v for g, v in d.items() if int(g) in payload["gws"]} for t, d in next_cup.items()}
        except Exception as e:
            print(f"Cup minutes not added ({e})")
        try:  # national-team matches, for reference on the Minutes page
            for pid, l in intl_tables(intl_minutes(data_dir / "api_cache", offline), players).items():
                if pid in players:
                    players[pid]["intlPast"] = l
        except Exception as e:
            print(f"International minutes not added ({e})")
    (out_dir / "data.json").write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")), encoding="utf-8")
    try:
        if REPLAY_GW:
            raise RuntimeError("replay: team news is only live")
        (out_dir / "team_news.json").write_text(json.dumps(team_news(data_dir / "api_cache", offline, players, payload["gws"][0]), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    except Exception as e:  # never stop the site for this page
        print(f"Team news not written ({e})")
    first = str(payload["gws"][0])
    top = sorted((p for p in players.values() if first in p["byGw"]), key=lambda p: -p["byGw"][first]["pScore"])[:5]
    for p in top:
        g = p["byGw"][first]
        print(f'GW{first} {p["name"]} {g["opp"]}: score {g["pScore"]:.1%}, xG {g["xGoals"]:.2f}, assist {g["pAssist"]:.1%}, xA {g["xAssists"]:.2f}, clean sheet {g["pCs"]:.1%}, DEFCON {g["pDefcon"]:.1%}, red {g["pRed"]:.2%}, yellow {g["pYellow"]:.1%}, bonus {g["bonus"]:.2f}')
        m = res[(res["pid"] == p["id"]) & (res["GW"] == int(first))].iloc[0]
        print(f'  minutes: xMin {m["xmin"]:.1f}, P(play) {m["p_play"]:.3f}, P(60+) {m["p_60"]:.3f}, last-5 {m["w5_min"]:.1f}, long-run {m["min_long"]:.1f}, '
              f'availability {m["avail"]:.2f}, status {m["status"]}, news "{m["news"]}"')
    teams = res[res["GW"] == int(first)].groupby(["team", "opp"], as_index=False)[["p_cs", "conc90"]].first().sort_values("p_cs", ascending=False)
    for _, t in teams.iterrows():
        print(f'Clean sheet GW{first}: {t["team"]} vs {t["opp"]}: {t["p_cs"]:.1%}, expected conceded {t["conc90"]:.2f}')
    hist_rows = res  # future rows carry the features built from all earlier matches
    hull = res[res["team"].astype(str).str.contains("Hull")].drop_duplicates(["GW", "fixture"]).sort_values("GW")
    for _, r in hull.iterrows():
        print(f'Hull GW{int(r["GW"])} v {r["opp_short"]} {"H" if r["was_home"] else "A"}: CS {r["p_cs"]:.1%}, conceded {r["conc90"]:.2f} | Hull def xGC ratio {r["team_def"]:.2f}, goals-conceded ratio {r["team_def_g"]:.2f} | '
              f'opp att xG ratio {r["opp_att"]:.2f}, goals ratio {r["opp_att_g"]:.2f}')
    for _, r in res[res["web_name"].astype(str).str.contains("Kinsk")].sort_values("GW").iterrows():
        print(f'Kinsky GW{int(r["GW"])} v {r["opp_short"]} {"H" if r["was_home"] else "A"}: xpts {r["xpts"]:.2f}, Adjusted Min {r["xmin"]:.0f}, xMin {r["w5_min"]:.1f}, '
              f'last matches [{r["recent_mins"]}], status {r["status"]}, CS {r["p_cs"]:.1%}, conceded {r["conc90"]:.2f}, saves90 {r["saves90"]:.2f}, '
              f'pts app {r["pts_app"]:.2f} cs {r["pts_cs"]:.2f} conc {r["pts_conc"]:.2f} saves {r["pts_save"]:.2f} bonus {r["pts_bonus"]:.2f}')
    gks = res[(res["position"] == "GK") & (res["GW"] == res["GW"].min()) & (res["xmin"] > 60)].sort_values("xpts", ascending=False)
    print("GK ranking next GW: " + "; ".join(f'{r["web_name"]} {r["xpts"]:.2f}' for _, r in gks.head(12).iterrows()))
    hs = df[df["team"].astype(str).str.contains("Hull") & ~df["future"]].drop_duplicates(["season", "fixture"])
    print(f'Hull history rows by season: {hs.groupby("season").size().to_dict()}, goals conceded {hs.groupby("season")["ga"].sum().to_dict()}')
    xgc = df[df["opp"].astype(str).str.contains("Hull") & ~df["future"]].groupby(["season", "fixture"])["expected_goals"].sum()
    print(f'Hull xG conceded by season: {xgc.groupby(level=0).sum().round(1).to_dict()}')
    for name in ("De Cuyper", "Rogers", "Haaland", "Groß"):
        rows = hist_rows[hist_rows["web_name"].astype(str).str.contains(name) & (hist_rows["GW"] == int(first))]
        for _, m in rows.head(2).iterrows():
            print(f'Finishing {m["web_name"]} v {m["opp_short"]}: weighted 90s {m["L_n90"]:.1f}, weighted goals {m["L_g"]:.1f}, weighted xG {m["L_xg"]:.2f}, '
                  f'shrunk goals/90 {m["r_g"]:.3f}, shrunk xG/90 {m["r_xg"]:.3f}, raw goals/90 {m["L_g"] / max(m["L_n90"], 1e-9):.3f}, raw xG/90 {m["L_xg"] / max(m["L_n90"], 1e-9):.3f}, '
                  f'finish {m["finish"]:.3f}, finish_goals {m["finish_goals"]:.3f}, finish_xgot {m["finish_xgot"]:.3f}, long-run npG {m["F_g"]:.1f}, npxG {m["F_xg"]:.1f}, npxGOT {m["F_xgot"]:.1f} on npxG {m["F_xgk"]:.1f}, pen share {m["pen_cond_used"]:.2f}, form {m["form_xg"]:.3f}, team att {m["team_att"]:.2f}, opp def {m["opp_def"]:.2f}, home {m["was_home"]}, '
                  f'model goals/90 {m["g90"]:.3f}, score 1+ at 90 {1 - np.exp(-m["g90"]):.1%}')
    season = df[(df["season"] == CURRENT_SEASON) & ~df["future"] & df["name"].astype(str).str.contains("Rogers")]
    for pid, g in season.groupby("pid"):
        print(f'Rogers {CURRENT_SEASON}: minutes {g["minutes"].sum():.0f}, goals {g["goals_scored"].sum():.0f}, xG {g["expected_goals"].sum():.2f}, assists {g["assists"].sum():.0f}, xA {g["expected_assists"].sum():.2f}')
    old = df[(df["season"] != CURRENT_SEASON) & ~df["future"] & df["name"].astype(str).str.contains("Rogers")]
    for (season_name, pid), g in old.groupby(["season", "pid"]):
        print(f'Rogers {season_name}: minutes {g["minutes"].sum():.0f}, goals {g["goals_scored"].sum():.0f}, xG {g["expected_goals"].sum():.2f}')
    for name in ("Osula", "Haaland", "Bruno", "Saka", "Neto"):
        rows = res[res["name"].str.contains(name) & (res["GW"] == int(first))]
        for _, m in rows.head(3).iterrows():
            print(f'AI Minute {m["web_name"]}: {m["w5_min"]:.1f}, on return {m["ret_min"]:.1f}, xMin {m["xmin"]:.1f}, last matches oldest to newest [{m["recent_mins"]}], status {m["status"]}, news "{m["news"]}", plan "{m["min_note"]}"')
    flagged = res[res["min_note"].fillna("") != ""].drop_duplicates("pid")
    print(f"Minute plans: {len(flagged)} flagged players")
    for _, m in flagged.head(40).iterrows():
        gws_min = res[res["pid"] == m["pid"]].groupby("GW")["xmin"].apply(lambda s: "+".join(f"{v:.0f}" for v in s))
        print(f'  {m["web_name"]} ({m["team_short"]}) status {m["status"]}, news "{m["news"]}" -> {m["min_note"]}; usual {m["min_usual"]:.0f}; ' + ", ".join(f"GW{g} {v}" for g, v in gws_min.items()))
    print(f"Site written to {out_dir}: {len(players)} players, GW{payload['gws'][0]}-{payload['gws'][-1]}")


def predict(data_dir: Path, seasons: list[str], horizon: int, out: Path, offline: bool) -> pd.DataFrame:
    res = predict_frame(data_dir, seasons, horizon, offline)
    keep = ["pid", "web_name", "team", "position", "value", "GW", "opp", "was_home", "status", "news", "xmin", "p_60", "xg", "xa", "xbonus", "p_cs", "xpts"]
    res = res[keep].sort_values(["GW", "xpts"], ascending=[True, False])
    res.to_csv(out, index=False)
    wide = res.pivot_table(index=["pid", "web_name", "team", "position", "value"], columns="GW", values="xpts", aggfunc="sum").fillna(0.0)
    wide[f"next_{horizon}"] = wide.sum(axis=1)
    wide = wide.reset_index().drop(columns="pid").sort_values(f"next_{horizon}", ascending=False)
    wide["value"] = wide["value"] / 10
    wide_path = out.with_name(out.stem + "_summary.csv")
    wide.round(2).to_csv(wide_path, index=False)
    print(wide.head(25).round(2).to_string(index=False))
    print(f"\nSaved: {out}\nSaved: {wide_path}")
    return wide


MARKET_CS_GW11 = {"Man City": 43, "Arsenal": 38, "Brighton": 38, "Spurs": 38, "Bournemouth": 36, "Aston Villa": 34, "Liverpool": 34, "Chelsea": 33,
                  "Brentford": 32, "Coventry City": 29, "Sunderland": 20, "Crystal Palace": 18, "Nott'm Forest": 18, "Everton": 17, "Leeds": 17,
                  "Man Utd": 17, "Newcastle": 14, "Hull City": 13, "Ipswich Town": 13, "Fulham": 10}


def rare_tune(data_dir: Path, seasons: list[str]) -> None:
    """Compares memory (half-life, match cap) and shrinkage k for rare events, on the last season's matches.

    Rate per 90 = (decayed events + k x position average) / (decayed 90s + k); the chance of 1+ in a match is
    1 - exp(-rate x minutes/90), scored by log loss against what happened."""
    df = load_history(data_dir, seasons)
    df = df[~df["future"] & df["minutes"].notna()].sort_values(["pid", "kickoff_time", "fixture"]).reset_index(drop=True)
    keys = df["pid"].to_numpy()
    n90 = (df["minutes"] / 90).to_numpy(float)
    test = ((df["season"] == seasons[-1]) & (df["minutes"] > 0)).to_numpy()

    def decayed(x: np.ndarray, hl: float, cap: int) -> np.ndarray:
        d = 0.5 ** (1 / hl)
        tail = d ** cap
        out = np.zeros(len(x))
        s, prev, hist = 0.0, object(), []
        for i, (k, v) in enumerate(zip(keys, x)):
            if k != prev:
                s, prev, hist = 0.0, k, []
            out[i] = s
            hist.append(v)
            s = s * d + v
            if len(hist) > cap:
                s -= hist[-cap - 1] * tail
        return out

    memories = [(12, 38, "half-life 12, last 38 (now)"), (24, 76, "half-life 24, last 76"), (38, 114, "half-life 38, last 114"),
                (76, 114, "half-life 76, last 114"), (1e9, 114, "equal weights, last 114")]
    ks = [5, 10, 20, 40, 60, 100, 200, 400, 1000, 2000]
    events = [("Yellow", "yellow_cards", "yc", None, 5), ("Red", "red_cards", "rc", None, 40),
              ("Own goal", "own_goals", "og", None, 60), ("Penalty save", "penalties_saved", "ps", "GK", 60)]
    print("\n=== Bonus per match with 60+ minutes, top takers by season ===")
    full = df[df["minutes"] >= 60]
    by = full.groupby(["name", "season"]).agg(bonus=("bonus", "mean"), n=("bonus", "size")).reset_index()
    stars = by[by["n"] >= 15].sort_values("bonus", ascending=False).groupby("season").head(8)
    print(stars.round(2).to_string(index=False))
    for who in ("Haaland", "Salah", "Palmer", "Bruno"):
        h = by[by["name"].str.contains(who, na=False) & (by["n"] >= 10)]
        print(who + ": " + "; ".join(f'{r.season} {r.bonus:.2f} ({r.n} matches)' for r in h.itertuples()))
    print("\n=== Goals and assists per match played, by season ===")
    pl = df[df["minutes"] > 0]
    tm = df.drop_duplicates(["season", "fixture", "team"]).groupby("season").size()
    by = pl.groupby("season").agg(goals=("goals_scored", "sum"), assists=("assists", "sum"), xg=("expected_goals", "sum"), xa=("expected_assists", "sum"), n90=("minutes", lambda m: m.sum() / 90))
    by["goals per team match"], by["assists per team match"] = by["goals"] / tm, by["assists"] / tm
    by["assists per goal"], by["goals/xG"], by["assists/xA"] = by["assists"] / by["goals"], by["goals"] / by["xg"], by["assists"] / by["xa"]
    print(by[["goals per team match", "assists per team match", "assists per goal", "goals/xG", "assists/xA"]].round(3).to_string())
    # Penalty misses per attempt (counted from 2024-25): own record pulled to the league miss rate by k attempts.
    att = (df["core_pen_scored"].fillna(0) + df["core_pen_missed"].fillna(0)).to_numpy(float)
    mis = df["core_pen_missed"].fillna(0).to_numpy(float)
    tr = (df["season"] != seasons[-1]).to_numpy()
    league = mis[tr].sum() / max(att[tr].sum(), 1)
    A, M = decayed(att, 1e9, 114), decayed(mis, 1e9, 114)
    rows = test & (att > 0)
    n_att, n_mis = att[rows], mis[rows]
    def pen_loss(rate):
        r = np.clip(rate[rows], 1e-4, 1 - 1e-4)
        return float(-(n_mis * np.log(r) + (n_att - n_mis) * np.log(1 - r)).sum() / n_att.sum())
    base = pen_loss(np.full(len(df), league))
    print(f"\n=== Penalty miss per attempt: {int(n_mis.sum())} of {int(n_att.sum())} missed in {seasons[-1]}, league {league:.1%}, league rate only: log loss {base:.5f} ===")
    print("  ".join(f"k{k} {(base - pen_loss((M + k * league) / (A + k))) / base * 100:+.2f}%" for k in [2, 5, 10, 20, 40, 80, 160]))
    for title, col, tag, only, k_now in events:
        x = df[col].fillna(0).clip(upper=3).to_numpy(float)
        rows = test & ((df["position"] == only).to_numpy() if only else True)
        train = (df["season"] != seasons[-1]).to_numpy() & ((df["position"] == only).to_numpy() if only else True)
        prior_by_pos = df[train].groupby("position").apply(lambda g: g[col].fillna(0).sum() / max((g["minutes"] / 90).sum(), 1e-9))
        prior = df["position"].map(prior_by_pos).fillna(prior_by_pos.mean()).to_numpy(float)
        hit = (x[rows] >= 1).astype(float)
        expo = n90[rows]
        def loss(rate):
            p = np.clip(1 - np.exp(-rate[rows] * expo), 1e-6, 1 - 1e-6)
            return float(-(hit * np.log(p) + (1 - hit) * np.log(1 - p)).mean())
        base = loss(prior)
        print(f"\n=== {title}: {int(hit.sum())} of {len(hit)} matches, position average only: log loss {base:.5f} ===")
        best = None
        for hl, cap, label in memories:
            ev, ninety = decayed(x, hl, cap), decayed(n90, hl, cap)
            line = []
            for k in ks:
                rate = (ev + k * prior) / (ninety + k)
                l = loss(rate)
                line.append(f"k{k} {(base - l) / base * 100:+.2f}%")
                if best is None or l < best[0]:
                    best = (l, label, k, hl, cap)
            print(f"{label:28s} " + "  ".join(line))
        l, label, k, hl, cap = best
        # how much one event moves a regular's rate: 30 full matches, none of these events, then one
        ev0 = np.zeros(30); mins = np.ones(31)
        d = 0.5 ** (1 / hl)
        w = d ** np.arange(30)[::-1]
        before = (0 + k * prior_by_pos.mean()) / (w.sum() + k)
        after = (1 + k * prior_by_pos.mean()) / (w.sum() * d + 1 + k)
        print(f"Best: {label}, k={k}: {(base - l) / base * 100:+.2f}% on position average only; one {title.lower()} moves a regular's rate x{after / before:.1f} (now: k={k_now})")


def tune(data_dir: Path, seasons: list[str], step: int, offline: bool) -> None:
    """Compares ways of rating teams, on last season's results and on this gameweek's clean sheet market."""
    global HL_TEAM, TEAM_CARRY, TEAM_WINDOW
    def log_loss(prob: pd.Series, hit: pd.Series) -> float:
        p = prob.clip(1e-5, 1 - 1e-5)
        return float(-(hit * np.log(p) + (1 - hit) * np.log(1 - p)).mean())
    configs = [("half-life 12 (now)", 12, 1.0, 0), ("half-life 5", 5, 1.0, 0), ("half-life 8", 8, 1.0, 0), ("half-life 19", 19, 1.0, 0),
               ("half-life 8, new season x0.5", 8, 0.5, 0), ("half-life 12, new season x0.5", 12, 0.5, 0), ("half-life 19, new season x0.5", 19, 0.5, 0),
               ("half-life 12, new season x0.25", 12, 0.25, 0), ("last 10 matches", 12, 1.0, 10), ("last 19 matches", 12, 1.0, 19)]
    rows = []
    for label, hl, carry, window in configs:
        HL_TEAM, TEAM_CARRY, TEAM_WINDOW = hl, carry, window
        print(f"--- {label}")
        feat = build_features(load_history(data_dir, seasons))
        pred = walk_forward(feat, seasons[-1], step)
        regular = pred[pred["min_long"] >= 45].groupby(["GW", "pid"], as_index=False)[["total_points", "xpts"]].sum()
        played = pred[pred["minutes"] > 0]
        share = played["minutes"] / 90
        fixtures = pred.dropna(subset=["ga"]).groupby(["season", "fixture", "team"], as_index=False).first()
        row = {"config": label,
               "RMSE_regulars": float(np.sqrt(((regular["total_points"] - regular["xpts"]) ** 2).mean())),
               "logloss_cs": log_loss(fixtures["p_cs"], (fixtures["ga"] == 0).astype(float)),
               "logloss_goal": log_loss(1 - np.exp(-played["g90"] * share), (played["goals_scored"] >= 1).astype(float)),
               "logloss_assist": log_loss(1 - np.exp(-played["a90"] * share), (played["assists"] >= 1).astype(float))}
        res = predict_frame(data_dir, seasons, 1, offline)
        teams = res.groupby("team", as_index=False)["p_cs"].first()
        teams = teams[teams["team"].isin(MARKET_CS_GW11)]
        if len(teams):
            market = teams["team"].map(MARKET_CS_GW11).astype(float)
            model = teams["p_cs"] * 100
            row["market_MAE"] = float((model - market).abs().mean())
            row["market_corr"] = float(model.corr(market))
            lookup = dict(zip(teams["team"], model))
            row["Liverpool_cs"] = lookup.get("Liverpool", np.nan)
            row["ManUtd_cs"] = lookup.get("Man Utd", np.nan)
            row["ManCity_cs"] = lookup.get("Man City", np.nan)
        rows.append(row)
    HL_TEAM, TEAM_CARRY, TEAM_WINDOW = 12, 1.0, 0
    print("\n=== Team rating comparison, lower logloss and market_MAE are better ===")
    print(pd.DataFrame(rows).round(4).to_string(index=False))


def cs_tune(data_dir: Path, seasons: list[str], step: int, offline: bool, modes: list[str] | None = None) -> None:
    """Compares clean sheet inputs on last season's results and on this gameweek's clean sheet market."""
    global TEAM_FEATS
    def log_loss(prob: pd.Series, hit: pd.Series) -> float:
        p = prob.clip(1e-5, 1 - 1e-5)
        return float(-(hit * np.log(p) + (1 - hit) * np.log(1 - p)).mean())
    feat = build_features(load_history(data_dir, seasons))
    rows = []
    for mode in (modes or list(CS_MODES)):
        TEAM_FEATS = TEAM_FEATS_LEARNED if CS_MODES[mode] is None else [f"cs_def_{mode}", f"cs_att_{mode}", "was_home"]
        print(f"--- {mode}")
        pred = walk_forward(feat, seasons[-1], step)
        fx = pred.dropna(subset=["ga"]).groupby(["season", "fixture", "team"], as_index=False).first()
        hit = (fx["ga"] == 0).astype(float)
        top = fx["p_cs"] >= fx["p_cs"].quantile(0.8)
        row = {"mode": mode, "logloss_cs": log_loss(fx["p_cs"], hit), "pred_cs": fx["p_cs"].mean(), "actual_cs": hit.mean(),
               "top20%_pred": fx.loc[top, "p_cs"].mean(), "top20%_actual": hit[top].mean()}
        model = XPointsModel().fit(feat[feat["season"] != seasons[-1]])
        ex = model.explain()
        row["coefs"] = ", ".join(f'{f}={c}' for f, c in zip(ex.loc[ex["target"] == "conceded", "feature"], ex.loc[ex["target"] == "conceded", "coef"]))
        res = predict_frame(data_dir, seasons, 1, offline)
        teams = res.groupby("team", as_index=False)["p_cs"].first()
        teams = teams[teams["team"].isin(MARKET_CS_GW11)]
        market = teams["team"].map(MARKET_CS_GW11).astype(float)
        model_cs = teams["p_cs"] * 100
        row["market_MAE"] = float((model_cs - market).abs().mean())
        row["market_corr"] = float(model_cs.corr(market))
        row["market_bias_top5"] = float((model_cs - market)[market.rank(ascending=False) <= 5].mean())
        lookup = dict(zip(teams["team"], model_cs.round(1)))
        row["MCI/LIV/AVL/HUL/NEW"] = "/".join(str(lookup.get(t)) for t in ("Man City", "Liverpool", "Aston Villa", "Hull City", "Newcastle"))
        rows.append(row)
    TEAM_FEATS = TEAM_FEATS_DEFAULT
    out = pd.DataFrame(rows)
    print("\n=== Clean sheet inputs, lower logloss and market_MAE are better ===")
    print(out.drop(columns="coefs").round(4).to_string(index=False))
    for _, r in out.iterrows():
        print(f'{r["mode"]}: {r["coefs"]}')


def top100_scores(gw: pd.DataFrame, col: str = "xpts") -> dict:
    """Accuracy on the 100 players with the highest predicted points each gameweek, the ones a manager looks at."""
    top = gw.sort_values(col, ascending=False).groupby("GW").head(100)
    err = top["total_points"] - top[col]
    rank = top.groupby("GW").apply(lambda g: g["total_points"].corr(g[col], method="spearman"), include_groups=False)
    return {"top100_RMSE": float(np.sqrt((err ** 2).mean())), "top100_bias": float(-err.mean()),
            "top100_pred": float(top[col].mean()), "top100_actual": float(top["total_points"].mean()),
            "top100_rank_corr": float(rank.mean())}


def goal_tune(data_dir: Path, seasons: list[str], step: int, offline: bool, modes: list[str] | None = None) -> None:
    """Compares the learned goal model with fixed goals/xG/xGOT weights on last season's results."""
    def log_loss(prob: pd.Series, hit: pd.Series) -> float:
        p = prob.clip(1e-5, 1 - 1e-5)
        return float(-(hit * np.log(p) + (1 - hit) * np.log(1 - p)).mean())
    feat = build_features(load_history(data_dir, seasons))
    learned = GLMS["goals"]
    learned_feats = ("np_goals", ["l_xg", "form_xg", "finish", "finish_goals", "finish_xgot", "l_team_att", "gap_team_att", "l_opp_def", "gap_opp_def", "was_home"] + PDUM)
    rest = ["form_xg", "l_team_att", "gap_team_att", "l_opp_def", "gap_opp_def", "was_home"] + PDUM
    rows, names = [], ["Haaland", "Rogers", "Semenyo", "Salah", "Bruno G.", "Saka", "Isak", "Palmer"]
    for mode in (modes or list(GOAL_MODES)):
        GLMS["goals"] = learned_feats if mode == "learned" else ("np_goals", [f"blend_{mode}"] + rest)
        print(f"--- {mode}")
        pred = walk_forward(feat, seasons[-1], step)
        played = pred[pred["minutes"] > 0]
        share = played["minutes"] / 90
        lam = (played["g90"] + played["pen90"] * PEN_CONVERSION) * share
        hit = (played["goals_scored"] >= 1).astype(float)
        prob = 1 - np.exp(-lam)
        top = prob >= prob.quantile(0.95)
        gw = pred.groupby(["GW", "pid"], as_index=False).agg(total_points=("total_points", "sum"), xpts=("xpts", "sum"), min_long=("min_long", "last"))
        regular = gw[gw["min_long"] >= 45]
        y = played["goals_scored"]
        dev = 2 * (np.where(y > 0, y * np.log(np.maximum(y, 1e-9) / lam.clip(lower=1e-9)), 0) - (y - lam)).mean()
        row = {"mode": mode, "logloss_score1+": log_loss(prob, hit), "goal_deviance": float(dev),
               "pred_goals": float(lam.sum()), "actual_goals": float(y.sum()),
               "top5%_pred": float(prob[top].mean()), "top5%_actual": float(hit[top].mean()),
               "RMSE_regulars": float(np.sqrt(((regular["total_points"] - regular["xpts"]) ** 2).mean())),
               "captain": float(gw.loc[gw.groupby("GW")["xpts"].idxmax(), "total_points"].mean()),
               "top10": float(gw.sort_values("xpts", ascending=False).groupby("GW").head(10)["total_points"].mean())}
        row |= top100_scores(gw)
        ex = XPointsModel().fit(feat[feat["season"] != seasons[-1]]).explain()
        g = ex[ex["target"] == "goals"]
        row["coefs"] = ", ".join(f"{f}={c}" for f, c in zip(g["feature"], g["coef"]))
        try:
            res = predict_frame(data_dir, seasons, 1, offline)
            res = res.groupby("web_name", as_index=False).agg(g90=("g90", "first"), pen90=("pen90", "first"))
            look = dict(zip(res["web_name"], 1 - np.exp(-(res["g90"] + res["pen90"] * PEN_CONVERSION))))
            row["score90"] = ", ".join(f"{n} {look[n]:.0%}" for n in names if n in look)
        except Exception as e:  # noqa: BLE001
            row["score90"] = f"(live figures not read: {e})"
        # the top 60 scorers of the test season: non-penalty goals at their real minutes, predicted against real
        tot = pred.groupby(["pid", "position"], as_index=False)["total_points"].sum()
        top = pd.concat([tot[tot["position"] == p].nlargest(n, "total_points") for p, n in CORE_GROUP.items()])["pid"]
        t = played[played["pid"].isin(top)]
        row["top60_np_goals_pred"] = float((t["g90"] - t["pen90"] * 0 + 0).mul(t["minutes"] / 90).sum() - (t["pen90"] - t["pm90"]).mul(t["minutes"] / 90).sum())
        row["top60_np_goals_real"] = float(t["np_goals"].sum()) if "np_goals" in t else float("nan")
        r = played[played["minutes"] >= 60]
        row["np_goal_MAE_60+"] = float(((r["g90"] - (r["pen90"] - r["pm90"])) * r["minutes"] / 90 - r["np_goals"]).abs().mean())
        rows.append(row)
    GLMS["goals"] = learned
    out = pd.DataFrame(rows)
    print("\n=== Chance to score: lower logloss, deviance and RMSE are better; higher captain/top10 are better ===")
    print(out.drop(columns=["coefs", "score90"]).round(4).to_string(index=False))
    for _, r in out.iterrows():
        print(f'{r["mode"]} next GW score 1+ at 90 min: {r["score90"]}')
    for _, r in out.iterrows():
        print(f'{r["mode"]} coefs: {r["coefs"]}')


def home_away(data_dir: Path, seasons: list[str]) -> None:
    """Home advantage across all listed seasons: raw rates and the effect after controlling for team strength."""
    feat = build_features(load_history(data_dir, seasons))
    feat = feat[feat["minutes"].notna()]
    fx = feat.dropna(subset=["ga"]).groupby(["season", "fixture", "team"], as_index=False).agg(
        home=("was_home", "first"), gf=("gf", "first"), ga=("ga", "first"), xg=("expected_goals", "sum"))
    fx["cs"] = (fx["ga"] == 0).astype(float)
    fx["win"] = (fx["gf"] > fx["ga"]).astype(float)
    print("=== Team per match, by season (home=1) ===")
    print(fx.groupby(["season", "home"])[["gf", "xg", "cs", "win"]].mean().round(3).to_string())
    print("\n=== Team per match, all seasons ===")
    print(fx.groupby("home")[["gf", "xg", "ga", "cs", "win"]].mean().round(3).to_string())
    played = feat[feat["minutes"] > 0]
    per90 = played.groupby("was_home")[["goals_scored", "assists", "bonus", "saves", "yellow_cards", "expected_goals", "expected_assists"]].sum().div(played.groupby("was_home")["minutes"].sum() / 90, axis=0)
    print("\n=== Player rates per 90, all seasons (was_home=1) ===")
    print(per90.round(4).to_string())
    starters = feat[feat["minutes"] >= 60]
    print("\n=== Points per match for players with 60+ minutes, by position ===")
    print(starters.groupby(["position", "was_home"])["total_points"].mean().unstack().round(2).to_string())
    model = XPointsModel().fit(feat)
    ex = model.explain()
    ex = ex[ex["feature"] == "was_home"].copy()
    ex["home_vs_away_%"] = ((np.exp(ex["coef"]) - 1) * 100).round(1)
    print("\n=== Model effect of playing at home, controlling for team and opponent strength ===")
    print(ex.drop(columns="feature").to_string(index=False))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["download", "backtest", "predict", "site", "tune", "home-away", "cs-tune", "goal-tune", "rare-tune", "euro-check"])
    ap.add_argument("--data-dir", type=Path, default=Path("fpl_data"))
    ap.add_argument("--seasons", nargs="+", default=HIST_SEASONS)
    ap.add_argument("--test-season", default=None, help="default: the last of --seasons")
    ap.add_argument("--step", type=int, default=4, help="refit every N gameweeks")
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--modes", nargs="+", default=None, help="clean sheet inputs to compare in cs-tune")
    ap.add_argument("--out", type=Path, default=Path("_site"), help="output folder for the site command")
    ap.add_argument("--as-of", type=int, default=None, help="site: rebuild as it would have been before this gameweek's deadline (replay)")
    ap.add_argument("--offline", action="store_true", help="use cached API responses only")
    a = ap.parse_args()
    if a.command == "download":
        download(a.data_dir, a.seasons)
        download_core(a.data_dir, a.seasons + [CURRENT_SEASON])
    elif a.command == "backtest":
        feat = build_features(load_history(a.data_dir, a.seasons))
        season = a.test_season or a.seasons[-1]
        pred = walk_forward(feat, season, a.step)
        report(pred, a.data_dir / f"backtest_{season}.csv")
        chance_report(pred)
        print("\n=== Coefficients, trained on seasons before the test season ===")
        print(XPointsModel().fit(feat[feat["season"] != season]).explain().to_string(index=False))
    elif a.command == "goal-tune":
        goal_tune(a.data_dir, a.seasons, a.step, a.offline, a.modes)
    elif a.command == "cs-tune":
        cs_tune(a.data_dir, a.seasons, a.step, a.offline, a.modes)
    elif a.command == "home-away":
        home_away(a.data_dir, a.seasons)
    elif a.command == "euro-check":
        euro_check(a.data_dir, a.seasons, a.offline)
    elif a.command == "rare-tune":
        rare_tune(a.data_dir, HIST_SEASONS)
    elif a.command == "tune":
        tune(a.data_dir, a.seasons, a.step, a.offline)
    elif a.command == "site":
        global REPLAY_GW
        REPLAY_GW = a.as_of
        export_site(a.data_dir, a.seasons, 12, a.out, a.offline)
    else:
        predict(a.data_dir, a.seasons, a.horizon, a.data_dir / f"xpts_next_{a.horizon}.csv", a.offline)


if __name__ == "__main__":
    main()
