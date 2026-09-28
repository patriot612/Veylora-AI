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
const tabs=["dashboard","users","models","providers","roles","templates","plans","payments","search","statistics","queue","audit","config"];
function esc(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function api(path,options={}){const res=await fetch("/admin/api/"+path,{...options,headers:{"content-type":"application/json","X-Telegram-Init-Data":initData,...(options.headers||{})}});const body=await res.json().catch(()=>({}));if(!res.ok)throw new Error(body.error||"request_failed");return body;}
async function render(tab){
 try{
   const data=await api(tab);
   const rows=data.rows||[];
   if(tab==="dashboard"){
      app.innerHTML='<div class="grid">'+
       [['Users',data.users],['DAU',data.dau],['New users 24h',data.newUsers24h],['Operations 24h',data.operations24h],['Success %',data.successRate],['Errors 24h',data.errorCount24h],['Timeouts 24h',data.timeoutCount24h],['Subscriptions',data.activeSubscriptions],['Stars 24h',data.stars24h],['Points captured',data.pointsCaptured24h],['Points released',data.pointsReleased24h],['Queue pending',data.queuePending],['Search errors',data.searchErrors24h],['Provider errors',data.providerErrors24h]].map(x=>'<div class="card"><div class="muted">'+esc(x[0])+'</div><div class="metric">'+esc(x[1])+'</div></div>').join('')+
       '</div>';
      return;
   }
   if(tab==="users"){
      app.innerHTML='<div class="card"><button data-action="search-users">Search users</button> <input id="user-query" placeholder="@username / Telegram ID" style="padding:10px;border-radius:8px;border:1px solid #303747;background:#10131a;color:#fff"/><div id="user-results"><pre>'+esc(JSON.stringify(rows,null,2))+'</pre></div></div>';
      return;
   }
   if(tab==="models"){
      app.innerHTML='<div class="card"><button data-action="new-model">Add model</button> <button data-action="refresh">Refresh</button><div>'+
       rows.map(r=>'<div class="card"><strong>'+esc(r.display_name)+'</strong><div class="muted">'+esc(r.family_name)+' · '+esc(r.type)+' · provider routing configured</div><div>cost='+esc(r.points_cost)+' subscription='+esc(r.subscription_only)+' enabled='+esc(r.enabled)+' model='+esc(r.provider_model_id)+'</div><button data-action="edit-model" data-id="'+esc(r.id)+'">Edit</button> <button data-action="delete-model" data-id="'+esc(r.id)+'">Delete</button></div>').join('')+
       '</div></div>';
      return;
   }
   if(tab==="providers"){
      app.innerHTML='<div class="card"><button data-action="new-provider">Add provider</button>'+rows.map(r=>'<div class="card"><strong>'+esc(r.name)+'</strong><div class="muted">'+esc(r.adapter_type)+' · '+esc(r.endpoint)+'</div><div>enabled='+esc(r.enabled)+'</div><button data-action="edit-provider" data-id="'+esc(r.id)+'">Edit</button><button data-action="add-credential" data-id="'+esc(r.id)+'">Add credential</button></div>').join('')+'</div>';
      return;
   }
   if(tab==="roles"){
      app.innerHTML='<div class="card"><button data-action="new-role">Add role</button>'+rows.map(r=>'<div class="card"><strong>'+esc(r.name)+'</strong><div class="muted">'+esc(r.description)+'</div><button data-action="edit-role" data-id="'+esc(r.id)+'">Edit</button><button data-action="delete-role" data-id="'+esc(r.id)+'">Delete</button></div>').join('')+'</div>';
      return;
   }
   if(tab==="templates"){
      app.innerHTML='<div class="card"><button data-action="new-template">Add template</button>'+rows.map(r=>'<div class="card"><strong>'+esc(r.name)+'</strong><div class="muted">extra='+esc(r.extra_points_cost)+' enabled='+esc(r.enabled)+'</div><button data-action="edit-template" data-id="'+esc(r.id)+'">Edit</button></div>').join('')+'</div>';
      return;
   }
   if(tab==="plans"){
      app.innerHTML='<div class="card">'+rows.map(r=>'<div class="card"><strong>'+esc(r.name)+'</strong><div class="muted">⭐ '+esc(r.price_stars)+' · daily '+esc(r.daily_points)+' · retention '+esc(r.retention_hours)+'h · voice '+esc(r.voice_enabled)+'</div><button data-action="edit-plan" data-id="'+esc(r.id)+'">Edit</button></div>').join('')+'</div>';
      return;
   }
   if(tab==="payments"){
      app.innerHTML='<div class="card">'+rows.map(r=>'<div class="card"><strong>#'+esc(String(r.id).slice(0,8))+'</strong><div class="muted">'+esc(r.status)+' · '+esc(r.amount)+' '+esc(r.currency)+'</div>'+ (r.status==="paid" ? '<button data-action="refund" data-id="'+esc(r.id)+'">Refund</button>' : '') +'</div>').join('')+'</div>';
      return;
   }
   if(tab==="search"){
      const cfg=Object.fromEntries((data.config||[]).map(x=>[x.config_key,x.config_value]));
      app.innerHTML='<div class="card"><strong>Search Gateway</strong>'+
       '<label>Enabled <input id="search-enabled" type="checkbox" '+(cfg["search.enabled"]!=="0"?"checked":"")+' /></label>'+
       '<div><label>Primary URL<br/><input id="search-primary" value="'+esc(cfg["search.primary_url"]||"")+'" style="width:100%"/></label></div>'+
       '<div><label>Fallback URL<br/><input id="search-fallback" value="'+esc(cfg["search.fallback_url"]||"")+'" style="width:100%"/></label></div>'+
       '<div><label>Language<br/><input id="search-language" value="'+esc(cfg["search.language"]||"all")+'" /></label></div>'+
       '<div><label>Categories<br/><input id="search-categories" value="'+esc(cfg["search.categories"]||"general")+'" /></label></div>'+
       '<div><label>Time range<br/><input id="search-time" value="'+esc(cfg["search.time_range"]||"")+'" placeholder="day/week/month/year"/></label></div>'+
       '<div><label>Safe search <input id="search-safe" type="number" min="0" max="2" value="'+esc(cfg["search.safe_search"]||"0")+'" /></label></div>'+
       '<button data-action="save-search">Save Search configuration</button></div>'+
       '<div class="card"><strong>Recent operations</strong><pre>'+esc(JSON.stringify(rows,null,2))+'</pre></div>';
      return;
   }
   if(tab==="queue"){
      app.innerHTML='<div class="card"><strong>Queue / System</strong><pre>'+esc(JSON.stringify(rows,null,2))+'</pre><div class="muted">Maintenance controls are server-side configuration and remain protected by RBAC.</div></div>';
      return;
   }
   if(tab==="config"){
      app.innerHTML='<div class="card">'+rows.map(r=>'<div class="card"><strong>'+esc(r.config_key)+'</strong><pre>'+esc(r.config_value)+'</pre><button data-action="edit-config" data-key="'+esc(r.config_key)+'">Edit</button></div>').join('')+'</div>';
      return;
   }
   app.innerHTML='<div class="card"><div class="muted">'+esc(tab)+'</div><pre>'+esc(JSON.stringify(rows,null,2))+'</pre></div>';
 }catch(e){app.innerHTML='<div class="card"><strong>Ошибка</strong><pre>'+esc(e.message)+'</pre></div>';}
}
async function userBonus(id){
 const amount=prompt("Bonus points amount","10"); if(!amount) return;
 await api("users/"+encodeURIComponent(id)+"/bonus",{method:"POST",body:JSON.stringify({amount:Number(amount)})});
 await render("users");
}
async function createModel(){
 const options=await api("models/options");
 const families=options.families||[]; const providers=options.providers||[]; const credentials=options.credentials||[];
 const id=(prompt("Model ID")||crypto.randomUUID()).trim();
 const familyId=prompt("Family ID\n"+families.map(x=>x.id+" = "+x.name).join("\n")); if(!familyId) return;
 const providerId=prompt("Provider ID\n"+providers.map(x=>x.id+" = "+x.name).join("\n")); if(!providerId) return;
 const providerCredentials=credentials.filter(x=>x.provider_id===providerId);
 const credentialId=prompt("Credential ID\n"+providerCredentials.map(x=>x.id+" = "+x.name).join("\n")); if(!credentialId) return;
 const displayName=prompt("Display name"); if(!displayName) return;
 const type=prompt("Type (chat/search/image/voice)","chat"); if(!type) return;
 const providerModelId=prompt("Provider model ID"); if(!providerModelId) return;
 const pointsCost=Number(prompt("Points cost","1")||"0");
 const subscriptionOnly=confirm("Subscription-only?");
 await api("models",{method:"POST",body:JSON.stringify({id,familyId,providerId,credentialId,displayName,type,providerModelId,pointsCost,subscriptionOnly,enabled:true})});
 await render("models");
}
async function editModel(id){
 const points=prompt("Points cost"); if(points===null) return;
 const enabled=confirm("Enable model?"); const subscriptionOnly=confirm("Subscription-only?");
 await api("models/"+encodeURIComponent(id),{method:"PUT",body:JSON.stringify({pointsCost:Number(points),enabled,subscriptionOnly})});
 await render("models");
}
async function deleteModel(id){
 if(!confirm("Delete model?")) return;
 await api("models/"+encodeURIComponent(id),{method:"DELETE"});
 await render("models");
}
async function searchUsers(){
 const q=document.getElementById("user-query")?.value||"";
 const data=await api("users?q="+encodeURIComponent(q));
 const rows=data.rows||[];
 document.getElementById("user-results").innerHTML=rows.map(r=>'<div class="card"><strong>'+esc(r.first_name||r.username||r.telegram_user_id)+'</strong><div class="muted">'+esc(r.telegram_user_id)+' · '+esc(r.status)+'</div><button data-action="bonus-user" data-id="'+esc(r.telegram_user_id)+'">Grant bonus</button></div>').join('');
}
async function createProvider(){
 const name=prompt("Provider name"); if(!name) return;
 const adapterType=prompt("Adapter type","openai_compatible")||"openai_compatible";
 const endpoint=prompt("Endpoint","https://")||"https://";
 await api("providers",{method:"POST",body:JSON.stringify({name,adapterType,endpoint,enabled:true})});
 await render("providers");
}
async function editProvider(id){
 const name=prompt("Provider name"); if(!name) return;
 const adapterType=prompt("Adapter type","openai_compatible")||"openai_compatible";
 const endpoint=prompt("Endpoint","https://")||"https://";
 await api("providers/"+encodeURIComponent(id),{method:"PUT",body:JSON.stringify({name,adapterType,endpoint,enabled:true})});
 await render("providers");
}
async function addCredential(id){
 const name=prompt("Credential name"); if(!name) return;
 const secret=prompt("Secret"); if(secret===null) return;
 await api("providers/"+encodeURIComponent(id)+"/credentials/"+crypto.randomUUID(),{method:"POST",body:JSON.stringify({name,secret,enabled:true})});
 await render("providers");
}
async function createRole(){
 const name=prompt("Role name"); if(!name) return;
 const description=prompt("Description","")||"";
 const systemPrompt=prompt("System prompt"); if(!systemPrompt) return;
 await api("roles",{method:"POST",body:JSON.stringify({name,description,systemPrompt,enabled:true})});
 await render("roles");
}
async function editRole(id){
 const name=prompt("Role name"); if(!name) return;
 const description=prompt("Description","")||"";
 const systemPrompt=prompt("System prompt"); if(!systemPrompt) return;
 await api("roles/"+encodeURIComponent(id),{method:"PUT",body:JSON.stringify({name,description,systemPrompt,enabled:true})});
 await render("roles");
}
async function createTemplate(){
 const name=prompt("Template name"); if(!name) return;
 const description=prompt("Description","")||"";
 const promptTemplate=prompt("Prompt template","{{prompt}}"); if(!promptTemplate) return;
 const extraPointsCost=Number(prompt("Extra points cost","0")||"0");
 await api("templates",{method:"POST",body:JSON.stringify({name,description,promptTemplate,extraPointsCost,enabled:true})});
 await render("templates");
}
async function editTemplate(id){
 const name=prompt("Template name"); if(!name) return;
 const description=prompt("Description","")||"";
 const promptTemplate=prompt("Prompt template","{{prompt}}"); if(!promptTemplate) return;
 const extraPointsCost=Number(prompt("Extra points cost","0")||"0");
 await api("templates/"+encodeURIComponent(id),{method:"PUT",body:JSON.stringify({name,description,promptTemplate,extraPointsCost,enabled:true})});
 await render("templates");
}
async function editPlan(id){
 const priceStars=Number(prompt("Price Stars")||"0");
 const dailyPoints=Number(prompt("Daily points")||"0");
 const retentionHours=Number(prompt("Retention hours")||"24");
 const voiceEnabled=confirm("Voice enabled?");
 await api("plans/"+encodeURIComponent(id),{method:"PUT",body:JSON.stringify({priceStars,dailyPoints,retentionHours,voiceEnabled,enabled:true})});
 await render("plans");
}
async function refundOrder(id){
 if(!confirm("Refund this payment?")) return;
 await api("payments/"+encodeURIComponent(id)+"/refund",{method:"POST"});
 await render("payments");
}
async function saveSearch(){
 const body={
   "search.enabled":document.getElementById("search-enabled").checked,
   "search.primary_url":document.getElementById("search-primary").value,
   "search.fallback_url":document.getElementById("search-fallback").value,
   "search.language":document.getElementById("search-language").value,
   "search.categories":document.getElementById("search-categories").value,
   "search.time_range":document.getElementById("search-time").value,
   "search.safe_search":Number(document.getElementById("search-safe").value||"0")
 };
 await api("search",{method:"PUT",body:JSON.stringify(body)});
 await render("search");
}
async function editConfig(key){
 const value=prompt("New value");
 if(value===null) return;
 await api("config",{method:"PUT",body:JSON.stringify({key,value})});
 await render("config");
}
async function deleteRole(id){
 if(!confirm("Delete role?")) return;
 await api("roles/"+encodeURIComponent(id),{method:"DELETE"});
 await render("roles");
}
app.addEventListener("click",async(event)=>{
 const target=event.target.closest("[data-action]"); if(!target) return;
 try{
  const action=target.dataset.action; const id=target.dataset.id;
  if(action==="refresh") return render(nav.querySelector(".tab")?.textContent||"dashboard");
  if(action==="search-users") return searchUsers();
  if(action==="bonus-user") return userBonus(id);
  if(action==="new-model") return createModel();
  if(action==="edit-model") return editModel(id);
  if(action==="delete-model") return deleteModel(id);
  if(action==="new-provider") return createProvider();
  if(action==="edit-provider") return editProvider(id);
  if(action==="add-credential") return addCredential(id);
  if(action==="new-role") return createRole();
  if(action==="edit-role") return editRole(id);
  if(action==="delete-role") return deleteRole(id);
  if(action==="new-template") return createTemplate();
  if(action==="edit-template") return editTemplate(id);
  if(action==="edit-plan") return editPlan(id);
  if(action==="refund") return refundOrder(id);
  if(action==="edit-config") return editConfig(target.dataset.key);
  if(action==="save-search") return saveSearch();
 }catch(e){app.innerHTML='<div class="card"><strong>Ошибка</strong><pre>'+esc(e.message)+'</pre></div>';}
});
tabs.forEach(tab=>{const b=document.createElement("button");b.className="tab";b.textContent=tab;b.onclick=()=>render(tab);nav.appendChild(b);});
(async()=>{try{const session=await api("session");document.title="Veylora Admin — "+session.role;await render("dashboard");}catch(e){app.innerHTML='<div class="card"><strong>Доступ запрещён</strong><pre>'+esc(e.message)+'</pre></div>';}})();
</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self' https://telegram.org 'nonce-" + nonce + "'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    },
  });
}
