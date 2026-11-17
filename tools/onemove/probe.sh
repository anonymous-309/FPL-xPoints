#!/bin/bash
python3 - <<'PY'
import json, urllib.request, urllib.parse, collections
H={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36","Accept":"application/json","Referer":"https://www.fotmob.com/"}
def get(p,q):
    r=urllib.request.Request("https://www.fotmob.com/api/data/"+p+"?"+urllib.parse.urlencode(q),headers=H)
    return json.loads(urllib.request.urlopen(r,timeout=30).read())
lg=get("leagues",{"id":47,"ccode3":"GBR"})
tbl=lg.get("table") or []
teams=[]
try:
    for t in tbl[0]["data"]["table"]["all"]: teams.append((t["id"],t["name"]))
except Exception as e: print("table err",e, list(lg.keys()))
print(len(teams), teams[:3])
d=get("teams",{"id":teams[0][0],"ccode3":"GBR"})
print("keys", list(d.keys()))
fx=d.get("fixtures") or {}
print("fixtures keys", list(fx.keys()))
af=(fx.get("allFixtures") or {})
print("allFixtures keys", list(af.keys()))
L=af.get("fixtures") or []
print(len(L)); print(json.dumps(L[0])[:900]) if L else None
print(collections.Counter((m.get("tournament") or {}).get("name") for m in L))
for m in L[-12:]: print(m.get("status",{}).get("utcTime"), (m.get("tournament") or {}).get("name"), m["home"]["name"], "-", m["away"]["name"], m.get("status",{}).get("scoreStr"))
# cups leagues
for lid in (132,133,42,73,10216):
    try:
        x=get("leagues",{"id":lid,"ccode3":"GBR"}); det=x.get("details",{})
        am=((x.get("fixtures") or {}).get("allMatches") or [])
        print(lid, det.get("name"), det.get("selectedSeason"), len(am), [ (m.get("round"), m.get("roundName"), m["home"]["name"], m["away"]["name"], m["status"].get("utcTime")) for m in am[-3:]])
    except Exception as e: print(lid,"err",e)
PY
