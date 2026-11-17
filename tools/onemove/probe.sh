#!/bin/bash
python3 -c "
import json
d=json.load(open('/tmp/data.json')); g=str(d['gws'][0])
for p in d['players']:
    if p.get('oopShare') or p.get('role')!=p['position']:
        b=p['byGw'].get(g,{})
        print(p['name'], p['team'], p['position'], p.get('role'), p.get('oopShare'), p.get('places'), 'xP', round(b.get('xpts',0),2), 'score', b.get('pScore'), 'assist', b.get('pAssist'))
"
