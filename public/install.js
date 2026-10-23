// "Install as an app" bar, shown on phones when the site is not already installed.
// Android/Chrome: the browser's own install prompt. iPhone: how to add it from Safari's Share menu.
// Closing it hides it for 30 days. Works under a strict CSP (no inline styles or scripts).
(function () {
  var s = document.currentScript, name = (s && s.dataset.name) || document.title.split(/[·|-]/)[0].trim();
  var color = (s && s.dataset.color) || "#0E6B5C", apk = (s && s.dataset.apk) || "", android = /android/i.test(navigator.userAgent || ""), KEY = "hania-install-snooze";
  var ua = navigator.userAgent || "", ios = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var phone = ios || /android|mobile/i.test(ua);
  var standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  var snoozed = false;
  try { snoozed = Number(localStorage.getItem(KEY) || 0) > Date.now(); } catch (e) {}
  var deferred = null, bar = null;
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferred = e; if (bar) setMode(); else maybeShow(); });
  window.addEventListener("appinstalled", function () { hide(); });
  function el(tag, css, text) { var n = document.createElement(tag); for (var k in css) n.style[k] = css[k]; if (text) n.textContent = text; return n; }
  var msg, btn;
  function setMode() {
    if (apk && android) { msg.textContent = "יש ל־" + name + " אפליקציה לאנדרואיד"; btn.textContent = "הורדה"; btn.hidden = false; }
    else if (deferred) { msg.textContent = "אפשר להתקין את " + name + " כאפליקציה בטלפון"; btn.hidden = false; }
    else if (ios) { msg.textContent = "להוספה כאפליקציה: לוחצים על כפתור השיתוף (ריבוע עם חץ למעלה) ואז \"הוספה למסך הבית\""; btn.hidden = true; }
    else { msg.textContent = "להוספה כאפליקציה: בתפריט הדפדפן ⋮ בוחרים \"הוספה למסך הבית\""; btn.hidden = true; }
  }
  function hide() { if (bar) bar.remove(); bar = null; }
  function maybeShow() {
    if (bar || standalone || snoozed || !phone || !document.body) return;
    bar = el("div", { position: "fixed", insetInline: "10px", bottom: "calc(10px + env(safe-area-inset-bottom))", zIndex: "2147483000", display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "14px", background: "#fff", color: "#13201B", boxShadow: "0 6px 24px rgba(0,0,0,.18)", border: "1px solid #DCE3DF", font: "600 14px/1.35 system-ui,-apple-system,'Segoe UI',Arial,sans-serif", direction: "rtl" });
    bar.setAttribute("role", "region"); bar.setAttribute("aria-label", "התקנת האפליקציה");
    var icon = el("span", { flex: "none", width: "34px", height: "34px", borderRadius: "9px", background: color, color: "#fff", display: "grid", placeItems: "center", fontSize: "18px" }, "⇩");
    msg = el("span", { flex: "1" });
    btn = el("button", { flex: "none", border: "0", borderRadius: "10px", padding: "9px 14px", background: color, color: "#fff", font: "inherit", cursor: "pointer" }, "התקנה");
    btn.type = "button";
    btn.onclick = function () { if (apk && android) { location.href = apk; return; } if (!deferred) return; deferred.prompt(); deferred.userChoice.then(function (c) { deferred = null; if (c && c.outcome === "accepted") hide(); else setMode(); }); };
    var x = el("button", { flex: "none", border: "0", background: "transparent", color: "#5C6B65", fontSize: "22px", lineHeight: "1", padding: "4px 6px", cursor: "pointer" }, "×");
    x.type = "button"; x.setAttribute("aria-label", "סגירה");
    x.onclick = function () { try { localStorage.setItem(KEY, String(Date.now() + 30 * 864e5)); } catch (e) {} snoozed = true; hide(); };
    bar.append(icon, msg, btn, x); setMode(); document.body.appendChild(bar);
    // In a game, keep the bar to the menu screen: it goes away when the flight starts.
    if (s && s.dataset.menuOnly) var t = setInterval(function () { if (!bar) return clearInterval(t); if (window.__raam && window.__raam.state !== "menu") { clearInterval(t); hide(); } }, 800);
  }
  // Give the browser a moment to offer its own prompt, then show the right version.
  function start() { setTimeout(maybeShow, deferred ? 0 : 2500); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
