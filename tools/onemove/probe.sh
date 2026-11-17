#!/bin/bash
pip install -q -r requirements.txt >/dev/null 2>&1
python3 -c "
import fpl_xpoints as f
from pathlib import Path
c=Path('/tmp/cache')
b=f._api('bootstrap-static/', c, False)
h, cov, oop = f.injury_subs(c, False, b)
code={f\"c{e['code']}\": e['web_name'] for e in b['elements']}
for k,v in oop.items(): print('OOP', code.get(k), v)
"
