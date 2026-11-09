import json,urllib.request,urllib.parse,re
UA={"User-Agent":"Hania360ImageFinder/1.0 (https://hania360.com)"}
for line in open('q.txt'):
  k,q=line.strip().split('|')
  u="https://commons.wikimedia.org/w/api.php?"+urllib.parse.urlencode({"action":"query","format":"json","generator":"search","gsrnamespace":6,"gsrsearch":q+" filetype:bitmap","gsrlimit":6,"prop":"imageinfo","iiprop":"url|extmetadata|size","iiurlwidth":1200})
  d=json.load(urllib.request.urlopen(urllib.request.Request(u,headers=UA)))
  ps=sorted(d.get("query",{}).get("pages",{}).values(),key=lambda p:p.get("index",9))
  for p in ps[:6]:
    ii=p["imageinfo"][0]; m=ii.get("extmetadata",{})
    lic=m.get("LicenseShortName",{}).get("value","?"); art=re.sub("<[^>]+>","",m.get("Artist",{}).get("value","?"))[:40]
    print("R",k,"|",p["title"][5:80],"|",lic,"|",art.strip(),"|",ii["width"],"x",ii["height"])
