#!/bin/bash
python3 -c "
import json, collections
d=json.load(open('/tmp/data.json')); g=str(d['gws'][0])
tp=collections.defaultdict(list); taken=collections.Counter(); miss=collections.Counter()
for p in d['players']:
    b=p['byGw'].get(g) or {}
    if not b: continue
    pcs=b.get('pc'); tps=b.get('tp')
    if tps: tp[p['team']].append(tps if isinstance(tps,(int,float)) else tps[0])
    if pcs and tps:
        pc0=pcs if isinstance(pcs,(int,float)) else sum(pcs); t0=tps if isinstance(tps,(int,float)) else tps[0]
        taken[p['team']] += pc0*t0*b.get('xmin',0)/90
    miss[p['team']] += b.get('pPenMiss',0) or 0
print('sample', {k: d['players'][0]['byGw'][g].get(k) for k in ('pc','tp','xmin','pPenMiss')})
awarded={t: max(v) for t,v in tp.items()}
print('awarded per team (team_pens):', {t: round(v,3) for t,v in sorted(awarded.items())})
print('TOTAL awarded', round(sum(awarded.values()),2), 'taken by listed takers', round(sum(taken.values()),2), 'per team avg', round(sum(awarded.values())/len(awarded),3), 'expected misses (sum pPenMiss)', round(sum(miss.values()),3))
print('setpieces keys', [k for k in d.keys()])
"
