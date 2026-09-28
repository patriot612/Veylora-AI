export function renderAdminApp(): Response {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes, (value) => value.toString(16).padStart(2, "0")).join("");
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Veylora Admin</title>
<script src="https://telegram.org/js/telegram-web-app.js?63"></script>
<style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1115;color:#f5f7fa}
body{margin:0;background:linear-gradient(180deg,#11141a,#0b0d11);min-height:100vh}
header{position:sticky;top:0;z-index:3;padding:16px;background:#11141ae8;backdrop-filter:blur(10px);border-bottom:1px solid #252a33}
main{padding:12px;max-width:900px;margin:auto}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.card{background:#171a21;border:1px solid #2a303b;border-radius:14px;padding:14px}.metric{font-size:28px;font-weight:700}.muted{color:#98a1af;font-size:13px}
nav{display:flex;gap:8px;overflow:auto;padding:10px 0}.tab{border:1px solid #303747;background:#171a21;color:#fff;border-radius:999px;padding:9px 12px;white-space:nowrap}
button{border:0;border-radius:10px;padding:10px 12px;background:#2b6cff;color:#fff;font-weight:600}
pre{white-space:pre-wrap;overflow:auto;background:#10131a;padding:12px;border-radius:10px}
@media(max-width:640px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><strong>Veylora Admin</strong><nav id="nav"></nav></header>
<main id="app"><div class="card">Авторизация…</div></main>
<script nonce="${nonce}">
const tg=window.Telegram?.WebApp;
tg?.ready(); tg?.expand();
const initData=tg?.initData||"";
const app=document.getElementById("app");
const nav=document.getElementById("nav");
const tabs=["dashboard","users","models","providers","roles","templates","plans","payments","queue","audit","config"];
function esc(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function api(path,options={}){const res=await fetch("/admin/api/"+path,{...options,headers:{"content-type":"application/json","X-Telegram-Init-Data":initData,...(options.headers||{})}});const body=await res.json().catch(()=>({}));if(!res.ok)throw new Error(body.error||"request_failed");return body;}
async function render(tab){
 try{
   const data=await api(tab);
   const rows=data.rows||[];
   if(tab==="dashboard"){
      app.innerHTML='<div class="grid">'+
       [['Users',data.users],['Operations 24h',data.operations24h],['Queue pending',data.queuePending],['Subscriptions',data.activeSubscriptions],['Stars 24h',data.stars24h]].map(x=>'<div class="card"><div class="muted">'+esc(x[0])+'</div><div class="metric">'+esc(x[1])+'</div></div>').join('')+
       '</div>';
   }else{
      app.innerHTML='<div class="card"><div class="muted">'+esc(tab)+'</div><pre>'+esc(JSON.stringify(rows,null,2))+'</pre></div>';
   }
 }catch(e){app.innerHTML='<div class="card"><strong>Ошибка</strong><pre>'+esc(e.message)+'</pre></div>';}
}
tabs.forEach(tab=>{const b=document.createElement("button");b.className="tab";b.textContent=tab;b.onclick=()=>render(tab);nav.appendChild(b);});
(async()=>{try{const session=await api("session");document.title="Veylora Admin — "+session.role;await render("dashboard");}catch(e){app.innerHTML='<div class="card"><strong>Доступ запрещён</strong><pre>'+esc(e.message)+'</pre></div>';}})();
</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self' https://telegram.org 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    },
  });
}
