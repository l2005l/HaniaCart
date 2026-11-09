import json,urllib.request,re
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"}
feeds={"ynet":"https://www.ynet.co.il/Integration/StoryRss3.xml","walla":"https://rss.walla.co.il/feed/3","maariv":"https://www.maariv.co.il/Rss/RssFeedsSport","one":"https://www.one.co.il/cat/coop/xml/rss/newsfeed.aspx","sport5":"https://www.sport5.co.il/RSS.aspx","israelhayom":"https://www.israelhayom.co.il/rss.xml","mako":"https://rcs.mako.co.il/rss/news-sports.xml"}
for k,u in feeds.items():
  try:
    r=urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=20); x=r.read().decode('utf-8','ignore')
    items=re.findall(r'<item>(.*?)</item>',x,re.S)
    print("RSS",k,r.status,len(items))
    for it in items[:4]:
      t=re.search(r'<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>',it,re.S); l=re.search(r'<link>(.*?)</link>',it,re.S); d=re.search(r'<pubDate>(.*?)</pubDate>',it)
      print("  -",(t.group(1).strip() if t else '')[:90],"|",(l.group(1).strip() if l else '')[:80],"|",d.group(1) if d else '')
  except Exception as e: print("RSS",k,"ERR",e)
H=dict(UA); H["Accept-Language"]="he-IL,he"
t=json.load(urllib.request.urlopen(urllib.request.Request("https://www.fotmob.com/api/data/teams?id=10181&ccode3=ISR&lang=he",headers=H)))
print("NAMES",[p["name"] for p in t["overview"]["topPlayers"]["byGoals"]["players"]])
