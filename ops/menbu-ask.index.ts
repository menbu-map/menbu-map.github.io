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
    var r=await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=jp&accept-language=ja&bounded=1&viewbox=139.3,45.6,145.9,41.3&q="+encodeURIComponent(q),{headers:{"user-agent":"menbu-map/1.0 (START RIGHT)"}});
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
Deno.serve(async function(req){
  var origin=req.headers.get("origin");
  if(req.method==="OPTIONS"){ return new Response(null,{status:204,headers:cors(origin)}); }
  var hasLlm=!!(ANTHROPIC_KEY||OPENAI_KEY);
  try{ await loadShops(); }catch(e){}
  if(req.method==="GET"){
    if(new URL(req.url).searchParams.get("shops")){ return reply(origin,200,{shops:MENBU,seeds:SEEDS}); }
    var hk=""; try{ hk=await hotpepperKey(); }catch(e){}
    return reply(origin,200,{ok:true,llm:ANTHROPIC_KEY?"anthropic":(OPENAI_KEY?"openai":"none"),hotpepper:!!hk});
  }
  if(req.method!=="POST"){ return reply(origin,405,{error:"method"}); }
  if(!origin||!ORIGIN_RE.test(origin)){ return reply(origin,403,{error:"origin"}); }
  if(!hasLlm){ return reply(origin,503,{error:"setup",missing:"llm"}); }
  var body; try{ body=await req.json(); }catch(e){ return reply(origin,400,{error:"bad"}); }
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
