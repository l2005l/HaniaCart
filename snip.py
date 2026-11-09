import sys
def snip(app): return '<script>/* Hania360: remember on this browser that this app is in use, so hania360.com can put what fits first (cookie h360_i; never sent anywhere by this page). */(function(){try{if(!/hania360\\.com$/.test(location.hostname))return;var A="'+app+'",m=document.cookie.match(/(?:^|; *)h360_i=([^;]*)/),o={};try{o=m?JSON.parse(decodeURIComponent(m[1]))||{}:{}}catch(e){}var a=(o.a||[]).filter(function(x){return x!==A});a.unshift(A);o.a=a.slice(0,10);var v=encodeURIComponent(JSON.stringify(o));if(v.length<1500)document.cookie="h360_i="+v+"; domain=hania360.com; path=/; max-age=31536000; samesite=lax; secure"}catch(e){}})()</script>'
f,app=sys.argv[1],sys.argv[2]
s=open(f).read()
assert s.count('</body>')>=1 and 'h360_i' not in s
i=s.rindex('</body>'); s=s[:i]+snip(app)+s[i:]
open(f,'w').write(s); print('ok',f)
