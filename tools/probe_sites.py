import requests, re
H = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Accept-Language": "en-GB,en;q=0.9"}
for u in ["https://ie.soccerway.com/robots.txt",
          "https://ie.soccerway.com/player/sanders-caleb/IeF6ohjB/injury-history",
          "https://ie.soccerway.com/player/saka-bukayo/vw8ZV7HC/injury-history"]:
    try:
        r = requests.get(u, headers=H, timeout=30)
        t = r.text
        print("==", u, r.status_code, len(t), "challenge" if re.search(r"captcha|challenge|Incapsula|cf-chl|Just a moment", t, re.I) else "")
        if "robots" in u: print(t[:1500])
        else:
            txt = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S)
            txt = re.sub(r"<[^>]+>", " ", txt); txt = re.sub(r"\s+", " ", txt)
            i = txt.lower().find("injur"); print("TEXT:", txt[max(0,i-200):i+1500])
            print("feeds:", sorted(set(re.findall(r"[a-z0-9./_-]*feed[a-z0-9./_-]*", t)))[:20])
    except Exception as e:
        print(u, "ERR", e)
