// @ts-nocheck
// 麺部AI：質問から場所と食べたい麺を読み取り、ホットペッパーの店と麺部の店から選んで答える。
// 鍵はこのプロジェクトに登録済みのものを実行時に読むだけで、コードには書かない。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// 店の一覧は表 menbu_shops から読む（LINEの取り込みで増える）
var MENBU = [], SEEDS = [], AREA = {}, KEYS = [], loadedAt = 0;
function norm(s){
  return String(s||"").normalize("NFKC").toLowerCase().replace(/[\s　・･\-‐－―ー'’.．,，()（）「」]/g,"");
}
var PRE = ["らーめん専門店","らーめん小屋","鶏白湯ラーメン","仙台中華そば銘店","手打ち蕎麦","手打ちそば","ラーメン","らーめん","らぁめん","らぁ麺","中華そば","支那そば","そば処","つけ麺","つけめん","麺style","麺屋","麺や","麵や","麺処","麺","レストラン"].map(norm);
var SUF = ["ラーメン","らーめん","そば","蕎麦","うどん","食堂"].map(norm);
function cores(n){
  var out=[n], p=n, i;
  for(i=0;i<PRE.length;i++){ if(p.indexOf(PRE[i])===0 && p.length>PRE[i].length){ p=p.slice(PRE[i].length); break; } }
  out.push(p);
  var q=p.replace(/(総本店|本店)$/,"")||p;
  out.push(q);
  if(/店$/.test(p)){ for(var k=2;k<=8;k++){ if(p.length>k+1){ out.push(p.slice(0,p.length-k-1)); } } }
  for(i=0;i<SUF.length;i++){
    var s=SUF[i];
    if(q.length>s.length && q.lastIndexOf(s)===q.length-s.length){ out.push(q.slice(0,q.length-s.length)); }
    if(n.length>s.length && n.lastIndexOf(s)===n.length-s.length){ out.push(n.slice(0,n.length-s.length)); }
  }
  return out;
}
function inHokkaido(lat,lon){ return lat>41.3 && lat<45.6 && lon>139.3 && lon<145.9; }
function matchMenbu(name,lat,lon){
  var n=norm(name), cs=cores(n), h=inHokkaido(lat,lon), i, j;
  for(i=0;i<MENBU.length;i++){
    if((MENBU[i][4]==="h")!==h){ continue; }
    for(j=0;j<KEYS[i].length;j++){
      var k=KEYS[i][j];
      if(MENBU[i][3] ? cs.indexOf(k)>=0 : n.indexOf(k)>=0){ return i; }
    }
  }
  return -1;
}
function dist(a,b,c,d){
  var R=6371000, r=Math.PI/180, x=(c-a)*r, y=(d-b)*r;
  var h=Math.sin(x/2)*Math.sin(x/2)+Math.cos(a*r)*Math.cos(c*r)*Math.sin(y/2)*Math.sin(y/2);
  return 2*R*Math.asin(Math.sqrt(h));
}


var SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
var SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
var ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
var OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
var DAILY_CAP = 600;
var GMAPS_DAY_CAP = 300;
var GPLACES_DAY_CAP = 150; // Googleの近くの店検索（Nearby Search Pro。月5,000回まで無料）は1日150回まで
// GOOGLE_MAPS_BROWSER_KEY はブラウザ用の鍵（menbu-map.github.io からだけ使えるように制限して登録する）。ページに渡す前提の公開用の鍵で、ほかの鍵とは分ける
var ORIGIN_RE = /^https:\/\/menbu-map\.github\.io$/i;

function cors(origin){
  return {"access-control-allow-origin":origin&&ORIGIN_RE.test(origin)?origin:"https://menbu-map.github.io","vary":"Origin","access-control-allow-headers":"authorization, x-client-info, apikey, content-type","access-control-allow-methods":"GET, POST, OPTIONS","content-type":"application/json; charset=utf-8","cache-control":"no-store"};
}
function reply(origin,code,obj){ return new Response(JSON.stringify(obj),{status:code,headers:cors(origin)}); }
function rest(path,init){
  init=init||{}; init.headers=Object.assign({apikey:SERVICE_KEY,Authorization:"Bearer "+SERVICE_KEY,"content-type":"application/json"},init.headers||{});
  return fetch(SUPABASE_URL+"/rest/v1/"+path,init);
}
async function loadShops(){
  if(MENBU.length&&Date.now()-loadedAt<300000){ return; }
  var r=await rest("menbu_shops?select=idx,name,note,keys,exact,region,lat,lon,area&order=idx.asc");
  if(!r.ok){ return; }
  var rows=await r.json(); if(!Array.isArray(rows)||!rows.length){ return; }
  var m=[], s=[], ar={};
  rows.forEach(function(x,i){
    m.push([x.name,x.note||"",x.keys||[],x.exact?1:0,x.region||"h"]);
    if(x.lat!=null&&x.lon!=null){ s.push([i,x.lat,x.lon]); ar[i]=x.area||""; }
  });
  MENBU=m; SEEDS=s; AREA=ar; KEYS=m.map(function(v){ return v[2].map(norm); }); loadedAt=Date.now();
}
async function hotpepperKey(){
  var r=await rest("rpc/meal_map_provider_credentials_v1",{method:"POST",body:JSON.stringify({p_provider:"hotpepper"})});
  if(!r.ok){ return ""; }
  var j=await r.json(); return (j&&j.api_key)||"";
}
// 回数の制限：同じ相手は1日80回（約40問）、全体は1日600回まで。相手の識別は接続元を伏せ字にしたもの
var IP_CAP = 80;
async function clientKey(req){
  var ip=req.headers.get("cf-connecting-ip")||req.headers.get("x-real-ip")||String(req.headers.get("x-forwarded-for")||"").split(",").pop().trim()||"unknown";
  var buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(ip+"|"+SERVICE_KEY.slice(-16)));
  return Array.from(new Uint8Array(buf)).slice(0,12).map(function(b){ return b.toString(16).padStart(2,"0"); }).join("");
}
async function underCap(req){
  var r=await rest("rpc/menbu_ai_hit",{method:"POST",body:JSON.stringify({p_ip:await clientKey(req),p_ip_cap:IP_CAP,p_day_cap:DAILY_CAP})});
  if(!r.ok){ throw new Error("limit "+r.status); }
  var v=await r.json();
  return v==="ok";
}
async function llm(system,user,maxTokens){
  if(ANTHROPIC_KEY){
    var r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"content-type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:Deno.env.get("MENBU_ANTHROPIC_MODEL")||"claude-haiku-5-5",max_tokens:maxTokens,system:system,messages:[{role:"user",content:user}]})});
    if(!r.ok){ throw new Error("claude "+r.status); }
    var j=await r.json();
    return (j.content||[]).filter(function(b){ return b.type==="text"; }).map(function(b){ return b.text; }).join("");
  }
  var r2=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json",Authorization:"Bearer "+OPENAI_KEY},body:JSON.stringify({model:Deno.env.get("MENBU_OPENAI_MODEL")||"gpt-4o-mini",messages:[{role:"system",content:system},{role:"user",content:user}]})});
  if(!r2.ok){ throw new Error("openai "+r2.status); }
  var j2=await r2.json();
  return (j2.choices&&j2.choices[0]&&j2.choices[0].message&&j2.choices[0].message.content)||"";
}
function pickJson(text){ var m=String(text||"").match(/\{[\s\S]*\}/); try{ return m?JSON.parse(m[0]):null; }catch(e){ return null; } }
async function geocode(q){
  try{
    var r=await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=jp&accept-language=ja&viewbox=139.3,45.6,145.9,41.3&q="+encodeURIComponent(q),{headers:{"user-agent":"menbu-map/1.0 (START RIGHT)"}});
    var j=r.ok?await r.json():[];
    if(j.length){ return {lat:+j[0].lat,lon:+j[0].lon}; }
  }catch(e){}
  try{
    var r2=await fetch("https://msearch.gsi.go.jp/address-search/AddressSearch?q="+encodeURIComponent(q));
    var j2=r2.ok?await r2.json():[];
    if(j2.length){ return {lat:j2[0].geometry.coordinates[1],lon:j2[0].geometry.coordinates[0]}; }
  }catch(e){}
  return null;
}
async function hotpepper(key,lat,lon,food,range){
  async function call(extra){
    var u=new URL("https://webservice.recruit.co.jp/hotpepper/gourmet/v1/");
    u.searchParams.set("key",key); u.searchParams.set("lat",String(lat)); u.searchParams.set("lng",String(lon));
    u.searchParams.set("range",String(range)); u.searchParams.set("count","20"); u.searchParams.set("format","json"); u.searchParams.set("order","4");
    Object.keys(extra).forEach(function(k){ u.searchParams.set(k,extra[k]); });
    var r=await fetch(u,{headers:{accept:"application/json","user-agent":"menbu-map/1.0"}});
    if(!r.ok){ throw new Error("hotpepper "+r.status); }
    var j=await r.json();
    return (j&&j.results&&Array.isArray(j.results.shop))?j.results.shop:[];
  }
  var shops=food?await call({keyword:food.slice(0,60)}):[];
  if(!shops.length){ shops=await call({genre:"G013"}); }
  return shops.map(function(s){
    var la=Number(s.lat), lo=Number(s.lng), mi=matchMenbu(s.name||"",la,lo);
    return {name:s.name||"",address:s.address||"",access:String(s.access||"").slice(0,60),hours:String(s.open||"").slice(0,70),genre:(s.genre&&s.genre.name)||"",catchcopy:String(s.catch||(s.genre&&s.genre.catch)||"").slice(0,60),budget:(s.budget&&(s.budget.average||s.budget.name))||"",uri:(s.urls&&s.urls.pc)||"",lat:la,lon:lo,menbu:mi>=0,mi:mi,note:mi>=0?MENBU[mi][1]:"",d:Math.round(dist(lat,lon,la,lo))};
  }).filter(function(s){ return Number.isFinite(s.lat)&&Number.isFinite(s.lon); });
}
function menbuCandidates(lat,lon,maxD){
  var out=[];
  SEEDS.forEach(function(s){
    var m=MENBU[s[0]], d=(lat!=null)?Math.round(dist(lat,lon,s[1],s[2])):null;
    if(maxD&&d!=null&&d>maxD){ return; }
    out.push({name:m[0],address:AREA[s[0]]||"",access:"",hours:"",genre:"",catchcopy:"",budget:"",uri:"https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(m[0]+" "+(AREA[s[0]]||"")),lat:s[1],lon:s[2],menbu:true,mi:s[0],note:m[1],d:d});
  });
  if(lat!=null){ out.sort(function(a,b){ return a.d-b.d; }); }
  return out;
}
// ===== 近くの麺の店（地図の「ほかの麺の店」用。ホットペッパーから取る。AIは使わないので費用はかからない） =====
var NEAR_CACHE = new Map();
async function hpNear(key,lat,lon,r,kw){
  var range=r<=300?1:r<=500?2:r<=1000?3:r<=2000?4:5;
  var ck=lat.toFixed(3)+","+lon.toFixed(3)+","+range+","+(kw||"");
  var hit=NEAR_CACHE.get(ck);
  if(hit&&Date.now()-hit.t<600000){ return hit.v; }
  async function call(extra){
    var u=new URL("https://webservice.recruit.co.jp/hotpepper/gourmet/v1/");
    u.searchParams.set("key",key); u.searchParams.set("lat",String(lat)); u.searchParams.set("lng",String(lon));
    u.searchParams.set("range",String(range)); u.searchParams.set("count","100"); u.searchParams.set("format","json");
    Object.keys(extra).forEach(function(k){ u.searchParams.set(k,extra[k]); });
    var res=await fetch(u,{headers:{accept:"application/json","user-agent":"menbu-map/1.0"}});
    if(!res.ok){ throw new Error("hotpepper "+res.status); }
    var j=await res.json();
    return (j&&j.results&&Array.isArray(j.results.shop))?j.results.shop:[];
  }
  // 味の言葉（豚骨・味噌など）があれば、ラーメンの店をその言葉で探した結果を先に入れて「合う店」の印をつける
  var lists=await Promise.all([kw?call({genre:"G013",keyword:kw}).catch(function(){ return []; }):Promise.resolve([]),call({genre:"G013"}),call({keyword:"そば"}).catch(function(){ return []; }),call({keyword:"うどん"}).catch(function(){ return []; })]);
  var seen={}, out=[];
  lists.forEach(function(arr,li0){
    var li=li0===0?0:li0-1, hitKw=li0===0;
    arr.forEach(function(s){
      if(seen[s.id]){ return; }
      if(li>0&&!/そば|蕎麦|ソバ|うどん|饂飩|ウドン|麺/.test(String(s.name||""))){ return; }
      seen[s.id]=1;
      var la=Number(s.lat), lo=Number(s.lng);
      if(!Number.isFinite(la)||!Number.isFinite(lo)){ return; }
      out.push({name:String(s.name||"").slice(0,60),lat:la,lon:lo,kind:li===0?"ラーメン":(li===1?"そば":"うどん"),genre:(s.genre&&s.genre.name)||"",uri:(s.urls&&s.urls.pc)||"",kwhit:hitKw||undefined});
    });
  });
  if(NEAR_CACHE.size>300){ NEAR_CACHE.clear(); }
  NEAR_CACHE.set(ck,{t:Date.now(),v:out});
  return out;
}
// ===== 麺部Tシャツの予約（部員向け。支払いは例会で手渡し） =====
var EV_OK = {visit:1,search:1,card:1,route:1,share_line:1,share_copy:1,share_open:1,zero:1,went:1,want:1,stamps:1,ai:1};
var REPORT_REASONS = ["閉店している","場所がちがう","麺の店ではない","その他"];
var TS_IP_CAP = 5; // 同じ相手からの予約は1日5件まで
function jstToday(){ return new Date(Date.now()+9*3600*1000).toISOString().slice(0,10); }
async function tshirtConfig(){
  var r=await rest("menbu_tshirt_config?id=eq.1&select=open,title,price,deadline,sizes,colors,handover,note");
  var rows=r.ok?await r.json():[]; return rows[0]||null;
}
function tshirtOpen(c){ return !!(c&&c.open&&c.price&&c.deadline&&jstToday()<=c.deadline); }
async function tshirtTotal(){
  var r=await rest("menbu_tshirt_orders?status=neq.canceled&select=qty");
  var rows=r.ok?await r.json():[]; return rows.reduce(function(s,x){ return s+(x.qty||0); },0);
}
function clean(s,n){ return String(s==null?"":s).replace(/[\u0000-\u001f\u007f<>]/g," ").trim().slice(0,n); }
async function tshirtOrder(req,origin,body){
  var c=await tshirtConfig();
  if(!tshirtOpen(c)){ return reply(origin,409,{error:"closed"}); }
  var name=clean(body.name,30), contact=clean(body.contact,40), size=clean(body.size,10), color=clean(body.color,20), note=clean(body.note,100);
  var qty=Number(body.qty);
  if(!name){ return reply(origin,400,{error:"name"}); }
  if((c.sizes||[]).indexOf(size)<0){ return reply(origin,400,{error:"size"}); }
  if((c.colors||[]).length&&(c.colors||[]).indexOf(color)<0){ return reply(origin,400,{error:"color"}); }
  if(!(Number.isInteger(qty)&&qty>=1&&qty<=5)){ return reply(origin,400,{error:"qty"}); }
  var ih=await clientKey(req);
  var since=new Date(Date.now()-24*3600*1000).toISOString();
  var cr=await rest("menbu_tshirt_orders?ip_hash=eq."+ih+"&created_at=gte."+encodeURIComponent(since)+"&select=id");
  var recent=cr.ok?await cr.json():[];
  if(recent.length>=TS_IP_CAP){ return reply(origin,429,{error:"cap"}); }
  var ir=await rest("menbu_tshirt_orders",{method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify({name:name,contact:contact,size:size,color:color,qty:qty,note:note,ip_hash:ih})});
  if(!ir.ok){ return reply(origin,502,{error:"save"}); }
  var row=(await ir.json())[0]||{};
  return reply(origin,200,{ok:true,no:row.id,total:qty*c.price});
}
// ===== 麺部の予定・出欠（名前で参加／不参加を入れる） =====
async function meetupsList(){
  var since=new Date(Date.now()-7*24*3600*1000).toISOString().slice(0,10);
  var r=await rest("menbu_meetups?day=gte."+since+"&select=id,day,title,note&order=day.asc");
  var rows=r.ok?await r.json():[];
  if(!rows.length){ return []; }
  var ids=rows.map(function(x){ return x.id; }).join(",");
  var rr=await rest("menbu_rsvp?meetup_id=in.("+ids+")&select=meetup_id,name,status&order=created_at.asc");
  var rsvps=rr.ok?await rr.json():[];
  return rows.map(function(m){
    // 公開ページには名前を出さない。人数だけ返す
    var yes=rsvps.filter(function(x){ return x.meetup_id===m.id&&x.status==="yes"; }).length;
    var no=rsvps.filter(function(x){ return x.meetup_id===m.id&&x.status==="no"; }).length;
    return {id:m.id,day:m.day,title:m.title,note:m.note,yes:yes,no:no};
  });
}
async function rsvpSet(req,origin,body){
  var mid=Number(body.meetup_id), name=clean(body.name,30), status=String(body.status||"");
  if(!(Number.isInteger(mid)&&mid>0)){ return reply(origin,400,{error:"meetup"}); }
  if(!name){ return reply(origin,400,{error:"name"}); }
  if(status!=="yes"&&status!=="no"){ return reply(origin,400,{error:"status"}); }
  var ih=await clientKey(req);
  var ir=await rest("menbu_rsvp?on_conflict=meetup_id,name",{method:"POST",headers:{Prefer:"resolution=merge-duplicates"},body:JSON.stringify({meetup_id:mid,name:name,status:status,ip_hash:ih,updated_at:new Date().toISOString()})});
  if(!ir.ok){ return reply(origin,502,{error:"save"}); }
  return reply(origin,200,{ok:true});
}
Deno.serve(async function(req){
  var origin=req.headers.get("origin");
  if(req.method==="OPTIONS"){ return new Response(null,{status:204,headers:cors(origin)}); }
  var hasLlm=!!(ANTHROPIC_KEY||OPENAI_KEY);
  try{ await loadShops(); }catch(e){}
  if(req.method==="GET"){
    var sp=new URL(req.url).searchParams;
    if(sp.get("near")){
      if(!origin||!ORIGIN_RE.test(origin)){ return reply(origin,403,{error:"origin"}); }
      var nla=Number(sp.get("lat")), nlo=Number(sp.get("lon")), nr=Number(sp.get("r"))||1000;
      if(!(nla>20&&nla<46.5&&nlo>122&&nlo<154.5)){ return reply(origin,400,{error:"where"}); }
      try{
        var nk=await hotpepperKey();
        if(!nk){ return reply(origin,503,{error:"setup"}); }
        var nkw=String(sp.get("kw")||"").replace(/[\u0000-\u001f<>"'&]/g,"").trim().slice(0,20);
        return reply(origin,200,{shops:await hpNear(nk,nla,nlo,Math.min(Math.max(nr,300),5000),nkw)});
      }catch(e){ console.error("near",String((e&&e.message)||e)); return reply(origin,502,{error:"upstream"}); }
    }
    if(sp.get("gplaces")){
      // 近くの麺の店をGoogleで探してよいか（回数の札）。ページはokのときだけGoogleに聞く
      if(!origin||!ORIGIN_RE.test(origin)){ return reply(origin,403,{error:"origin"}); }
      var okp=false;
      try{ var pr=await rest("rpc/menbu_gplaces_hit",{method:"POST",body:JSON.stringify({p_cap:GPLACES_DAY_CAP})}); okp=pr.ok&&(await pr.json())===true; }catch(e){}
      return reply(origin,200,{ok:okp});
    }
    if(sp.get("meetups")){
      try{ return reply(origin,200,{meetups:await meetupsList()}); }catch(e){ console.error("meetups",String((e&&e.message)||e)); return reply(origin,502,{error:"upstream"}); }
    }
    if(new URL(req.url).searchParams.get("tshirt")){
      try{
        var c=await tshirtConfig();
        if(!c){ return reply(origin,200,{open:false}); }
        return reply(origin,200,{open:tshirtOpen(c),title:c.title,price:c.price,deadline:c.deadline,sizes:c.sizes,colors:c.colors,handover:c.handover,note:c.note,total:await tshirtTotal()});
      }catch(e){ return reply(origin,200,{open:false}); }
    }
    if(new URL(req.url).searchParams.get("shops")){
      // Googleマップの読み込みは1日300回まで（月1万回の無料枠に収める）。超えた日は国土地理院の地図で動く
      var gk=(origin&&ORIGIN_RE.test(origin))?(Deno.env.get("GOOGLE_MAPS_BROWSER_KEY")||""):"";
      if(gk){ try{ var gr=await rest("rpc/menbu_gmaps_hit",{method:"POST",body:JSON.stringify({p_cap:GMAPS_DAY_CAP})}); if(!gr.ok||(await gr.json())!==true){ gk=""; } }catch(e){ gk=""; } }
      return reply(origin,200,{shops:MENBU,seeds:SEEDS,area:AREA,gmaps:gk});
    }
    var hk=""; try{ hk=await hotpepperKey(); }catch(e){}
    return reply(origin,200,{ok:true,llm:ANTHROPIC_KEY?"anthropic":(OPENAI_KEY?"openai":"none"),hotpepper:!!hk});
  }
  if(req.method!=="POST"){ return reply(origin,405,{error:"method"}); }
  if(!origin||!ORIGIN_RE.test(origin)){ return reply(origin,403,{error:"origin"}); }
  var body; try{ body=await req.json(); }catch(e){ return reply(origin,400,{error:"bad"}); }
  // 使われ方の数（名前なし・種類ごとに1日の回数だけ）と「情報がちがう」の報告
  if(body&&body.action==="ev"){
    var ev=String(body.ev||"");
    if(!EV_OK[ev]){ return reply(origin,400,{error:"ev"}); }
    try{ await rest("rpc/menbu_event_hit",{method:"POST",body:JSON.stringify({p_ev:ev})}); }catch(e){}
    return reply(origin,200,{ok:true});
  }
  if(body&&body.action==="report"){
    try{
      var rname=clean(body.name,60), reason=clean(body.reason,20), rla=Number(body.lat), rlo=Number(body.lon);
      if(!rname||REPORT_REASONS.indexOf(reason)<0){ return reply(origin,400,{error:"bad"}); }
      var rih=await clientKey(req), rsince=new Date(Date.now()-24*3600*1000).toISOString();
      var rc=await rest("menbu_reports?ip_hash=eq."+rih+"&created_at=gte."+encodeURIComponent(rsince)+"&select=id");
      var rrows=rc.ok?await rc.json():[];
      if(rrows.length>=10){ return reply(origin,429,{error:"cap"}); }
      var ri=await rest("menbu_reports",{method:"POST",body:JSON.stringify({name:rname,lat:Number.isFinite(rla)?rla:null,lon:Number.isFinite(rlo)?rlo:null,reason:reason,ip_hash:rih})});
      if(!ri.ok){ return reply(origin,502,{error:"save"}); }
      try{ await rest("rpc/menbu_event_hit",{method:"POST",body:JSON.stringify({p_ev:"report"})}); }catch(e){}
      return reply(origin,200,{ok:true});
    }catch(e){ return reply(origin,502,{error:"upstream"}); }
  }
  if(body&&body.action==="tshirt"){ try{ return await tshirtOrder(req,origin,body); }catch(e){ console.error("tshirt",String((e&&e.message)||e)); return reply(origin,502,{error:"upstream"}); } }
  if(body&&body.action==="rsvp"){ try{ return await rsvpSet(req,origin,body); }catch(e){ console.error("rsvp",String((e&&e.message)||e)); return reply(origin,502,{error:"upstream"}); } }
  if(!hasLlm){ return reply(origin,503,{error:"setup",missing:"llm"}); }
  var q=String((body&&body.q)||"").trim().slice(0,200);
  if(!q){ return reply(origin,400,{error:"empty"}); }
  var only=!!body.only;
  var lat=Number(body.lat), lon=Number(body.lon);
  var here=(lat>20&&lat<50&&lon>120&&lon<150);
  if(!here){ lat=null; lon=null; }
  try{
    if(!(await underCap(req))){ return reply(origin,429,{error:"cap"}); }
    var place="", food="", haveParsed=(typeof body.place==="string"&&typeof body.food==="string");
    if(haveParsed){ place=body.place.slice(0,40); food=body.food.slice(0,40); }
    else{
      var parsed=pickJson(await llm("利用者の質問から、探したい場所と食べたいものを抜き出します。出力はJSONだけ：{\"place\":\"駅名・地名・施設名。現在地や近くとだけ言っている場合や、場所の指定がない場合は空文字\",\"food\":\"麺の種類や味（例：つけ麺、味噌ラーメン、そば）。指定がなければ空文字\"}","質問："+q,200))||{};
      place=String(parsed.place||"").slice(0,40); food=String(parsed.food||"").slice(0,40);
    }
    if(body.stage==="parse"){ return reply(origin,200,{place:place,food:food}); }
    var point=null, usedPlace="";
    var plat=Number(body.plat), plon=Number(body.plon);
    if(place&&plat>20&&plat<50&&plon>120&&plon<150){ point={lat:plat,lon:plon}; usedPlace=place; }
    else if(place){ point=await geocode(place); if(point){ usedPlace=place; } }
    if(!point&&here){ point={lat:lat,lon:lon}; }
    var cands;
    if(only){
      cands=menbuCandidates(point?point.lat:null,point?point.lon:null,0);
    }else{
      if(!point){ return reply(origin,200,{lead:"場所が分かりませんでした。「札幌駅の近くで」のように場所を入れるか、「現在地から探す」を押してから聞いてください。",items:[],source:"none"}); }
      var key=await hotpepperKey();
      if(!key){ return reply(origin,503,{error:"setup",missing:"hotpepper"}); }
      var hp=await hotpepper(key,point.lat,point.lon,food,usedPlace?4:3);
      var used={}; hp.forEach(function(s){ if(s.mi>=0){ used[s.mi]=1; } });
      cands=menbuCandidates(point.lat,point.lon,2000).filter(function(c){ return !used[c.mi]; }).concat(hp).slice(0,28);
    }
    if(!cands.length){ return reply(origin,200,{lead:"条件に合う店が見つかりませんでした。場所や言葉を変えて聞いてみてください。",items:[],source:only?"menbu":"hotpepper"}); }
    var lines=cands.map(function(c,i){
      return i+": "+c.name+" / "+(c.address||"場所不明")+(c.d!=null?" / "+(usedPlace?usedPlace+"から":"質問者から")+c.d+"m":"")+(c.genre?" / "+c.genre:"")+(c.catchcopy?" / "+c.catchcopy:"")+(c.hours?" / 営業："+c.hours:"")+(c.budget?" / 予算"+c.budget:"")+(c.menbu?" / 麺部の投稿あり"+(c.note?"（"+c.note+"）":""):" / 麺部は未開拓");
    }).join("\n");
    var a=pickJson(await llm("あなたは札幌の麺好きの集まり「麺部」の案内役です。下の候補一覧だけを根拠に、質問に合う店を最大4軒、近い順を基本に選びます。麺の店でない候補は選びません。理由は、一覧に書いてあること（距離・ジャンル・紹介文・営業時間・麺部のメモ）だけで書きます。一覧にない味・名物・評判・人気は書きません。質問の麺を出す店かどうかが一覧から分からない店は、理由に「〜があるかは未確認」と書きます。麺部の投稿がある店は、条件に合うなら優先します。合う店がなければ picks を空にして lead でそう伝えます。出力はJSONだけ：{\"lead\":\"全体のひとこと（60字以内）\",\"picks\":[{\"i\":候補番号,\"why\":\"薦める理由（50字以内）\"}]}","質問："+q+"\n"+(only?"（麺部の投稿がある店だけから選ぶ）\n":"")+"候補一覧：\n"+lines,700))||{lead:"",picks:[]};
    var items=(a.picks||[]).filter(function(p){ return Number.isInteger(p.i)&&p.i>=0&&p.i<cands.length; }).slice(0,4).map(function(p){
      var c=cands[p.i];
      return {name:c.name,address:c.address,access:c.access,hours:c.hours,budget:c.budget,uri:c.uri,menbu:c.menbu,note:c.note,d:c.d,from:usedPlace,lat:c.lat,lon:c.lon,why:String(p.why||"").slice(0,120)};
    });
    return reply(origin,200,{lead:String(a.lead||"").slice(0,200),items:items,source:only?"menbu":"hotpepper",place:usedPlace,food:food});
  }catch(e){
    console.error("menbu-ask",String((e&&e.message)||e));
    return reply(origin,502,{error:"upstream"});
  }
});
