"""One-off: for each suspension FotMob listed in GW1-9, show the player's Premier League cards and minutes, to see
whether the ban came from a Premier League card the model already handles or from elsewhere."""
import json
import requests

boot = requests.get("https://fantasy.premierleague.com/api/bootstrap-static/", timeout=30).json()
by_code = {p["code"]: p for p in boot["elements"]}
admin = json.load(open("admin_injuries.json"))
for e in admin["manual"]:
    if e.get("note") != "FotMob" or e["type"] != "Suspended":
        continue
    p = by_code.get(int(e["pid"][1:]))
    h = requests.get(f"https://fantasy.premierleague.com/api/element-summary/{p['id']}/", timeout=30).json()
    games = " ".join(f'GW{g["round"]}:{g["minutes"]}' + ("R" if g["red_cards"] else "") + ("Y" if g["yellow_cards"] else "") for g in h["history"] if g["round"] <= 10)
    last = h.get("history_past", [])[-1:] or [{}]
    print(f'{e["name"]:14} {e["team"]} ban GW{e["startGw"]}-{e["endGw"]} | {games} | last season reds {last[0].get("red_cards", "-")}, yellows {last[0].get("yellow_cards", "-")}')
