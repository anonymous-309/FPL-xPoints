#!/bin/bash
pip install -q -r requirements.txt >/dev/null 2>&1
python3 -c "
import json, fpl_xpoints as f
from pathlib import Path
d=f.club_fixtures(Path('/tmp/cache'), False)
open('/tmp/fx.json','w').write(json.dumps(d,ensure_ascii=False))
"
echo FXSTART; gzip -c /tmp/fx.json | base64 -w0; echo; echo FXEND
