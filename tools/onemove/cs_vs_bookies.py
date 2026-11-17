"""Our clean sheet chances for GW1-10 of this season (walk-forward, as the site would have said) against the
bookies' (checkthechance.com) and what happened."""
import re, html, urllib.request
import numpy as np, pandas as pd
import fpl_xpoints as f
from pathlib import Path

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
NAMES = {"Tottenham": "Spurs", "Coventry": "Coventry City", "Hull": "Hull City", "Ipswich": "Ipswich Town"}
book = []
for g in range(1, 11):
    h = urllib.request.urlopen(urllib.request.Request(f"https://checkthechance.com/fpl-clean-sheet-gameweek-{g}/", headers=UA), timeout=30).read().decode("utf-8", "replace")
    t = html.unescape(re.sub(r"<[^>]+>", "\n", h))
    for team, pct in re.findall(r"([A-Z][A-Za-z' .&]+?)\s*\|\s*([\d.]+)\s*%", t):
        book.append({"GW": g, "team": NAMES.get(team.strip(), team.strip()), "book": float(pct) / 100})
book = pd.DataFrame(book)
seasons = f.HIST_SEASONS + [f.CURRENT_SEASON]
feat = f.build_features(f.load_history(Path("fpl_data"), seasons))
pred = f.walk_forward(feat, f.CURRENT_SEASON, 4)
teams = pred.dropna(subset=["ga"]).groupby(["GW", "fixture", "team"], as_index=False)[["p_cs", "ga"]].first()
teams = teams[teams["GW"] <= 10]
print("our team names", sorted(teams["team"].unique()))
print("bookie names", sorted(book["team"].unique()))
m = teams.merge(book, on=["GW", "team"], how="inner")
m = m[~m.duplicated(["GW", "team"], keep=False)]  # leave out double gameweeks: the bookies give one number
hit = (m["ga"] == 0).astype(float).to_numpy()
def ll(p): p = np.clip(p, 1e-4, 1 - 1e-4); return -np.mean(hit * np.log(p) + (1 - hit) * np.log(1 - p))
def br(p): return np.mean((p - hit) ** 2)
print(f"matches {len(m)}, clean sheets {hit.mean():.3f}, ours mean {m['p_cs'].mean():.3f}, bookies mean {m['book'].mean():.3f}")
print(f"spread: ours sd {m['p_cs'].std():.3f}, bookies sd {m['book'].std():.3f}, correlation {m['p_cs'].corr(m['book']):.3f}")
for w in (0, .25, .4, .5, .6, .75, 1):
    p = w * m["p_cs"].to_numpy() + (1 - w) * m["book"].to_numpy()
    print(f"blend ours {w:.2f}: logloss {ll(p):.4f} brier {br(p):.4f} auc {f._auc(p, hit):.3f}")
for g, d in m.groupby("GW"):
    h = (d["ga"] == 0).astype(float)
    print(f"GW{g}: ours brier {np.mean((d['p_cs'] - h) ** 2):.3f} bookies {np.mean((d['book'] - h) ** 2):.3f}")
m["gap"] = m["p_cs"] - m["book"]
print(m.sort_values("gap").head(8).round(3).to_string(index=False))
print(m.sort_values("gap").tail(8).round(3).to_string(index=False))
