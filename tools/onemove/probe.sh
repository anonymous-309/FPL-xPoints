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
tn=f.team_news(c, False, players, ev)
open('/tmp/tn.json','w').write(json.dumps(tn,ensure_ascii=False))
for t in tn['teams']: print(t['short'], t['formation'], ' '.join(f\"{x['role']}:{x['name']}\" for x in t['xi']), '|', [(x['name'], x['role'], x['xmin'], x['for']) for x in t['xi'] if x['new']])
"
echo FXSTART; gzip -c /tmp/tn.json | base64 -w0; echo; echo FXEND
