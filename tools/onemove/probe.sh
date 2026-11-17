#!/bin/bash
python3 - <<'PY'
import re, urllib.request, html
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
def get(u):
    try:
        return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30).read().decode("utf-8","replace")
    except Exception as e:
        return f"ERR {e}"
print("robots:", get("https://checkthechance.com/robots.txt")[:300].replace("\n"," | "))
for slug in ["fpl-clean-sheet-odds"] + [f"fpl-clean-sheet-gameweek-{g}" for g in range(1, 11)]:
    h = get(f"https://checkthechance.com/{slug}/")
    if h.startswith("ERR"): print(slug, h); continue
    t = re.sub(r"<[^>]+>", "\n", h); t = html.unescape(t)
    rows = re.findall(r"([A-Z][A-Za-z' .&]+?)\s*\|\s*([\d.]+)\s*%", t)
    upd = re.search(r"Last updated:?\s*([\d/.-]+)", t); gw = re.search(r"Gameweek\s+(\d+)", t)
    print(slug, "GW", gw.group(1) if gw else None, "updated", upd.group(1) if upd else None, len(rows), rows[:20])
PY
