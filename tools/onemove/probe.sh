#!/bin/bash
python3 -c "
import json
d=json.load(open('/tmp/data.json')); g=str(d['gws'][0])
print(list(d['players'][0]['byGw'][g].keys()))
seen={}
for p in d['players']:
    b=p['byGw'].get(g) or {}
    if p['position'] in ('GK','DEF') and p['team'] not in seen and b:
        seen[p['team']]=(b.get('opp') or b.get('fixtures') or b.get('vs'), b.get('pCs') or b.get('pCS') or b.get('cs'))
for t,v in sorted(seen.items(), key=lambda x: -(x[1][1] or 0)): print(t, v)
"
