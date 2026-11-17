#!/bin/bash
pip install -q -r requirements.txt >/dev/null 2>&1
python3 -c "
import json, fpl_xpoints as f
from pathlib import Path
c=Path('/tmp/cache')
b=f._api('bootstrap-static/', c, False)
h, cov, oop = f.injury_subs(c, False, b)
st=json.load(open('injury_subs.json'))
for mid,g in sorted(st.items(), key=lambda x: x[1]['round']):
    for k in ('home','away'):
        if g[k].startswith('Sunderland'):
            print(g['round'], k, [(n.split()[-1], pid, x) for n,pid,x in g['starters'][k] if pid and pid>=30 and pid<100])
print([ (e['web_name'], e['first_name'], e['second_name'], e['element_type']) for e in b['elements'] if e['web_name'] in ('Hume','Meunier')])
"
