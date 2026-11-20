import requests, re
H = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Accept-Language": "en-GB,en;q=0.9"}
def get(u):
    r = requests.get(u, headers=H, timeout=30); print("==", u, r.status_code, len(r.text)); return r.text
for u in ["https://ie.soccerway.com/england/premier-league-2024-2025/", "https://ie.soccerway.com/england/premier-league-2024-2025/results/", "https://ie.soccerway.com/england/premier-league/"]:
    t = get(u); teams = sorted(set(re.findall(r'/team/[a-z0-9-]+/[A-Za-z0-9]{8}/', t))); print(len(teams), teams[:30])
t = get("https://ie.soccerway.com/team/arsenal/hA1Zm19f/squad/")
pl = sorted(set(re.findall(r'/player/[a-z0-9-]+/[A-Za-z0-9]{8}/', t))); print("players", len(pl), pl[:10])
print("season options:", re.findall(r'squad/[^"\']*\d{4}[^"\']*', t)[:10])
t = get("https://ie.soccerway.com/england/premier-league-2024-2025/results/")
txt = re.sub(r"<[^>]+>", " ", re.sub(r"<script.*?</script>", " ", t, flags=re.S)); print(re.sub(r"\s+"," ",txt)[:800])
print("match links:", re.findall(r'/match/[^"\']+', t)[:5], "feeds:", re.findall(r'cjs\.initialFeeds\[[^\]]+\]', t)[:5])
