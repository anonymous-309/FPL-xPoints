#!/bin/bash
python3 - <<'PY'
import json, urllib.request, urllib.parse
H={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36","Accept":"application/json","Referer":"https://www.fotmob.com/"}
def get(p,q):
    r=urllib.request.Request("https://www.fotmob.com/api/data/"+p+"?"+urllib.parse.urlencode(q),headers=H)
    return json.loads(urllib.request.urlopen(r,timeout=30).read())
t=get("teams",{"id":8455,"ccode3":"GBR"})  # Chelsea
sq=t.get("squad") or {}
print("squad keys", list(sq.keys()) if isinstance(sq,dict) else type(sq))
grp=sq.get("squad") if isinstance(sq,dict) else sq
print(json.dumps(grp[1])[:1500] if grp else None)
for g in grp or []:
    for m in g.get("members",[]):
        print(g.get("title"), m.get("name"), m.get("positionIds"), m.get("positionIdsDesc"), m.get("role"))
fx=[m for m in t["fixtures"]["allFixtures"]["fixtures"] if m["tournament"]["name"]=="Premier League" and m["status"].get("finished")][-1]
d=get("matchDetails",{"matchId":fx["id"]})
lu=d["content"]["lineup"]
side=lu["homeTeam"] if lu["homeTeam"]["id"]==8455 else lu["awayTeam"]
print(side["formation"])
for p in side["starters"]: print(p["name"], p["positionId"], p.get("usualPlayingPositionId"), p["verticalLayout"]["x"], p["verticalLayout"]["y"])
PY
