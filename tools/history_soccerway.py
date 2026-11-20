"""Injury history from Soccerway player pages (From / Until / Injury), for the players in the squads of every club
that played in the Premier League in 2024-25 or 2025-26 (squads as Soccerway lists them now).
Writes archive/injuries/soccerway_players.json.gz. One page a second; stops if a page is refused."""
import gzip, json, re, sys, time
from pathlib import Path
import requests

BASE = "https://ie.soccerway.com"
H = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Accept-Language": "en-GB,en;q=0.9"}
CLUBS = ["arsenal", "aston-villa", "bournemouth", "brentford", "brighton", "chelsea", "crystal-palace", "everton", "fulham", "ipswich",
         "leicester", "liverpool", "manchester-city", "manchester-utd", "newcastle", "nottingham", "southampton", "tottenham", "west-ham",
         "wolves", "burnley", "leeds", "sunderland"]
DATE = r"\d\d\.\d\d\.\d{4}"
S = requests.Session(); S.headers.update(H)


def get(path):
    time.sleep(1)
    r = S.get(BASE + path, timeout=30)
    if r.status_code in (403, 429) or (r.status_code == 202 and not r.text):
        sys.exit(f"refused {r.status_code} at {path}")
    return r.status_code, r.text


def text(html):
    html = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).replace("&nbsp;", " ").replace("&amp;", "&")


def injuries(html):
    t = text(html)
    m = re.search(r"Injury History From Until Injury (.*?)(?: NOTE:| Pinned Leagues)", t)
    if not m:
        return [], None
    body, rows = m.group(1), []
    for a in re.finditer(rf"({DATE}) ((?:{DATE})?)\s*(.*?)(?= {DATE}|$)", body):
        rows.append({"from": a.group(1), "until": a.group(2) or None, "injury": a.group(3).strip()})
    return rows, body


def main():
    teams = {}
    for season in ("2024-2025", "2025-2026"):
        for page in ("results/", "fixtures/", ""):
            _, t = get(f"/england/premier-league-{season}/{page}")
            for slug, tid in re.findall(r"/(?:team|match)/([a-z0-9-]+)-([A-Za-z0-9]{8})/", t) + re.findall(r"/team/([a-z0-9-]+)/([A-Za-z0-9]{8})/", t):
                if any(slug == c or slug.startswith(c) for c in CLUBS):
                    teams.setdefault(slug, tid)
    print("clubs found:", len(teams), sorted(teams))
    players = {}
    for slug, tid in sorted(teams.items()):
        code, t = get(f"/team/{slug}/{tid}/squad/")
        found = set(re.findall(r"/player/([a-z0-9-]+)/([A-Za-z0-9]{8})/", t))
        for ps, pid in found:
            players.setdefault(pid, {"slug": ps, "id": pid, "clubs": []})["clubs"].append(slug)
        print(slug, code, len(found))
    out = []
    for i, p in enumerate(players.values()):
        code, t = get(f"/player/{p['slug']}/{p['id']}/injury-history")
        nm = re.search(r"<title>([^<|]+)", t)
        rows, raw = injuries(t) if code == 200 else ([], None)
        out.append({**p, "name": nm.group(1).strip() if nm else p["slug"], "status": code, "injuries": rows, "raw": raw})
        if i % 50 == 0:
            print(i, len(players), p["slug"], len(rows))
    path = Path("archive/injuries/soccerway_players.json.gz"); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(json.dumps({"fetched": time.strftime("%Y-%m-%d"), "players": out}).encode()))
    n = sum(len(p["injuries"]) for p in out)
    print(f"saved {path}: {len(out)} players, {n} injury rows")


if __name__ == "__main__":
    main()
