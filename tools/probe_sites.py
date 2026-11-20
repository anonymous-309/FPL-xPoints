import requests, re
H = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
t = requests.get("https://ie.soccerway.com/england/premier-league-2024-2025/results/", headers=H, timeout=30).text
for m in list(re.finditer("hA1Zm19f", t))[:4]: print("CTX:", repr(t[max(0, m.start()-300):m.start()+100]))
print("PX pairs:", sorted(set(re.findall(r"(?:WU|WV)÷([a-z0-9-]+)¬[^÷]{0,6}÷?", t)))[:40])
