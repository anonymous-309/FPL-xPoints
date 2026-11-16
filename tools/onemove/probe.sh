#!/bin/bash
for u in \
 https://fixturedownload.com/feed/json/champions-league-2024 \
 https://fixturedownload.com/feed/json/champions-league-2025 \
 https://fixturedownload.com/feed/json/champions-league-2026 \
 https://fixturedownload.com/feed/json/champions-league-2023 \
 https://fixturedownload.com/feed/json/europa-league-2024 \
 https://fixturedownload.com/feed/json/europa-league-2025 \
 https://fixturedownload.com/feed/json/conference-league-2024 \
 "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates=20241001-20241031&limit=200" \
 "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa/scoreboard?dates=20231001-20231031&limit=200" \
 "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa.conf/scoreboard?dates=20261001-20261031&limit=200" \
 "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates=20260901-20261231&limit=500" \
 https://raw.githubusercontent.com/openfootball/champions-league/master/2024-25/cl.txt ; do
  echo "== $u"; curl -sS -m 30 -w "\nHTTP %{http_code} bytes %{size_download}\n" "$u" -o /tmp/p.out; head -c 600 /tmp/p.out; echo
done
python3 - <<'PY'
import json, urllib.request
u="https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates=20260901-20261231&limit=500"
d=json.load(urllib.request.urlopen(u))
ev=d.get("events",[])
print("ESPN UCL 2026 autumn events", len(ev))
for e in ev[:5]:
    print(e["date"], e["name"], [c["team"]["displayName"] for c in e["competitions"][0]["competitors"]])
PY
