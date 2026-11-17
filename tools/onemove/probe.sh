#!/bin/bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
curl -sSL -m 40 -A "$UA" -o /tmp/tn.html -w "HTTP %{http_code} bytes %{size_download}\n" https://www.fantasyfootballscout.co.uk/team-news/
python3 - <<'PY'
import re
h=open('/tmp/tn.html',encoding='utf-8',errors='ignore').read()
print('title:', re.search(r'<title>(.*?)</title>', h, re.S).group(1)[:120] if '<title>' in h else None)
for kw in ['Predicted','Doubts','Banned','Latest News','Last Updated','Arsenal','cf-challenge','Just a moment']:
    print(kw, h.count(kw))
i=h.find('Arsenal')
txt=re.sub(r'<[^>]+>',' ',h); txt=re.sub(r'\s+',' ',txt)
j=txt.find("Doubts"); print(txt[max(0,j-1500):j+1500]); print("SCRIPTS", len(re.findall(r"<script", h))); print([m[:150] for m in re.findall(r"(?:wp-json|ajax|api)[^\"\x27 ]{0,120}", h)][:15])
PY
curl -sS -m 30 https://www.fantasyfootballscout.co.uk/robots.txt | head -40
