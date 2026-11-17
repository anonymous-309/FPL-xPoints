#!/bin/bash
pip install -q -r requirements.txt >/dev/null 2>&1
python3 -c "
import json, fpl_xpoints as f
from pathlib import Path
b=f._api('bootstrap-static/', Path('/tmp/cache'), False)
ev=[e for e in b['events'] if e.get('is_next')][0]['id']
d=f.team_news(Path('/tmp/cache'), False, {}, ev)
open('/tmp/tn.json','w').write(json.dumps(d,ensure_ascii=False))
"
echo FXSTART; gzip -c /tmp/tn.json | base64 -w0; echo; echo FXEND
