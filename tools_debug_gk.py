import json, sys
from pathlib import Path
import pandas as pd
sys.argv = ["x"]
import fpl_xpoints as fx
data_dir = Path("fpl_data"); cache = data_dir / "api_cache"
hist, fut, first = fx.live_frames(cache, False, 3)
df = fx.clean(pd.concat([hist, fut], ignore_index=True), [fx.CURRENT_SEASON])
log = json.loads(fx.INJURY_LOG.read_text())
hurt, covered = fx.injury_subs(cache, False, fx._api("bootstrap-static/", cache, False))
df = fx.mark_injuries(df, log, fx.load_admin_injuries(), hurt, covered)
d = df[(df["team"] == "Chelsea") & (df["position"] == "GK")]
print(d[["web_name", "GW", "fixture", "minutes", "future", "inj_skip", "inj_hurt", "gk_cover", "status", "avail", "from_return"]].sort_values(["web_name", "GW"]).to_string())
print([h for h in hurt if h[1] in (6, 7, 8)][:40])
