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
from sklearn.linear_model import PoissonRegressor
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
PROMOTED_ATT, PROMOTED_DEF = 0.85, 1.15  # starting belief for newly promoted teams
LEAGUE_XG_FALLBACK = 1.35
EPS = 1e-3
TEAM_CARRY = 1.0   # share of a team's record kept when a new season starts
TEAM_WINDOW = 0    # if above 0, use only this many latest matches, equally weighted
MAX_BAN_MATCHES = 4
HIST_PEN_SHARE = {1: 0.85, 2: 0.12, 3: 0.03}  # share of team penalties by FPL order, used for past seasons
PEN_TAKE_ON_PITCH = 0.95  # chance the listed taker steps up when he is on the pitch
PEN_CONVERSION, PEN_XG = 0.78, 0.76
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
PAST_GWS = 5  # played gameweeks shown on the Minutes page
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
def decayed_pre(keys: np.ndarray, x: np.ndarray, half_life: float) -> np.ndarray:
    """Exponentially decayed sum of *earlier* rows of each key; the current row is excluded."""
    d = 0.5 ** (1 / half_life)
    tail = d ** HISTORY_MATCHES
    out = np.zeros(len(x))
    s, prev, hist = 0.0, object(), []
    for i, (k, v) in enumerate(zip(keys, x)):
        if k != prev:
            s, prev, hist = 0.0, k, []
        out[i] = s
        hist.append(v)
        s = s * d + v
        if len(hist) > HISTORY_MATCHES:
            s -= hist[-HISTORY_MATCHES - 1] * tail
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


def ai_minutes(keys: np.ndarray, mins: np.ndarray, matches: np.ndarray, reds: np.ndarray) -> tuple[np.ndarray, ...]:
    """AI Minute and the chance of 1+ and 60+ minutes before each row of each key, the same three figures for a
    player returning from an absence (ai_minute_on_return), and the latest minutes as text.

    A match with a red card and the suspension straight after it say nothing about his role, so they are left out.
    """
    out = np.full((len(mins), 6), np.nan)
    recent: list[str] = []
    hist: list[float] = []
    raw: list[float] = []
    ban_left = 0
    prev = object()
    for i, (k, v, n, r) in enumerate(zip(keys, mins, matches, reds)):
        if k != prev:
            hist, raw, ban_left, prev = [], [], 0, k
        out[i] = ai_minute_detail(hist) + ai_minute_on_return(hist)
        recent.append(",".join(str(int(round(m))) for m in raw[-8:]))
        if n > 0:
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


def build_features(df: pd.DataFrame) -> pd.DataFrame:
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
        "box": df["core_box"].fillna(0), "boxn90": (mins / 90).where(df["has_core"].fillna(False).astype(bool), 0),
        "st": started.where(obs, 0), "n": obs.astype(float),
        "dh": (can_defcon & (dc >= thr)).astype(float), "do": can_defcon.astype(float),
    })
    stat = ["mins", "n90", "g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "rc", "xgot", "xgk", "ps", "pm", "og", "pts", "box", "boxn90", "st", "n", "dh", "do"]
    roll[stat] = roll[stat].where(obs, 0).fillna(0.0)
    p = roll.groupby(["pid", "tf"], as_index=False, sort=True)[stat].sum()
    keys = p["pid"].to_numpy()
    n90 = p["n90"].to_numpy(float)
    for c in ["n90", "g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "rc", "ps", "pm", "og"]:
        p[f"L_{c}"] = decayed_pre(keys, p[c].to_numpy(float), HL_LONG)
        p[f"S_{c}"] = decayed_pre(keys, p[c].to_numpy(float), HL_SHORT)
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
    p["w5_min"], p["w5_p1"], p["w5_p60"], p["ret_min"], p["ret_p1"], p["ret_p60"], p["recent_mins"] = ai_minutes(keys, p["mins"].to_numpy(float), p["n"].to_numpy(float), p["rc"].to_numpy(float))
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
    for played in ("MID", "FWD"):
        for c in ("role_box90", "role_xgi90"):
            p[f"med_{c}_{played}"] = med.at[played, c] if played in med.index else np.nan
    p = p.drop(columns="position")
    roll = roll.merge(p[["pid", "tf", "role"]], on=["pid", "tf"], how="left")
    roll["role"] = roll["role"].fillna(roll["position"])

    def priors(group: str) -> pd.DataFrame:
        cols = ["n90", "g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "rc", "ps", "pm", "og", "dh", "do"]
        t = roll[~roll["future"]].groupby([group, "tf"], as_index=False)[cols].sum()
        idx = pd.MultiIndex.from_product([POSITIONS, sorted(df["tf"].unique())], names=[group, "tf"])
        t = t.set_index([group, "tf"]).reindex(idx, fill_value=0.0).sort_index()
        t = t.groupby(group).cumsum().groupby(group).shift(1).fillna(0.0)
        for c in ["g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "rc", "ps", "pm", "og"]:
            t[f"p_{c}"] = (t[c] / t["n90"].replace(0, np.nan)).fillna(EPS)
        t["p_dh"] = (t["dh"] / t["do"].replace(0, np.nan)).fillna(0.0)
        return t[[c for c in t.columns if c.startswith("p_")]].reset_index()

    df = df.merge(p, on=["pid", "tf"], how="left")
    df["role"] = df["role"].fillna(df["position"])
    by_role = priors("role").drop(columns="p_dh").rename(columns={"role": "role"})
    by_position = priors("position")[["position", "tf", "p_dh"]]  # DefCon thresholds follow the FPL position
    df = df.merge(by_role, on=["role", "tf"], how="left").merge(by_position, on=["position", "tf"], how="left")

    for c in ["g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "rc", "ps", "pm", "og"]:
        k = K_RED if c == "rc" else K_PEN if c in ("ps", "pm", "og") else K_FINISH if c in ("g", "a") else K_PLAYER
        df[f"r_{c}"] = (df[f"L_{c}"] + k * df[f"p_{c}"]) / (df["L_n90"] + k)
        df[f"f_{c}"] = (df[f"S_{c}"] + K_SHORT * df[f"r_{c}"]) / (df["S_n90"] + K_SHORT)
    df["defcon_rate"] = (df["X_dh"] + K_PLAYER * df["p_dh"]) / (df["X_do"] + K_PLAYER)

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
    "bonus": ("bonus", ["l_bon", "l_bps", "form_bps", "l_team_att", "gap_team_att", "l_opp_def", "gap_opp_def", "l_opp_att", "gap_opp_att", "was_home"] + PDUM),
    "yellow": ("yellow_cards", ["l_yc", "was_home"] + PDUM),
}
TEAM_FEATS_LEARNED = ["l_team_def", "gap_team_def", "l_opp_att", "gap_opp_att", "was_home"]
# Clean sheets and goals conceded: real goals weighted 70%, xG 30%, with one home/away factor for all teams.
TEAM_FEATS_DEFAULT = ["cs_def_mix70", "cs_att_mix70", "was_home"]
TEAM_FEATS = TEAM_FEATS_DEFAULT
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


class XPointsModel:
    def fit(self, train: pd.DataFrame) -> "XPointsModel":
        train = train[~train["future"] & train["minutes"].notna()]
        # the first GWs of the data have no position priors or player history yet
        train = train[train["t"] >= train["t"].min() + BURN_IN_GWS]
        self.rates = {k: _fit_rate(train, tgt, f) for k, (tgt, f) in GLMS.items()}
        gk = train[train["position"] == "GK"]
        self.saves = _fit_rate(gk, "saves", SAVE_FEATS)
        tm = train.dropna(subset=["ga"]).groupby(["season", "fixture", "team"], as_index=False).first()
        self.conceded = _glm().fit(tm[TEAM_FEATS], tm["ga"].to_numpy())
        return self

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
        rate90["goals"] = rate90["goals"] + pen90 * PEN_CONVERSION
        lam = {k: rate90[k] * n90 for k in rate90}
        red90 = df["r_rc"].to_numpy(float)
        conc = self.conceded.predict(df[TEAM_FEATS])
        pcs = np.exp(-conc)
        is_gkdef = pos.isin(["GK", "DEF"]).to_numpy()

        pts_app = p_play + p_60  # FPL: 1 point for 1+ minutes, another for 60+
        pts_goal = lam["goals"] * pos.map(GOAL_PTS).to_numpy()
        pts_ast = lam["assists"] * 3
        pts_cs = n90 * pcs * pos.map(CS_PTS).to_numpy()
        full_conc = -1.0 * is_gkdef * (conc - (1 - np.exp(-2 * conc)) / 2) / 2  # E[floor(G/2)] over 90
        pts_conc = full_conc * n90
        gk = (pos == "GK").to_numpy()
        full_save = np.zeros(len(df))
        if gk.any():
            mu = self.saves.predict(df.loc[gk, SAVE_FEATS])
            full_save[gk] = sum(poisson.sf(3 * j - 1, mu) for j in range(1, 11))  # E[floor(S/3)] over 90
        pts_save = full_save * n90
        pts_def = (~gk) * n90 * df["defcon_rate"].to_numpy() * DEFCON_PTS
        saves90 = np.zeros(len(df))
        if gk.any():
            saves90[gk] = mu
        ps90 = gk * df["r_ps"].to_numpy(float)
        full_pensave = ps90 * PEN_SAVE_PTS
        pts_pensave = full_pensave * n90
        pm90, og90 = pen90 * (1 - PEN_CONVERSION), df["r_og"].to_numpy(float)
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
        out["full_defcon"] = (~gk) * df["defcon_rate"].to_numpy() * DEFCON_PTS
        out["full_cards"] = -rate90["yellow"] - 3 * red90
        out["p_defcon"] = (~gk) * df["defcon_rate"].to_numpy()
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
    return clean(add_core(raw, data_dir, seasons), seasons)


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


def report(pred: pd.DataFrame, out_csv: Path) -> pd.DataFrame:
    pred = pred.copy()
    pred["pred_pts4"] = pred["pts4"].fillna(pred["ppg_all"]).fillna(0.0)
    pred["pred_ppg"] = pred["ppg_all"].fillna(0.0)
    pred["pred_w5"] = pred["w5_min"].fillna(0.0)
    models = {"Model": "xpts", "Trailing 4 GW": "pred_pts4", "Long-run PPG": "pred_ppg"}
    if pred["xP"].notna().any():
        models["FPL xP (may leak)"] = "xP"
    agg = {c: "sum" for c in ["total_points", "minutes", "xpts", "pred_pts4", "pred_ppg", "xmin", "pred_w5"]}
    if "xP" in models.get("FPL xP (may leak)", ""):
        agg["xP"] = "sum"
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
                fixtures: list[tuple[int, pd.Timestamp]], first: int, red_last: bool) -> tuple[list[float], bool, str, int | None]:
    """How much of his usual minutes a player is expected to play in each upcoming fixture (gameweek, kickoff in UK time).

    Returns the share per fixture, whether his minutes should come from the matches before his current absence,
    a short note, and the gameweek he is back.
    - A return date in the news (injury or ban): 0 before it, then his usual minutes from the 5-4-3-2-1 formula on
      the matches before the absence.
    - Injured or unavailable with no return date: 0 in every gameweek.
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
        return [0.0] * n, False, "Injured, no return date: 0", None
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
        mine = []
        for f in sorted((f for f in fixtures if f.get("event") in gws and not f.get("finished") and p["team"] in (f["team_h"], f["team_a"])),
                        key=lambda f: (f["event"], f.get("kickoff_time") or "")):
            kick = pd.Timestamp(f.get("kickoff_time") or deadlines[f["event"]]).tz_convert("Europe/London").tz_localize(None)
            mine.append((f, kick))
        share, from_return, note, back_gw = minute_plan(p.get("status"), p.get("news", ""), p.get("news_added"), p.get("chance_of_playing_next_round"),
                                                       [(f["event"], k) for f, k in mine], first, red_last)
        for (f, _), avail in zip(mine, share):
            home = f["team_h"] == p["team"]
            team_id = p["team"]
            fut.append(base | {"GW": f["event"], "fixture": f["id"], "team": teams[team_id], "opponent_team": f["team_a"] if home else f["team_h"],
                                "was_home": home, "kickoff_time": f.get("kickoff_time"), "value": p["now_cost"], "minutes": np.nan, "future": True,
                                "avail": avail, "from_return": from_return, "min_note": note, "return_gw": back_gw,
                                "team_short": short[team_id], "opp_short": short[f["team_a"] if home else f["team_h"]], "web_name": p["web_name"], "status": p.get("status"), "news": p.get("news", ""),
                                "pen_text": p.get("penalties_text") or "", "fk_text": p.get("direct_freekicks_text") or "", "corner_text": p.get("corners_and_indirect_freekicks_text") or ""})
    return pd.DataFrame(hist), pd.DataFrame(fut), first


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


def predict_frame(data_dir: Path, seasons: list[str], horizon: int, offline: bool, with_history: bool = False):
    cache = data_dir / "api_cache"
    hist, fut, first = live_frames(cache, offline, horizon)
    old = pd.concat([load_season(data_dir, s) for s in seasons], ignore_index=True)
    df = clean(add_core(pd.concat([old, hist, fut], ignore_index=True), data_dir, seasons + [CURRENT_SEASON]), seasons + [CURRENT_SEASON])
    feat = build_features(df)
    model = XPointsModel().fit(feat)
    target = feat[feat["future"]].copy()
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
            "pens": [{"name": r["web_name"], "order": num(r["pen_order"]), "adjMin": round(float(r["xmin"]), 1),
                      "share": round(float(r["pen_cond_used"] * r["xmin"] / 90), 3),
                      "xPenGoals": round(float(r["pen_cond_used"] * r["xmin"] / 90 * r["team_pens"] * PEN_CONVERSION), 3)} for _, r in pens.iterrows()],
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
    # Minutes actually played in the latest gameweeks of this season, one entry per match.
    played = df[(df["season"] == CURRENT_SEASON) & ~df["future"]].sort_values(["kickoff_time", "fixture"])
    past_gws = sorted(int(g) for g in played["GW"].dropna().unique() if int(g) < int(res["GW"].min()))[-PAST_GWS:]
    past = {pid: {str(int(gw)): [int(round(m)) for m in gg["minutes"].fillna(0)] for gw, gg in g.groupby("GW") if int(gw) in past_gws}
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
            "role": r["role"], "box90": None if pd.isna(r["role_box90"]) else round(float(r["role_box90"]), 2),
            "xgi90": None if pd.isna(r["role_xgi90"]) else round(float(r["role_xgi90"]), 3),
            "minUsual": round(float(r["min_usual"]), 1), "minNote": r["min_note"] if isinstance(r["min_note"], str) else "",
            "returnGw": None if pd.isna(r["return_gw"]) else int(r["return_gw"]), "pastMin": past.get(r["pid"], {}), "byGw": {}})
        g = p["byGw"].setdefault(str(int(r["GW"])), {"xpts": 0.0, "xmin": 0.0, "mins": [], "xg": 0.0, "xa": 0.0, "opp": [], "parts": {}, "full": {}, "lg": 0.0, "la": 0.0, "ly": 0.0, "lr": 0.0, "lps": 0.0, "lpm": 0.0, "log": 0.0, "xSaves": 0.0, "xConceded": 0.0, "bonus": 0.0, "noCs": 1.0, "noDef": 1.0, "noApp": 1.0, "no60": 1.0})
        for k in ("xpts", "xmin", "xg", "xa"):
            g[k] = round(g[k] + float(r[k]), 3)
        g["mins"].append(round(float(r["xmin"]), 1))
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
    (out_dir / "data.json").write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")), encoding="utf-8")
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
    ap.add_argument("command", choices=["download", "backtest", "predict", "site", "tune", "home-away", "cs-tune", "goal-tune"])
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
        print("\n=== Coefficients, trained on seasons before the test season ===")
        print(XPointsModel().fit(feat[feat["season"] != season]).explain().to_string(index=False))
    elif a.command == "goal-tune":
        goal_tune(a.data_dir, a.seasons, a.step, a.offline, a.modes)
    elif a.command == "cs-tune":
        cs_tune(a.data_dir, a.seasons, a.step, a.offline, a.modes)
    elif a.command == "home-away":
        home_away(a.data_dir, a.seasons)
    elif a.command == "tune":
        tune(a.data_dir, a.seasons, a.step, a.offline)
    elif a.command == "site":
        export_site(a.data_dir, a.seasons, 8, a.out, a.offline)
    else:
        predict(a.data_dir, a.seasons, a.horizon, a.data_dir / f"xpts_next_{a.horizon}.csv", a.offline)


if __name__ == "__main__":
    main()
