#!/bin/bash
pip install -q -r requirements.txt >/dev/null 2>&1
python3 -c "
import json, fpl_xpoints as f
from pathlib import Path
c=Path('/tmp/cache')
f.club_fixtures(c, False)
d=json.load(open('/tmp/data.json'))
players={p['id']:p for p in d['players']}
b=f._api('bootstrap-static/', c, False)
ev=[e for e in b['events'] if e.get('is_next')][0]['id']
L=json.load(open('/tmp/cache/fotmob/lineups.json'))
print('MCI roles', {k:v for k,v in L['MCI']['roles'].items()})
for p in players.values():
    if p['team']=='MCI' and p['position'] in ('DEF','MID'): print(' ', p['name'], p['position'], round(p['byGw'][str(ev)]['xmin']))
tn=f.team_news(c, False, players, ev)
for t in tn['teams']: print(t['short'], t['formation'], ' '.join(f\"{x['role']}:{x['name']}{'*' if x['new'] else ''}\" for x in t['xi']), '| out', t['lastXi']['out'] if t['lastXi'] else None)
"
