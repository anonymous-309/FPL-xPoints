#!/usr/bin/env python3
"""FPL expected-points model.

    xPts = appearance + xMin/90 * (goal_rate * goal_pts + assist_rate * 3 + bonus_rate)
           + clean sheet - goals conceded + saves + DEFCON - cards

Goal/assist/bonus rates are Poisson GLMs on log-features: the player's long-run
xG/xA per 90, recent form, finishing, own team attack, opponent defence and
home/away. xMin comes from a separate classifier (0 / 1-59 / 60+ minutes).
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
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import poisson
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import PoissonRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

HIST_SEASONS = ["2023-24", "2024-25", "2025-26"]
CURRENT_SEASON = "2026-27"
RAW = "https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data"
API = "https://fantasy.premierleague.com/api"
UA = {"User-Agent": "fpl-xpoints/1.0 (personal script)"}

POSITIONS = ["GK", "DEF", "MID", "FWD"]
GOAL_PTS = {"GK": 10, "DEF": 6, "MID": 5, "FWD": 4}
CS_PTS = {"GK": 4, "DEF": 4, "MID": 1, "FWD": 0}
DEFCON_THRESHOLD = {"DEF": 10, "MID": 12, "FWD": 12}
DEFCON_PTS = 2

HL_LONG, HL_SHORT, HL_MIN_SHORT, HL_MIN_LONG, HL_TEAM = 25, 4, 2, 8, 12
K_PLAYER, K_SHORT, K_FINISH, K_TEAM, K_TEAM_GOALS = 5.0, 2.0, 15.0, 4.0, 8.0
PROMOTED_ATT, PROMOTED_DEF = 0.85, 1.15  # starting belief for newly promoted teams
LEAGUE_XG_FALLBACK = 1.35
EPS = 1e-3
BURN_IN_GWS = 6

NEEDED = ["name", "position", "team", "element", "fixture", "opponent_team", "was_home",
          "kickoff_time", "minutes", "total_points", "goals_scored", "assists", "bonus", "bps",
          "saves", "yellow_cards", "red_cards", "expected_goals", "expected_assists",
          "team_h_score", "team_a_score", "value"]
NUMERIC = ["element", "fixture", "minutes", "total_points", "goals_scored", "assists", "bonus",
           "bps", "saves", "yellow_cards", "red_cards", "expected_goals", "expected_assists",
           "team_h_score", "team_a_score", "value", "starts", "defensive_contribution", "xP"]


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
        ids = _read_csv(raw)[["id", "code"]].rename(columns={"id": "element"})
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
    out = np.zeros(len(x))
    s, prev = 0.0, object()
    for i, (k, v) in enumerate(zip(keys, x)):
        if k != prev:
            s, prev = 0.0, k
        out[i] = s
        s = s * d + v
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
    sn = decayed_pre(keys, t["n"].to_numpy(float), HL_TEAM)
    t["att_ratio"] = ((decayed_pre(keys, t["xg"].to_numpy(float), HL_TEAM)
                       + K_TEAM * t["league"] * np.where(prom, PROMOTED_ATT, 1.0))
                      / (sn + K_TEAM)) / t["league"]
    t["def_ratio"] = ((decayed_pre(keys, t["xga"].to_numpy(float), HL_TEAM)
                       + K_TEAM * t["league"] * np.where(prom, PROMOTED_DEF, 1.0))
                      / (sn + K_TEAM)) / t["league"]
    t["att_g_ratio"] = ((decayed_pre(keys, t["gf"].to_numpy(float), HL_TEAM)
                         + K_TEAM_GOALS * t["league_g"] * np.where(prom, PROMOTED_ATT, 1.0))
                        / (sn + K_TEAM_GOALS)) / t["league_g"]
    t["def_g_ratio"] = ((decayed_pre(keys, t["ga"].to_numpy(float), HL_TEAM)
                         + K_TEAM_GOALS * t["league_g"] * np.where(prom, PROMOTED_DEF, 1.0))
                        / (sn + K_TEAM_GOALS)) / t["league_g"]
    return t[["team", "tf", "att_ratio", "def_ratio", "att_g_ratio", "def_g_ratio"]]


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    last_hist = df.loc[~df["future"], "t"].max()
    df["tf"] = np.where(df["future"], last_hist + 1, df["t"])  # future GWs all see the same history

    ratings = team_features(df)
    df = df.merge(ratings.rename(columns={"att_ratio": "team_att", "def_ratio": "team_def", "att_g_ratio": "team_att_g", "def_g_ratio": "team_def_g"}), on=["team", "tf"], how="left")
    df = df.merge(ratings.rename(columns={"team": "opp", "att_ratio": "opp_att", "def_ratio": "opp_def", "att_g_ratio": "opp_att_g", "def_g_ratio": "opp_def_g"}), on=["opp", "tf"], how="left")

    obs = ~df["future"]
    mins = df["minutes"].where(obs, 0).fillna(0)
    dc = df["defensive_contribution"]
    thr = df["position"].map(DEFCON_THRESHOLD)
    can_defcon = obs & dc.notna() & thr.notna() & (mins >= 60)
    if "starts" in df and df["starts"].notna().any():
        started = df["starts"].fillna((mins >= 60).astype(float))
    else:
        started = (mins >= 60).astype(float)

    roll = pd.DataFrame({
        "pid": df["pid"], "tf": df["tf"], "position": df["position"], "future": df["future"],
        "mins": mins, "n90": mins / 90, "g": df["goals_scored"], "a": df["assists"],
        "xg": df["expected_goals"], "xa": df["expected_assists"], "bon": df["bonus"], "bps": df["bps"],
        "sv": df["saves"], "yc": df["yellow_cards"], "pts": df["total_points"],
        "st": started.where(obs, 0), "n": obs.astype(float),
        "dh": (can_defcon & (dc >= thr)).astype(float), "do": can_defcon.astype(float),
    })
    stat = ["mins", "n90", "g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "pts", "st", "n", "dh", "do"]
    roll[stat] = roll[stat].where(obs, 0).fillna(0.0)
    p = roll.groupby(["pid", "tf"], as_index=False, sort=True)[stat].sum()
    keys = p["pid"].to_numpy()
    n90 = p["n90"].to_numpy(float)
    for c in ["n90", "g", "a", "xg", "xa", "bon", "bps", "sv", "yc"]:
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
    p = p.drop(columns=stat)
    p["min_short"] = p["X_ms"] / p["X_ns"].replace(0, np.nan)
    p["min_long"] = p["X_ml"] / p["X_nl"].replace(0, np.nan)
    p["start_rate"] = p["X_ss"] / p["X_ns"].replace(0, np.nan)

    pos = roll[~roll["future"]].groupby(["position", "tf"], as_index=False)[["n90", "g", "a", "xg", "xa", "bon", "bps", "sv", "yc", "dh", "do"]].sum()
    idx = pd.MultiIndex.from_product([POSITIONS, sorted(df["tf"].unique())], names=["position", "tf"])
    pos = pos.set_index(["position", "tf"]).reindex(idx, fill_value=0.0).sort_index()
    pos = pos.groupby("position").cumsum().groupby("position").shift(1).fillna(0.0)
    for c in ["g", "a", "xg", "xa", "bon", "bps", "sv", "yc"]:
        pos[f"p_{c}"] = (pos[c] / pos["n90"].replace(0, np.nan)).fillna(EPS)
    pos["p_dh"] = (pos["dh"] / pos["do"].replace(0, np.nan)).fillna(0.0)
    df = df.merge(p, on=["pid", "tf"], how="left")
    df = df.merge(pos[[c for c in pos.columns if c.startswith("p_")]].reset_index(), on=["position", "tf"], how="left")

    for c in ["g", "a", "xg", "xa", "bon", "bps", "sv", "yc"]:
        k = K_FINISH if c in ("g", "a") else K_PLAYER
        df[f"r_{c}"] = (df[f"L_{c}"] + k * df[f"p_{c}"]) / (df["L_n90"] + k)
        df[f"f_{c}"] = (df[f"S_{c}"] + K_SHORT * df[f"r_{c}"]) / (df["S_n90"] + K_SHORT)
    df["defcon_rate"] = (df["X_dh"] + K_PLAYER * df["p_dh"]) / (df["X_do"] + K_PLAYER)

    ln = lambda s: np.log(s.clip(lower=EPS))
    df["l_xg"], df["l_xa"] = ln(df["r_xg"]), ln(df["r_xa"])
    df["form_xg"], df["form_xa"] = ln(df["f_xg"]) - ln(df["r_xg"]), ln(df["f_xa"]) - ln(df["r_xa"])
    df["finish"], df["creat"] = ln(df["r_g"]) - ln(df["r_xg"]), ln(df["r_a"]) - ln(df["r_xa"])
    df["l_bon"], df["l_bps"], df["form_bps"] = ln(df["r_bon"]), ln(df["r_bps"]), ln(df["f_bps"]) - ln(df["r_bps"])
    df["l_sv"], df["l_yc"] = ln(df["r_sv"]), ln(df["r_yc"])
    for c in ["team_att", "team_def", "opp_att", "opp_def"]:
        df[f"l_{c}"] = ln(df[c].fillna(1.0))
        df[f"gap_{c}"] = ln(df[f"{c}_g"].fillna(1.0)) - df[f"l_{c}"]  # real goals relative to xG
    for pos_name in POSITIONS[1:]:
        df[f"is_{pos_name}"] = (df["position"] == pos_name).astype(int)
    df["pos_code"] = df["position"].map({p: i for i, p in enumerate(POSITIONS)})
    return df


# ---------------------------------------------------------------- model
PDUM = ["is_DEF", "is_MID", "is_FWD"]
GLMS = {
    "goals": ("goals_scored", ["l_xg", "form_xg", "finish", "l_team_att", "gap_team_att", "l_opp_def", "gap_opp_def", "was_home"] + PDUM),
    "assists": ("assists", ["l_xa", "form_xa", "creat", "l_team_att", "gap_team_att", "l_opp_def", "gap_opp_def", "was_home"] + PDUM),
    "bonus": ("bonus", ["l_bon", "l_bps", "form_bps", "l_team_att", "gap_team_att", "l_opp_def", "gap_opp_def", "l_opp_att", "gap_opp_att", "was_home"] + PDUM),
    "yellow": ("yellow_cards", ["l_yc", "was_home"] + PDUM),
}
MIN_FEATS = ["min_short", "min_long", "min_last", "start_rate", "n_hist", "pos_code", "GW", "was_home", "l_team_def"]
TEAM_FEATS = ["l_team_def", "gap_team_def", "l_opp_att", "gap_opp_att", "was_home"]
SAVE_FEATS = ["l_sv", "l_opp_att", "gap_opp_att", "l_team_def", "gap_team_def", "was_home"]


def _glm():
    return make_pipeline(StandardScaler(), PoissonRegressor(alpha=1e-4, max_iter=2000))


def _fit_rate(train: pd.DataFrame, target: str, feats: list[str]):
    d = train[train["minutes"] > 0]
    e = d["minutes"] / 90
    return _glm().fit(d[feats], (d[target].fillna(0) / e).to_numpy(), poissonregressor__sample_weight=e.to_numpy())


class XPointsModel:
    def fit(self, train: pd.DataFrame) -> "XPointsModel":
        train = train[~train["future"] & train["minutes"].notna()]
        # the first GWs of the data have no position priors or player history yet
        train = train[train["t"] >= train["t"].min() + BURN_IN_GWS]
        y = np.select([train["minutes"] <= 0, train["minutes"] < 60], [0, 1], default=2)
        self.minutes = HistGradientBoostingClassifier(max_iter=120, learning_rate=0.08, max_depth=4, random_state=7).fit(train[MIN_FEATS], y)
        t2 = train.assign(bucket=y)
        self.m_sub = t2[t2["bucket"] == 1].groupby("position")["minutes"].mean().reindex(POSITIONS).fillna(30.0)
        self.m_full = t2[t2["bucket"] == 2].groupby("position")["minutes"].mean().reindex(POSITIONS).fillna(89.0)
        self.rates = {k: _fit_rate(train, tgt, f) for k, (tgt, f) in GLMS.items()}
        gk = train[train["position"] == "GK"]
        self.saves = _fit_rate(gk, "saves", SAVE_FEATS)
        tm = train.dropna(subset=["ga"]).groupby(["season", "fixture", "team"], as_index=False).first()
        self.conceded = _glm().fit(tm[TEAM_FEATS], tm["ga"].to_numpy())
        played = train[train["minutes"] > 0]
        self.red_rate = float(played["red_cards"].fillna(0).sum() / (played["minutes"].sum() / 90))
        return self

    def predict(self, df: pd.DataFrame, availability: pd.Series | None = None) -> pd.DataFrame:
        classes = list(self.minutes.classes_)
        proba = self.minutes.predict_proba(df[MIN_FEATS])
        cols = {c: proba[:, classes.index(c)] if c in classes else np.zeros(len(df)) for c in (0, 1, 2)}
        avail = np.ones(len(df)) if availability is None else availability.fillna(1.0).to_numpy()
        p1, p2 = cols[1] * avail, cols[2] * avail
        pos = df["position"]
        xmin = p1 * pos.map(self.m_sub).to_numpy() + p2 * pos.map(self.m_full).to_numpy()
        n90 = xmin / 90
        rate90 = {k: self.rates[k].predict(df[f]) for k, (_, f) in GLMS.items()}
        lam = {k: rate90[k] * n90 for k in rate90}
        conc = self.conceded.predict(df[TEAM_FEATS])
        pcs = np.exp(-conc)
        is_gkdef = pos.isin(["GK", "DEF"]).to_numpy()

        pts_app = p1 + 2 * p2
        pts_goal = lam["goals"] * pos.map(GOAL_PTS).to_numpy()
        pts_ast = lam["assists"] * 3
        pts_cs = p2 * pcs * pos.map(CS_PTS).to_numpy()
        pts_conc = -1.0 * is_gkdef * n90 * (conc - (1 - np.exp(-2 * conc)) / 2) / 2  # E[floor(G/2)]
        pts_save = np.zeros(len(df))
        gk = (pos == "GK").to_numpy()
        if gk.any():
            mu = self.saves.predict(df.loc[gk, SAVE_FEATS])
            # E[floor(S/3)] for a full 90, scaled by expected minutes
            pts_save[gk] = sum(poisson.sf(3 * j - 1, mu) for j in range(1, 11)) * n90[gk]
        pts_def = (~gk) * p2 * df["defcon_rate"].to_numpy() * DEFCON_PTS
        pts_card = -lam["yellow"] - 3 * self.red_rate * n90
        out = pd.DataFrame({
            "xmin": xmin, "p_play": p1 + p2, "p_60": p2, "xg": lam["goals"], "xa": lam["assists"],
            "xbonus": lam["bonus"], "p_cs": pcs, "g90": rate90["goals"], "a90": rate90["assists"], "pts_app": pts_app, "pts_goal": pts_goal, "pts_ast": pts_ast,
            "pts_bonus": lam["bonus"], "pts_cs": pts_cs, "pts_conc": pts_conc, "pts_save": pts_save,
            "pts_defcon": pts_def, "pts_card": pts_card,
        }, index=df.index)
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
    return clean(pd.concat([load_season(data_dir, s) for s in seasons], ignore_index=True), seasons)


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
    models = {"Model": "xpts", "Trailing 4 GW": "pred_pts4", "Long-run PPG": "pred_ppg"}
    if pred["xP"].notna().any():
        models["FPL xP (may leak)"] = "xP"
    agg = {c: "sum" for c in ["total_points", "minutes", "xpts", "pred_pts4", "pred_ppg", "xmin"]}
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


def live_frames(cache: Path, offline: bool, horizon: int) -> tuple[pd.DataFrame, pd.DataFrame, int]:
    boot = _api("bootstrap-static/", cache, offline)
    fixtures = _api("fixtures/", cache, offline)
    teams = {t["id"]: t["name"] for t in boot["teams"]}
    short = {t["id"]: t.get("short_name", t["name"]) for t in boot["teams"]}
    pos = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
    fix = {f["id"]: f for f in fixtures}
    done = [e["id"] for e in boot["events"] if e.get("finished")]
    last_done = max(done) if done else 0
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
        base = {"name": name, "position": pos[p["element_type"]], "element": p["id"], "code": p["code"], "season": CURRENT_SEASON}
        for row in _api(f"element-summary/{p['id']}/", cache, offline)["history"]:
            if row["round"] > last_done or row["fixture"] not in fix:
                continue
            f = fix[row["fixture"]]
            hist.append(row | base | {"GW": row["round"], "team": teams[f["team_h"] if row["was_home"] else f["team_a"]], "opponent_team": row["opponent_team"], "future": False})
        c = p.get("chance_of_playing_next_round")
        for f in fixtures:
            if f.get("event") not in gws or f.get("finished"):
                continue
            for team_id, home in ((f["team_h"], True), (f["team_a"], False)):
                if team_id != p["team"]:
                    continue
                h = f["event"] - first
                base_c = 1.0 if c is None else c / 100
                avail = base_c + (1 - base_c) * min(1.0, h / 4)  # flags fade over the following 4 GWs
                if p.get("status") == "u":
                    avail = 0.0
                fut.append(base | {"GW": f["event"], "fixture": f["id"], "team": teams[team_id], "opponent_team": f["team_a"] if home else f["team_h"],
                                    "was_home": home, "kickoff_time": f.get("kickoff_time"), "value": p["now_cost"], "minutes": np.nan, "future": True,
                                    "avail": avail, "team_short": short[team_id], "opp_short": short[f["team_a"] if home else f["team_h"]], "web_name": p["web_name"], "status": p.get("status"), "news": p.get("news", "")})
    return pd.DataFrame(hist), pd.DataFrame(fut), first


def predict_frame(data_dir: Path, seasons: list[str], horizon: int, offline: bool) -> pd.DataFrame:
    cache = data_dir / "api_cache"
    hist, fut, first = live_frames(cache, offline, horizon)
    old = pd.concat([load_season(data_dir, s) for s in seasons], ignore_index=True)
    df = clean(pd.concat([old, hist, fut], ignore_index=True), seasons + [CURRENT_SEASON])
    feat = build_features(df)
    model = XPointsModel().fit(feat)
    target = feat[feat["future"]]
    return pd.concat([target, model.predict(target, target["avail"].where(target["GW"] >= first))], axis=1)


PART_NAMES = {"pts_app": "app", "pts_goal": "goal", "pts_ast": "assist", "pts_bonus": "bonus", "pts_cs": "cs",
              "pts_conc": "conceded", "pts_save": "saves", "pts_defcon": "defcon", "pts_card": "cards"}


def export_site(data_dir: Path, seasons: list[str], horizon: int, out_dir: Path, offline: bool) -> None:
    res = predict_frame(data_dir, seasons, horizon, offline)
    players: dict[str, dict] = {}
    for r in res.sort_values(["GW", "fixture"]).to_dict("records"):
        p = players.setdefault(r["pid"], {
            "id": r["pid"], "name": r["web_name"], "fullName": r["name"], "team": r["team_short"], "position": r["position"],
            "price": float(r["value"]) / 10, "status": r["status"] if isinstance(r["status"], str) else "a",
            "news": r["news"] if isinstance(r["news"], str) else "", "byGw": {}})
        g = p["byGw"].setdefault(str(int(r["GW"])), {"xpts": 0.0, "xmin": 0.0, "xg": 0.0, "xa": 0.0, "opp": [], "parts": {}, "lg": 0.0, "la": 0.0, "noCs": 1.0})
        for k in ("xpts", "xmin", "xg", "xa"):
            g[k] = round(g[k] + float(r[k]), 3)
        g["lg"] += float(r["g90"])
        g["la"] += float(r["a90"])
        g["noCs"] *= 1 - float(r["p_cs"])
        g["opp"].append(f'{r["opp_short"]} ({"S" if r["was_home"] else "K"})')
        for col, name in PART_NAMES.items():
            g["parts"][name] = round(g["parts"].get(name, 0.0) + float(r[col]), 3)
    # Chance of at least one goal/assist/clean sheet in the gameweek if he plays every minute.
    for p in players.values():
        for g in p["byGw"].values():
            g["pScore"] = round(1 - np.exp(-g.pop("lg")), 4)
            g["pAssist"] = round(1 - np.exp(-g.pop("la")), 4)
            g["pCs"] = round(1 - g.pop("noCs"), 4)
    payload = {"gws": sorted(int(g) for g in res["GW"].unique()), "players": list(players.values()),
               "updatedAt": int(time.time() * 1000), "warnings": []}
    source = Path(__file__).resolve().parent / "site"
    shutil.copytree(source, out_dir, dirs_exist_ok=True)
    (out_dir / "data.json").write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")), encoding="utf-8")
    first = str(payload["gws"][0])
    top = sorted((p for p in players.values() if first in p["byGw"]), key=lambda p: -p["byGw"][first]["pScore"])[:5]
    for p in top:
        g = p["byGw"][first]
        print(f'GW{first} {p["name"]} {g["opp"]}: score {g["pScore"]:.1%}, assist {g["pAssist"]:.1%}, clean sheet {g["pCs"]:.1%}')
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


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["download", "backtest", "predict", "site"])
    ap.add_argument("--data-dir", type=Path, default=Path("fpl_data"))
    ap.add_argument("--seasons", nargs="+", default=HIST_SEASONS)
    ap.add_argument("--test-season", default=None, help="default: the last of --seasons")
    ap.add_argument("--step", type=int, default=4, help="refit every N gameweeks")
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--out", type=Path, default=Path("_site"), help="output folder for the site command")
    ap.add_argument("--offline", action="store_true", help="use cached API responses only")
    a = ap.parse_args()
    if a.command == "download":
        download(a.data_dir, a.seasons)
    elif a.command == "backtest":
        feat = build_features(load_history(a.data_dir, a.seasons))
        season = a.test_season or a.seasons[-1]
        pred = walk_forward(feat, season, a.step)
        report(pred, a.data_dir / f"backtest_{season}.csv")
        print("\n=== Coefficients, trained on seasons before the test season ===")
        print(XPointsModel().fit(feat[feat["season"] != season]).explain().to_string(index=False))
    elif a.command == "site":
        export_site(a.data_dir, a.seasons, 8, a.out, a.offline)
    else:
        predict(a.data_dir, a.seasons, a.horizon, a.data_dir / f"xpts_next_{a.horizon}.csv", a.offline)


if __name__ == "__main__":
    main()
