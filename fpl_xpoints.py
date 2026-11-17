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
PEN_TAKE_ON_PITCH = 0.95  # chance the listed taker steps up when he is on the pitch
PEN_CONVERSION, PEN_XG = 0.78, 0.76
PEN_SAVE_SHARE = 0.12  # share of penalties saved, used until penalties are counted
SET_PIECE_COLS = {"penalties_order": "pen_order", "direct_freekicks_order": "fk_order", "corners_and_indirect_freekicks_order": "corner_order"}
HL_FINISH, K_XGOT, K_FINISH_XG = 12, 8.0, 15.0  # finishing: same half-life as the rest, shrunk by xG volume
HISTORY_MATCHES = 38  # every decayed record uses only each player's or team's latest 38 matches
PEN_XGOT_SCORED, PEN_XGOT_MISSED = 0.95, 0.3   # rough xGOT of a scored and a missed penalty
HL_ROLE, ROLE_MIN_90S = 6, 3.0  # playing role from recent matches, needs about 270 recent minutes
K_VENUE = 6.0  # home or away record of a team, shrunk toward its overall record
# goals, xG, xGOT weights, and how many average xG each player's record is padded with (smaller = closer to a plain average)
GOAL_MODES = {"learned": (None, None, None, None), "equal": (1 / 3, 1 / 3, 1 / 3, 15.0), "g50": (0.5, 0.25, 0.25, 15.0), "xg40": (0.3, 0.4, 0.3, 15.0),
              "g50_k5": (0.5, 0.25, 0.25, 5.0), "g50_k2": (0.5, 0.25, 0.25, 2.0), "equal_k5": (1 / 3, 1 / 3, 1 / 3, 5.0), "equal_k2": (1 / 3, 1 / 3, 1 / 3, 2.0)}
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
            elif ban_left > 0 and minutes == 0:
                ban_left -= 1
            else:
                ban_left = 0
                hist.append(minutes)
    return out[:, 0], out[:, 1], out[:, 2], out[:, 3], out[:, 4], out[:, 5], recent


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
    """Matches left out of the minutes formula: yellow-card bans and injury absences."""
    out = pd.Series(False, index=df.index)
    for col in ("yellow_ban", "inj_skip"):
        if col in df:
            out |= df[col].fillna(False).astype(bool)
    return out


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
OOP_LAST, OOP_NEED = 5, 3  # a defender who started in midfield or on a wing in 3 of his last 5 league starts plays as a midfielder
OOP_MID_ROLES = {"DM", "CM", "AM", "RM", "LM", "RW", "LW", "ST"}
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
                     lambda p: set(_name_key(p["web_name"]).split()) <= set(n.split()), lambda p: n.split()[-1] == _name_key(p["second_name"]).split()[-1]):
            hit = [p for p in pool if test(p)]
            if len(hit) == 1:
                return hit[0]
        return None

    store = json.loads(INJURY_SUBS.read_text(encoding="utf-8")) if INJURY_SUBS.exists() else {}
    hurt, done, missing, fetched = set(), {}, [], 0
    for m in matches:
        if not (m.get("status") or {}).get("finished"):
            continue
        rnd = int(m.get("round") or 0)
        if str(m["id"]) in store and ("starters" in store[str(m["id"])] or offline):
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
                       "starters": {"home": side("homeTeam"), "away": side("awayTeam")}}
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
        if pos_of.get(pid) == 2 and len(last) >= OOP_NEED and sum(role_base(r) in OOP_MID_ROLES for r in last) >= OOP_NEED:
            fm_oop[pid] = last
    print(f"FotMob places: {len(starts)} players; defenders starting in midfield or on a wing: {len(fm_oop)}")
    print(f"FotMob: {fetched} new matches read; {len(hurt)} players taken off injured in GW{min(covered, default=0)}-{max(covered, default=0)}"
          + (f"; not matched to FPL: {', '.join(missing[:10])}" if missing else ""))
    return hurt, covered, fm_oop


# ---------------------------------------------------------------- every club's fixtures in all competitions
# League matches come from FPL (its gameweek and kickoff); every other competition from FotMob's team pages.
CLUB_COMPS = {"Champions League": "UCL", "Europa League": "UEL", "Conference League": "UECL", "EFL Cup": "EFL",
              "FA Cup": "FAC"}


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
    missed, lineups = [], {}
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
                        "roles": {m["name"]: m.get("positionIds") or "" for g in ((d.get("squad") or {}).get("squad") or []) for m in g.get("members") or [] if m.get("name")}}
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
                                 "score": st.get("scoreStr") if st.get("finished") else None, "stage": (m.get("tournament") or {}).get("stage") or ""})
    if missed:
        print(f"Club fixtures: no cup matches for {', '.join(missed)}")
    for ms in out.values():
        ms.sort(key=lambda m: m["t"] or "9999")
    (folder / "lineups.json").write_text(json.dumps(lineups, ensure_ascii=False))
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
            if e.get("status") in ("i", "n", "s", "d") or (e.get("news") and e.get("status") == "a"):
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


def mark_injuries(df: pd.DataFrame, log: list[dict], admin: dict | None = None, hurt: set | None = None, covered: set | None = None) -> pd.DataFrame:
    """Flags matches inside each absence ("inj_skip"), so the formula leaves them out: the zero-minute ones for a
    logged absence, every match for one the admin added by hand (he may have gone off injured early), and for a
    logged injury the match just before it if he did not play all of it ("inj_hurt": he got hurt in it), and a
    cautionary rest on his return ("inj_rest": 0 in his first match back)"""
    df = df.copy()
    df["inj_skip"] = False
    df["inj_hurt"] = False
    df["inj_rest"] = False
    season = ~df["future"] & (df["season"] == CURRENT_SEASON) & df["minutes"].notna()
    for r in merged_injuries(log, admin or {"manual": [], "startOverrides": {}}):
        if r.get("season") != CURRENT_SEASON:
            continue
        end = r["endGw"] if r.get("manual") and r.get("endGw") is not None else (r["returnedGw"] - 1) if r.get("returnedGw") else 99
        rows = season & (df["pid"] == r["pid"]) & df["GW"].between(r["startGw"], end)
        df.loc[rows if r.get("manual") else rows & (df["minutes"] == 0), "inj_skip"] = True
        # The match he got hurt in: his last match before an injury absence, if he did not play all of it, is left out too.
        if not r.get("manual") and str(r.get("type") or "Injury").lower().startswith("injur"):
            before = df.index[season & (df["pid"] == r["pid"]) & (df["GW"] < r["startGw"])]
            if len(before):
                last = df.loc[before].sort_values(["GW", "kickoff_time"]).index[-1]
                # with FotMob's match events for that gameweek, only a substitution for injury counts (below)
                if int(df.at[last, "GW"]) not in (covered or set()) and 0 < float(df.at[last, "minutes"]) < 90:
                    df.at[last, "inj_skip"] = True
                    df.at[last, "inj_hurt"] = True
        # Cautionary rest: a 0 in his first match back from an injury is a rest, not a sign he lost his place
        # (one match only).
        if not r.get("manual") and str(r.get("type") or "Injury").lower().startswith("injur") and r.get("returnedGw"):
            post = df.loc[season & (df["pid"] == r["pid"]) & (df["GW"] >= r["returnedGw"])].sort_values(["GW", "kickoff_time"])
            if len(post) and float(post["minutes"].iloc[0]) == 0:
                i = post.index[0]
                df.at[i, "inj_skip"] = True
                df.at[i, "inj_rest"] = True
    # gameweeks whose matches FotMob's events cover (there, only a substitution for injury counts as getting hurt)
    df["fm_cov"] = season & df["GW"].isin(list(covered or []))
    # Taken off injured (FotMob): that match is left out, whatever came after.
    if hurt:
        keys = pd.Series(list(zip(df["pid"], df["GW"].fillna(-1).astype(int))), index=df.index)
        rows = season & keys.isin(hurt)
        df.loc[rows, "inj_skip"] = True
        df.loc[rows, "inj_hurt"] = True
    # A goalkeeper who came on for his injured team-mate: that part match says nothing of his role, left out too.
    df["gk_cover"] = False
    if "position" in df and df["inj_hurt"].any():
        gk = season & (df["position"] == "GK")
        hurt_fx = set(zip(df.loc[gk & df["inj_hurt"], "fixture"], df.loc[gk & df["inj_hurt"], "team"]))
        cover = gk & ~df["inj_hurt"] & (df["minutes"] > 0) & (df["minutes"] < 90) & pd.Series(list(zip(df["fixture"], df["team"])), index=df.index).isin(hurt_fx)
        df.loc[cover, "inj_skip"] = True
        df.loc[cover, "gk_cover"] = True
    print(f"Matches left out as injury absences: {int(df['inj_skip'].sum())}, of them matches he got hurt in: {int(df['inj_hurt'].sum())}, rests on return: {int(df['inj_rest'].sum())}")
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
    df["league_pen_miss"] = float(np.clip(df["pen_missed_k"].sum() / taken.sum(), 0.12, 0.35)) if taken.sum() > 200 else 1 - PEN_CONVERSION
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
    # Or FotMob's line-ups show him starting in midfield or on a wing in most recent league matches (current form only)
    if fm_oop:
        fut_tf = df.loc[df["future"], "tf"].max() if df["future"].any() else None
        if fut_tf is not None:
            p.loc[(p["position"] == "DEF") & p["pid"].isin(list(fm_oop)) & (p["tf"] == fut_tf), "role"] = "MID"
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
        t = t.groupby(group).cumsum().groupby(group).shift(1).fillna(0.0)
        for c in ["g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "rc", "ps", "pm", "og"]:
            t[f"p_{c}"] = (t[c] / t["n90"].replace(0, np.nan)).fillna(EPS)
        t["p_dh"] = (t["dh"] / t["do"].replace(0, np.nan)).fillna(0.0)
        t["p_dc"] = (t["dcs"] / t["dcn"].replace(0, np.nan)).fillna(DC_PRIOR_DEFAULT)
        return t[[c for c in t.columns if c.startswith("p_")]].reset_index()

    df = df.merge(p, on=["pid", "tf"], how="left")
    df["role"] = df["role"].fillna(df["position"])
    by_role = priors("role").drop(columns="p_dh").rename(columns={"role": "role"})
    by_position = priors("position")[["position", "tf", "p_dh"]]  # noqa: keep p_dc from role  # DefCon thresholds follow the FPL position
    df = df.merge(by_role, on=["role", "tf"], how="left").merge(by_position, on=["position", "tf"], how="left")

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
        df[f"is_{pos_name}"] = (df["role"] == pos_name).astype(int)  # how he plays; points still follow the FPL position
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
    for key, w5, r in (("min", "w5_min", "ret_min"), ("p1", "w5_p1", "ret_p1"), ("p60", "w5_p60", "ret_p60")):
        normal = df[w5].fillna(0.0).to_numpy(float)
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
    return yellow_bans(clean(add_core(raw, data_dir, seasons), seasons))


def walk_forward(feat: pd.DataFrame, season: str, step: int, min_train_seasons: int = 1) -> pd.DataFrame:
    test = feat[feat["season"] == season]
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
        parts.append(pd.concat([rows, model.predict(rows)], axis=1))
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


def chance_report(pred: pd.DataFrame) -> None:
    """How good each Chance 90min figure was on the test season, against what happened.

    The page shows chances for a full 90, so each is scaled to the minutes he really played. Baseline = the test
    season's own average for his position, the best you could do knowing only position (it even peeks at the
    season), so skill above 0 means the player-level figure adds something."""
    d = pred[pred["minutes"].notna()].copy()
    d["n90"] = d["minutes"] / 90
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
                     "Brier skill": np.nan if none else 1 - brier / brier0, "log-loss skill": np.nan if none else 1 - ll / ll0, "AUC": _auc(prob, hit)})
        return prob, hit

    def per90(title, rate, actual, frame, cap_one=True):
        prob = 1 - np.exp(-frame[rate].to_numpy(float) * frame["n90"].to_numpy(float))
        hit = (frame[actual].fillna(0).to_numpy(float) >= 1).astype(float)
        return binary(title, prob, hit, frame["position"])

    calib = {}
    p, h = binary("Appearance 1+", d["p_play"], d["minutes"] > 0, d["position"]); calib["Appearance 1+"] = (p, h)
    p, h = binary("Appearance 60+", d["p_60"], d["minutes"] >= 60, d["position"]); calib["Appearance 60+"] = (p, h)
    p, h = per90("Score 1+", "g90", "goals_scored", played); calib["Score 1+"] = (p, h)
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
    print("Skill: 1 - error / error of the position average (0 = no better, 1 = perfect). AUC: 0.5 = coin flip, 1 = perfect order.")
    print(t.to_string(index=False, formatters={"predicted": "{:.2%}".format, "actual": "{:.2%}".format, "Brier skill": "{:+.3f}".format,
                                                 "log-loss skill": "{:+.3f}".format, "AUC": "{:.3f}".format}))

    counts = []
    def count(title, rate, actual, frame, scale=True):
        pr = frame[rate].to_numpy(float) * (frame["n90"].to_numpy(float) if scale else 1.0)
        ac = frame[actual].fillna(0).to_numpy(float)
        base = pd.Series(ac / np.maximum(frame["n90"].to_numpy(float), 1e-9) if scale else ac).groupby(frame["position"].to_numpy()).transform("mean").to_numpy() * (frame["n90"].to_numpy(float) if scale else 1.0)
        mae, mae0 = np.mean(np.abs(pr - ac)), np.mean(np.abs(base - ac))
        corr = float(np.corrcoef(pr, ac)[0, 1]) if np.std(pr) > 0 and np.std(ac) > 0 else float("nan")
        counts.append({"figure": title, "n": len(ac), "predicted": pr.mean(), "actual": ac.mean(), "MAE": mae, "MAE skill": 1 - mae / mae0, "correlation": corr})
    count("xGoals", "g90", "goals_scored", played)
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
    tab = pg.groupby(band, observed=True).agg(n=("minutes", "size"), g_pred=("g_pred", "sum"), g_act=("goals_scored", "sum"), a_pred=("a_pred", "sum"), a_act=("assists", "sum"))
    tab["goals actual/pred"], tab["assists actual/pred"] = tab["g_act"] / tab["g_pred"], tab["a_act"] / tab["a_pred"]
    print("\n=== Goals and assists by minutes played (actual / predicted, 1.00 = right) ===")
    print(tab.round(2).to_string())

    print("\n=== Chance 90min: calibration, predicted vs actual by predicted band ===")
    for title, (p, h) in calib.items():
        bands = pd.qcut(pd.Series(p), 5, duplicates="drop")
        tab = pd.DataFrame({"p": p, "h": h}).groupby(bands, observed=True).agg(predicted=("p", "mean"), actual=("h", "mean"), n=("h", "size"))
        print(f"{title}: " + "; ".join(f"{r.predicted:.1%}->{r.actual:.1%}" for r in tab.itertuples()))


TOP_SCORERS = {"GK": 10, "DEF": 20, "MID": 20, "FWD": 10}


def report(pred: pd.DataFrame, out_csv: Path) -> pd.DataFrame:
    pred = pred.copy()
    pred["pred_pts4"] = pred["pts4"].fillna(pred["ppg_all"]).fillna(0.0)
    pred["pred_ppg"] = pred["ppg_all"].fillna(0.0)
    pred["pred_w5"] = pred["w5_min"].fillna(0.0)
    models = {"Model": "xpts", "Trailing 4 GW": "pred_pts4", "Long-run PPG": "pred_ppg"}
    agg = {c: "sum" for c in ["total_points", "minutes", "xpts", "pred_pts4", "pred_ppg", "xmin", "pred_w5"]}
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

    # The players who matter most in FPL: the top scorers of the test season (10 GK, 20 DEF, 20 MID, 10 FWD).
    tot = gw.groupby(["pid", "position"], as_index=False).agg(total=("total_points", "sum"), name=("name", "last"), team=("team", "last"))
    top = pd.concat([tot[tot["position"] == pos].nlargest(n, "total") for pos, n in TOP_SCORERS.items()])
    tg = gw[gw["pid"].isin(top["pid"])]
    print("\n=== Top FPL scorers (10 GK, 20 DEF, 20 MID, 10 FWD by points in the test season), every gameweek ===")
    rows = []
    for pos in list(TOP_SCORERS) + ["All"]:
        d = tg if pos == "All" else tg[tg["position"] == pos]
        for m, c in models.items():
            sc = _score(d["total_points"], d[c])
            rows.append({"group": pos, "way": m, "n": len(d), "MAE": sc["MAE"], "bias": float((d[c] - d["total_points"]).mean()), "Pearson": sc["Pearson"]})
    print("group | way | n | MAE | bias | Pearson")
    for r in rows:
        print(f"{r['group']} | {r['way']} | {r['n']} | {r['MAE']:.3f} | {r['bias']:+.3f} | {r['Pearson']:.3f}")
    season = tg.groupby("pid", as_index=False).agg(actual=("total_points", "sum"), predicted=("xpts", "sum"), gws=("GW", "nunique"))
    season = season.merge(top[["pid", "name", "team", "position"]], on="pid")
    season["diff"] = season["predicted"] - season["actual"]
    order = {p: i for i, p in enumerate(TOP_SCORERS)}
    season = season.sort_values(["position", "actual"], key=lambda c: c.map(order) if c.name == "position" else -c)
    print("\nTop scorers, season totals (predicted = sum of the model's points for each gameweek, made before it)")
    print("position | name | team | actual | predicted | diff | gws")
    for r in season.itertuples():
        print(f"{r.position} | {r.name} | {r.team} | {r.actual:.0f} | {r.predicted:.1f} | {r.diff:+.1f} | {r.gws}")

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
    print("\n=== Chance to score / assist: predicted vs actual (players who played) ===")
    played = pred[pred["minutes"] > 0]
    for title, rate, actual in [("Goals", "g90", "goals_scored"), ("Assists", "a90", "assists")]:
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

    FPL leaves out the year: it is the first such date on or after the day the news was written (less a week of slack)."""
    m = RETURN_DATE.search(news or "")
    if not m or m.group(2).lower() not in MONTHS:
        return None
    added = pd.Timestamp(news_added).tz_localize(None).normalize() if news_added else pd.Timestamp.now().normalize()
    for year in (added.year, added.year + 1):
        try:
            d = pd.Timestamp(year=year, month=MONTHS[m.group(2).lower()], day=int(m.group(1)))
        except ValueError:
            return None
        if d >= added - pd.Timedelta(days=7):
            return d
    return None


def minute_plan(status: str | None, news: str, news_added: str | None, chance: float | None,
                fixtures: list[tuple[int, pd.Timestamp]], first: int, red_last: bool, news_gw: int | None = None) -> tuple[list[float], bool, str, int | None]:
    """How much of his usual minutes a player is expected to play in each upcoming fixture (gameweek, kickoff in UK time).

    Returns the share per fixture, whether his minutes should come from the matches before his current absence,
    a short note, and the gameweek he is back.
    - A return date in the news (injury or ban): 0 before it, then his usual minutes from the 5-4-3-2-1 formula on
      the matches before the absence.
    - Injured or not available with no return date: 0 in every gameweek. Only FPL's own return date is used, never
      a guess at how long an injury lasts; he comes back into the numbers when FPL gives a date or clears him.
    - Suspended with no date, or a red card in his last match before FPL has flagged it: out for one match.
    - Doubtful (25/50/75%): xMin times FPL's chance in the next gameweek, full after that.
    """
    status = status or "a"
    n = len(fixtures)
    back = lambda i: (fixtures[i][0] if i < n else None)
    if status == "u":
        return [0.0] * n, False, "Unavailable", None
    when = return_date(news, news_added) if status != "a" else None
    if when is not None:
        out = [0.0 if k.normalize() < when else 1.0 for _, k in fixtures]
        i = next((j for j, v in enumerate(out) if v > 0), n)
        note = f"Back GW{back(i)} ({when:%d %b})" if i < n else f"Out until {when:%d %b}, after these gameweeks"
        return out, True, note, back(i)
    if status in ("i", "n"):
        return [0.0] * n, True, ("Injured" if status == "i" else "Unavailable") + ", no return date from FPL: 0", None
    if status == "s" or red_last:
        out = [0.0 if j == 0 else 1.0 for j in range(n)]
        why = "Suspended, no date given" if status == "s" else "Red card in his last match"
        return out, True, f"{why}: out 1 match, back GW{back(1)}" if n > 1 else f"{why}: out 1 match", back(1)
    if status == "d":
        c = 1.0 if chance is None else chance / 100
        out = [c if gw == first else 1.0 for gw, _ in fixtures]  # FPL's chance is for the next gameweek
        return out, False, f"Doubtful {round(c * 100)}% for GW{first}", None
    return [1.0] * n, False, "", None


def live_frames(cache: Path, offline: bool, horizon: int) -> tuple[pd.DataFrame, pd.DataFrame, int]:
    boot = _api("bootstrap-static/", cache, offline)
    fixtures = _api("fixtures/", cache, offline)
    teams = {t["id"]: t["name"] for t in boot["teams"]}
    short = {t["id"]: t.get("short_name", t["name"]) for t in boot["teams"]}
    pos = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
    fix = {f["id"]: f for f in fixtures}
    deadlines = {e["id"]: e.get("deadline_time") for e in boot["events"]}  # stands in for a kickoff not yet scheduled
    upcoming = [e["id"] for e in boot["events"] if e.get("is_next")] or [e["id"] for e in boot["events"] if not e.get("finished")]
    if not upcoming:
        raise SystemExit("No upcoming gameweek.")
    first = upcoming[0]
    gws = set(range(first, first + horizon))
    hist, fut = [], []

    def news_gw(added: str | None) -> int:
        """The gameweek being played when the news was written: the last one whose deadline had passed."""
        past = [g for g, d in deadlines.items() if d and added and d <= added]
        return max(past) if past else first

    for p in boot["elements"]:
        if pos.get(p["element_type"]) is None:
            continue
        name = f'{p.get("first_name", "")} {p.get("second_name", "")}'.strip() or p["web_name"]
        base = {"name": name, "position": pos[p["element_type"]], "element": p["id"], "code": p["code"], "season": CURRENT_SEASON,
                **{new: p.get(old) for old, new in SET_PIECE_COLS.items()}}
        played = []
        for row in _api(f"element-summary/{p['id']}/", cache, offline)["history"]:
            f = fix.get(row["fixture"])
            # Use every match that has been played: FPL marks a whole gameweek finished only some time later.
            if f is None or not (f.get("finished") or f.get("finished_provisional")):
                continue
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
        for f in sorted((f for f in fixtures if f.get("event") in gws and not f.get("finished") and p["team"] in (f["team_h"], f["team_a"])),
                        key=lambda f: (f["event"], f.get("kickoff_time") or "")):
            kick = pd.Timestamp(f.get("kickoff_time") or deadlines[f["event"]]).tz_convert("Europe/London").tz_localize(None)
            mine.append((f, kick))
        share, from_return, note, back_gw = minute_plan(p.get("status"), p.get("news", ""), p.get("news_added"), p.get("chance_of_playing_next_round"),
                                                       [(f["event"], k) for f, k in mine], first, red_last, news_gw(p.get("news_added")))
        for (f, _), avail in zip(mine, share):
            home = f["team_h"] == p["team"]
            team_id = p["team"]
            fut.append(base | {"GW": f["event"], "fixture": f["id"], "team": teams[team_id], "opponent_team": f["team_a"] if home else f["team_h"],
                                "was_home": home, "kickoff_time": f.get("kickoff_time"), "value": p["now_cost"], "minutes": np.nan, "future": True,
                                "avail": avail, "from_return": from_return, "min_note": note, "return_gw": back_gw, "flag_cut": flag_cut,
                                "news_added": p.get("news_added"), "chance": p.get("chance_of_playing_next_round"), "news_gw": news_gw(p.get("news_added")),
                                "team_short": short[team_id], "opp_short": short[f["team_a"] if home else f["team_h"]], "web_name": p["web_name"], "status": p.get("status"), "news": p.get("news", ""),
                                "pen_text": p.get("penalties_text") or "", "fk_text": p.get("direct_freekicks_text") or "", "corner_text": p.get("corners_and_indirect_freekicks_text") or ""})
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


def penalty_shares(target: pd.DataFrame) -> np.ndarray:
    """Share of his team's penalties a player takes while on the pitch, per future match.

    The FPL number 1 takes them when on the pitch; each next taker gets the ones left while those above him are off."""
    out = np.zeros(len(target))
    on_pitch = pd.Series(usual_minutes(target)["min"] * target["avail"].fillna(1).to_numpy(), index=target.index).clip(0, 90) / 90
    order = pd.to_numeric(target["pen_order"], errors="coerce")
    frame = pd.DataFrame({"fixture": target["fixture"].to_numpy(), "team": target["team"].to_numpy(), "order": order.to_numpy(), "m": on_pitch.to_numpy()})
    for _, g in frame[frame["order"].notna()].groupby(["fixture", "team"]):
        left = 1.0
        for i in g.sort_values("order").index:
            out[i] = PEN_TAKE_ON_PITCH * left
            left *= 1 - g.at[i, "m"]
    return out


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
    target.loc[rows, "admin_min"] = m
    print(f"Admin minutes: {len(admin)} set, {target.loc[rows, 'pid'].nunique()} players found")
    return target


def predict_frame(data_dir: Path, seasons: list[str], horizon: int, offline: bool, with_history: bool = False):
    cache = data_dir / "api_cache"
    hist, fut, first = live_frames(cache, offline, horizon)
    old = pd.concat([load_season(data_dir, s) for s in seasons], ignore_index=True)
    df = yellow_bans(clean(add_core(pd.concat([old, hist, fut], ignore_index=True), data_dir, seasons + [CURRENT_SEASON]), seasons + [CURRENT_SEASON]))
    log = json.loads(INJURY_LOG.read_text(encoding="utf-8")) if offline and INJURY_LOG.exists() else ([] if offline else update_injury_log(df, first))
    hurt, covered, fm_oop = injury_subs(cache, offline, _api("bootstrap-static/", cache, offline))
    FM_PLACES.clear()
    FM_PLACES.update(fm_oop)
    df = mark_injuries(df, log, load_admin_injuries(), hurt, covered)
    feat = build_features(df, fm_oop)
    model = XPointsModel().fit(feat)
    target = feat[feat["future"]].copy()
    target = doubtful_minutes(target, df)
    target = admin_minutes(target)
    target = manual_absences(target, load_admin_injuries())
    target = goalkeeper_cover(target)
    try:
        target = european_rotation(target, df, cache, offline)
    except Exception as e:  # a display flag only: never stop the site for it
        print(f"European weeks not flagged ({e})")
    target["pen_cond"] = penalty_shares(target)
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
        pens = g[g["pen_order"].notna()].sort_values("pen_order")
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
    for _, g in played.groupby("pid"):
        left = 0
        for i, mins, red in zip(g.index, g["minutes"].fillna(0), g["red_cards"].fillna(0)):
            if red > 0:
                left = MAX_BAN_MATCHES
                if why[i] == "":
                    why[i] = "c"  # sent off: the match itself is left out of the formula too (see ai_minutes)
            elif left > 0 and mins == 0:
                why[i], left = "b", left - 1
            else:
                left = 0
    played = played.assign(why=why)
    past_why = {pid: {str(int(gw)): list(gg["why"]) for gw, gg in g.groupby("GW") if gg["why"].ne("").any()}
                for pid, g in played[played["GW"].isin(past_gws)].groupby("pid")}
    usual = usual_minutes(res)
    res = res.assign(min_usual=usual["min"])
    players: dict[str, dict] = {}
    for r in res.sort_values(["GW", "fixture"]).to_dict("records"):
        p = players.setdefault(r["pid"], {
            "id": r["pid"], "name": r["web_name"], "fullName": r["name"], "team": r["team_short"], "position": r["position"],
            "price": float(r["value"]) / 10, "status": r["status"] if isinstance(r["status"], str) else "a",
            "news": r["news"] if isinstance(r["news"], str) else "",
            "w5Min": None if pd.isna(r["w5_min"]) else round(float(r["w5_min"]), 1),
            "role": r["role"], "places": FM_PLACES.get(r["pid"]), "box90": None if pd.isna(r["role_box90"]) else round(float(r["role_box90"]), 2),
            "xgi90": None if pd.isna(r["role_xgi90"]) else round(float(r["role_xgi90"]), 3),
            "minUsual": round(float(r["min_usual"]), 1),
            "minModel": round(float(r["min_model"]), 1) if "min_model" in r and pd.notna(r["min_model"]) else None,
            "adminMin": None if pd.isna(r.get("admin_min", np.nan)) else round(float(r["admin_min"])), "minNote": r["min_note"] if isinstance(r["min_note"], str) else "",
            "returnGw": None if pd.isna(r["return_gw"]) else int(r["return_gw"]), "pastMin": past.get(r["pid"], {}), "pastOpp": past_opp.get(r["pid"], {}), "pastWhy": past_why.get(r["pid"], {}), "byGw": {},
            # penalty order and miss rate, so the site can move penalties to the next taker when minutes are edited
            "penOrder": None if pd.isna(pd.to_numeric(r.get("pen_order"), errors="coerce")) else int(pd.to_numeric(r["pen_order"], errors="coerce")),
            "penMiss": round(float(r["pen_miss_rate"]), 4) if pd.notna(r.get("pen_miss_rate")) else None})
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
    (out_dir / "data.json").write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")), encoding="utf-8")
    try:
        (out_dir / "fixtures.json").write_text(json.dumps(club_fixtures(data_dir / "api_cache", offline), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    except Exception as e:  # never stop the site for this page
        print(f"Club fixtures not written ({e})")
    try:
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
        res = predict_frame(data_dir, seasons, 1, offline)
        res = res.groupby("web_name", as_index=False).agg(g90=("g90", "first"), pen90=("pen90", "first"))
        look = dict(zip(res["web_name"], 1 - np.exp(-(res["g90"] + res["pen90"] * PEN_CONVERSION))))
        row["score90"] = ", ".join(f"{n} {look[n]:.0%}" for n in names if n in look)
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
        export_site(a.data_dir, a.seasons, 12, a.out, a.offline)
    else:
        predict(a.data_dir, a.seasons, a.horizon, a.data_dir / f"xpts_next_{a.horizon}.csv", a.offline)


if __name__ == "__main__":
    main()
