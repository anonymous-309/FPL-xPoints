#!/bin/bash
python3 - <<'PY'
import json, urllib.request, urllib.parse
H={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36","Accept":"application/json","Referer":"https://www.fotmob.com/"}
def get(p,q):
    r=urllib.request.Request("https://www.fotmob.com/api/data/"+p+"?"+urllib.parse.urlencode(q),headers=H)
    return json.loads(urllib.request.urlopen(r,timeout=30).read())
lg=get("leagues",{"id":47,"ccode3":"GBR"})
ms=[m for m in (lg.get("fixtures") or {}).get("allMatches",[]) if (m.get("status") or {}).get("finished")]
m=ms[-1]; print(m["home"]["name"], m["away"]["name"], m["id"])
d=get("matchDetails",{"matchId":m["id"]})
lu=(d.get("content") or {}).get("lineup") or {}
print("lineup keys", list(lu.keys()))
ht=lu.get("homeTeam") or {}
print("home keys", list(ht.keys()), ht.get("formation"))
st=ht.get("starters") or []
print(json.dumps(st[:1])[:1500])
print([ (p.get("name"), p.get("positionId"), p.get("usualPlayingPositionId"), (p.get("verticalLayout") or {}).get("x"), (p.get("verticalLayout") or {}).get("y")) for p in st])
print("unavail", json.dumps(ht.get("unavailable"))[:500])
t=get("teams",{"id":m["home"]["id"],"ccode3":"GBR"})
ov=t.get("overview") or {}
print("overview keys", list(ov.keys()))
for k in ov:
    if "ineup" in k: print(k, json.dumps(ov[k])[:1200])
PY
