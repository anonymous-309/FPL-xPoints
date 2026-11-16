import json, requests
MID = 5795363
S = requests.Session()
S.headers.update({"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Accept": "application/json", "Referer": "https://www.fotmob.com/"})
for api in ["https://www.fotmob.com/api/data", "https://www.fotmob.com/api"]:
    r = S.get(f"{api}/matchDetails", params={"matchId": MID}, timeout=30)
    print(api, r.status_code, len(r.content))
    if r.ok:
        d = r.json()
        ev = (((d.get("content") or {}).get("matchFacts") or {}).get("events") or {}).get("events") or []
        subs = [e for e in ev if e.get("type") == "Substitution"]
        print("events", len(ev), "subs", len(subs))
        print(json.dumps(subs[:3], indent=0)[:2500])
        break
