import json,urllib.request
UA={"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36","accept":"application/json"}
def g(u):
  try: return json.load(urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=20))
  except Exception as e: return {"ERR":str(e)}
def sh(o,d=0,maxd=3):
  if d>maxd: return type(o).__name__
  if isinstance(o,dict): return {k:sh(v,d+1,maxd) for k,v in list(o.items())[:25]}
  if isinstance(o,list): return [sh(o[0],d+1,maxd),len(o)] if o else []
  return o if not isinstance(o,str) else o[:60]
t=g("https://www.fotmob.com/api/data/teams?id=10181&ccode3=ISR")
print("TEAM", json.dumps(sh(t.get("overview",t),0,2),ensure_ascii=False)[:3000])
ov=t.get("overview",{})
for k in ["topPlayers","teamForm","nextMatch","lastMatch","venue","coach"]:
  if k in ov: print("OV",k,json.dumps(sh(ov[k],0,4),ensure_ascii=False)[:1500])
print("TEAMKEYS",list(t.keys()))
if "squad" in t: print("SQUAD",json.dumps(sh(t["squad"],0,4),ensure_ascii=False)[:800])
l=g("https://www.fotmob.com/api/data/leagues?id=127")
print("LEAGUEKEYS",list(l.keys()))
if "stats" in l: print("LSTATS",json.dumps(sh(l["stats"],0,5),ensure_ascii=False)[:2500])
for u in ["https://www.fotmob.com/api/data/tlnews?id=10181&type=team&language=he&startIndex=0","https://www.fotmob.com/api/data/tlnews?id=127&type=league&language=he&startIndex=0","https://www.fotmob.com/api/data/tlnews?id=10181&type=team&language=en&startIndex=0"]:
  n=g(u); print("NEWS",u[-40:],json.dumps(sh(n,0,3),ensure_ascii=False)[:1200])
