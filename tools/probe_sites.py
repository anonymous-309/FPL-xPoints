import requests
lg = requests.get("https://www.fotmob.com/api/data/leagues", params={"id": 47, "ccode3": "GBR", "season": "2025/2026"}, headers={"User-Agent": "Mozilla/5.0"}, timeout=30).json()
for m in lg["fixtures"]["allMatches"]:
    print("SCORE", m.get("round"), (m.get("status") or {}).get("utcTime"), "|", m["home"]["name"], "|", (m.get("status") or {}).get("scoreStr"), "|", m["away"]["name"])
