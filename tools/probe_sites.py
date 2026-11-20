import requests, re
H = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Accept-Language": "en-GB,en;q=0.9"}
for u in ["https://www.transfermarkt.com/robots.txt",
          "https://www.transfermarkt.com/bukayo-saka/verletzungen/spieler/433177",
          "https://www.whoscored.com/robots.txt",
          "https://www.whoscored.com/Regions/252/Tournaments/2/England-Premier-League"]:
    try:
        r = requests.get(u, headers=H, timeout=30)
        t = r.text
        print(u, r.status_code, len(t), "captcha/challenge" if re.search(r"captcha|challenge|Incapsula|cf-chl|Just a moment", t, re.I) else "")
        if "robots" in u: print("\n".join(l for l in t.splitlines() if re.search(r"verletz|injur|Disallow: /$|Disallow: /\*", l, re.I))[:600])
        if "verletzungen" in u:
            rows = re.findall(r'<td class="hauptlink">([^<]+)</td>\s*<td class="zentriert">([^<]+)</td>\s*<td class="zentriert">([^<]+)</td>', t)
            print("rows", rows[:5], "table" if "items" in t else "")
    except Exception as e:
        print(u, "ERR", e)
