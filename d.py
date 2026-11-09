import json,urllib.request,urllib.parse,re,base64,gzip,sys
UA={"User-Agent":"Hania360ImageFinder/1.0 (https://hania360.com)"}
def api(p):
  p.update({"action":"query","format":"json","prop":"imageinfo","iiprop":"url|extmetadata","iiurlwidth":1100})
  return json.load(urllib.request.urlopen(urllib.request.Request("https://commons.wikimedia.org/w/api.php?"+urllib.parse.urlencode(p),headers=UA)))
for line in open('pick.txt'):
  k,t=line.strip().split('|',1)
  try:
    if t.startswith('?'): d=api({"generator":"search","gsrnamespace":6,"gsrsearch":t[1:]+" filetype:bitmap","gsrlimit":3})
    else: d=api({"titles":"File:"+t})
    for n,p in enumerate(sorted(d["query"]["pages"].values(),key=lambda p:p.get("index",0))):
     kk=k+("_"+str(n) if t.startswith("?") else ""); ii=p["imageinfo"][0]; m=ii.get("extmetadata",{})
     g=lambda f:re.sub("<[^>]+>","",m.get(f,{}).get("value","")).strip()
     meta={"k":kk,"title":p["title"][5:],"page":ii["descriptionurl"],"artist":g("Artist")[:80],"lic":g("LicenseShortName"),"licurl":g("LicenseUrl")}
     img=urllib.request.urlopen(urllib.request.Request(ii["thumburl"],headers=UA)).read()
     print("MX "+json.dumps(meta,ensure_ascii=False))
     b=base64.b64encode(img).decode()
     for i in range(0,len(b),20000): print("FX",kk,i//20000,b[i:i+20000])
  except Exception as e: print("ERR",k,e)
