// Local rendering benchmark with synthetic HTTP fixtures. Never an Auth/RLS/Realtime/device acceptance test.
// Build with the synthetic loopback URL/key before running. No environment files or live providers are read.
import { createServer } from "node:http"
import { spawn,spawnSync } from "node:child_process"
import { writeFileSync,existsSync,mkdirSync } from "node:fs"
import { chromium } from "@playwright/test"
const args=process.argv.slice(2),output=args.find(a=>!a.startsWith("--")),trials=Number(args.find(a=>a.startsWith("--trials="))?.split("=")[1]??5)
if(!Number.isInteger(trials)||trials<3||trials>20)throw new Error("use 3..20 trials")
const source=spawnSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim()
if(spawnSync("git",["diff","--quiet","--","src","package.json","pnpm-lock.yaml","next.config.ts"]).status!==0)throw new Error("commit runtime sources before benchmarking")
const uid="00000000-0000-4000-8000-000000000001",hid="00000000-0000-4000-8000-000000000010",childId=n=>`00000000-0000-4000-8000-${String(20+n).padStart(12,"0")}`,cid=childId(0),now=new Date()
const user={id:uid,aud:"authenticated",role:"authenticated",email:"fixture@example.invalid",app_metadata:{},user_metadata:{},created_at:now.toISOString()}
const b64=v=>Buffer.from(JSON.stringify(v)).toString("base64url")
// Deliberately unsigned fixture JWT; only the isolated fake Auth service accepts this.
const token=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:uid,exp:Math.floor(Date.now()/1000)+7200,role:"authenticated"})}.c3ludGhldGlj`
const profile={id:uid,household_id:hid,is_approved:true,role:"owner",default_page:"baby",display_name:"テスト利用者A",avatar_url:null}
const household={id:hid,name:"架空の世帯A",baby_name:"テスト児A1",baby_birth_date:"2026-01-01",feeding_interval_min:180,bottle_default_ml:null}
let latency=0,rowCount=30,childCount=1,scope=0,active=0
const requests=[]
const api=createServer(async(req,res)=>{
 res.setHeader("Access-Control-Allow-Origin","http://127.0.0.1:55438");res.setHeader("Access-Control-Allow-Headers","*");res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");res.setHeader("Content-Type","application/json")
 if(req.method==="OPTIONS")return res.end()
 const url=new URL(req.url,"http://127.0.0.1:55439"),started=performance.now(),sample=scope,phase=req.headers.origin?"browser":"server";active++
 try{
  await new Promise(resolve=>setTimeout(resolve,latency));let data=[]
  if(url.pathname==="/auth/v1/user")data=user
  if(url.pathname.endsWith("/profiles"))data=[profile]
  if(url.pathname.endsWith("/households"))data=[household]
  if(url.pathname.endsWith("/children"))data=Array.from({length:childCount},(_,i)=>({id:childId(i),household_id:hid,name:`テスト児A${i+1}`,birth_date:"2026-01-01",sex:"female",is_legacy:i===0,feeding_interval_min:180,bottle_default_ml:i?110:null,created_at:now.toISOString(),updated_at:now.toISOString()}))
  if(url.pathname.endsWith("/baby_logs")){
   const selected=Array.from({length:childCount},(_,i)=>childId(i)).includes(req.headers["x-irori-child"])?req.headers["x-irori-child"]:cid
   const make=(i,type)=>({id:`00000000-0000-4000-8001-${String(i+1).padStart(12,"0")}`,household_id:hid,child_id:selected,logged_by:uid,log_type:type,feeding_type:type==="feeding"?"bottle":null,amount_ml:type==="feeding"?80:null,duration_min:null,duration_sec:null,breast_left_sec:null,breast_right_sec:null,breast_left_count:null,breast_right_count:null,breast_start_side:null,diaper_type:null,poop_amount:null,temperature:null,weight_g:type==="growth"?7600:null,height_cm:type==="growth"?70:null,memo:null,logged_at:new Date(now.getTime()-i*60000).toISOString(),created_at:now.toISOString(),updated_at:now.toISOString()})
   data=[...Array.from({length:rowCount},(_,i)=>make(i,"feeding")),make(rowCount,"growth")]
  }
  if(Array.isArray(data)){
   for(const [key,value]of url.searchParams){const [op,...rest]=value.split("."),v=rest.join(".");if(op==="eq")data=data.filter(r=>String(r[key])===v);if(op==="lt")data=data.filter(r=>Date.parse(r[key])<Date.parse(v));if(op==="gte"&&/date|at$/.test(key))data=data.filter(r=>Date.parse(r[key])>=Date.parse(v))}
   if(url.searchParams.has("limit"))data=data.slice(0,Number(url.searchParams.get("limit")))
  }
  if(url.pathname.includes("/rpc/"))data=url.pathname.endsWith("/is_app_operator")?false:url.pathname.endsWith("/list_child_shares")?[]:0
  if(Array.isArray(data)&&req.headers.accept?.includes("vnd.pgrst.object"))data=data[0]??null
  res.end(JSON.stringify(data))
 }finally{requests.push({sample,phase,path:url.pathname,start:started,end:performance.now()});active--}
})
await new Promise(resolve=>api.listen(55439,"127.0.0.1",resolve))
const childEnv=Object.fromEntries(["PATH","HOME","TMPDIR","LANG"].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
Object.assign(childEnv,{NEXT_PUBLIC_SUPABASE_URL:"http://127.0.0.1:55439",NEXT_PUBLIC_SUPABASE_ANON_KEY:"synthetic-public-key",NEXT_PUBLIC_APP_URL:"http://127.0.0.1:55438",NEXT_TELEMETRY_DISABLED:"1",TZ:"UTC"})
const app=spawn("pnpm",["exec","next","start","-H","127.0.0.1","-p","55438"],{env:childEnv,stdio:"ignore"})
let browser
const idle=async()=>{let quiet=0;for(let n=0;n<100;n++){await new Promise(r=>setTimeout(r,50));quiet=active===0?quiet+1:0;if(quiet>=2)return}throw new Error("fixture API did not settle")}
try{
 for(let i=0;i<100;i++){try{if((await fetch("http://127.0.0.1:55438/login",{signal:AbortSignal.timeout(1500)})).ok)break}catch{}if(i===99)throw new Error("local server did not start");await new Promise(r=>setTimeout(r,200))}
 const chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";browser=await chromium.launch(existsSync(chrome)?{executablePath:chrome}:{})
 const results=[],scenarios=[{name:"normal",latency:0,rows:30,children:1},{name:"many-records",latency:0,rows:800,children:1},{name:"multiple-children",latency:0,rows:30,children:4},{name:"slow-network",latency:200,rows:30,children:1,network:true}]
 for(const scenario of scenarios){latency=scenario.latency;rowCount=scenario.rows;childCount=scenario.children
  for(let trial=1;trial<=trials;trial++){
   const context=await browser.newContext({viewport:{width:390,height:844},locale:"ja-JP",timezoneId:"Asia/Tokyo",serviceWorkers:"block"})
   await context.route("**/*",route=>{const u=new URL(route.request().url());return u.hostname==="127.0.0.1"&&["55438","55439"].includes(u.port)?route.continue():route.abort()})
   const session={access_token:token,refresh_token:"synthetic",expires_at:Math.floor(Date.now()/1000)+7200,expires_in:7200,token_type:"bearer",user}
   await context.addCookies([{name:"sb-127-auth-token",value:`base64-${b64(session)}`,domain:"127.0.0.1",path:"/"},...(scenario.children>1?[{name:"irori-child",value:childId(1),domain:"127.0.0.1",path:"/"}]:[])])
   await context.addInitScript(()=>{localStorage.setItem("irori:tour-seen:v1","1");localStorage.setItem("irori:measure-performance:v1","1");window.__vitals=[];window.addEventListener("irori:web-vital",e=>window.__vitals.push(e.detail));window.__lcp=0;new PerformanceObserver(list=>{for(const e of list.getEntries())window.__lcp=e.startTime}).observe({type:"largest-contentful-paint",buffered:true})})
   const page=await context.newPage();page.setDefaultTimeout(30000)
   if(scenario.network){const cdp=await context.newCDPSession(page);await cdp.send("Network.enable");await cdp.send("Network.emulateNetworkConditions",{offline:false,latency:150,downloadThroughput:128*1024,uploadThroughput:64*1024,connectionType:"cellular3g"})}
   const ready=async(path,name)=>{await page.waitForURL(`**${path}`);await page.getByRole("navigation",{name:"メインナビゲーション"}).waitFor();if(path==="/baby")await page.locator("span").filter({hasText:new RegExp(`^${name}$`)}).first().waitFor();if(path==="/calendar")await page.getByRole("button",{name:"前の月",exact:true}).waitFor();if(path==="/settings"){await page.getByRole("heading",{name:"設定",exact:true}).waitFor();await page.getByLabel("表示名",{exact:true}).waitFor()}await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
   const sample=async(operation,action,path,name="テスト児A1")=>{
    await idle();const sampleId=++scope,start=performance.now();let instrumented=false
    if(!operation.startsWith("cold")){
     await page.evaluate(({target,name})=>{
      window.__sampleAbort?.abort();const controller=new AbortController();window.__sampleAbort=controller
      const current={at:null,feedback:null,ready:null};window.__tap=current;const previousPath=location.pathname
      const begin=()=>{
       if(current.at!==null)return;current.at=performance.now();controller.abort()
       const watch=()=>{
        if(current!==window.__tap)return
        const nav=document.querySelector('[aria-label="メインナビゲーション"]'),link=nav?.querySelector(`a[href="${target}"]`)
        const pending=nav?.getAttribute("aria-busy")==="true"||link?.querySelector('[data-navigation-pending="true"]')||[...document.querySelectorAll('[role="status"]')].some(e=>e.textContent?.includes("切り替え中"))
        if(current.feedback===null&&(pending||(previousPath!==target&&link?.getAttribute("aria-current")==="page")))current.feedback=performance.now()-current.at
        const content=location.pathname===target&&(target==="/calendar"?document.querySelector('[aria-label="前の月"]'):target==="/settings"?document.querySelector('#display_name'):[...document.querySelectorAll('span')].some(e=>e.textContent===name))
        if(content){current.ready=performance.now()-current.at;return}
        if(performance.now()-current.at<15000)requestAnimationFrame(watch)
       };requestAnimationFrame(watch)
      }
      document.addEventListener("pointerdown",begin,{once:true,capture:true,signal:controller.signal});document.addEventListener("change",begin,{once:true,capture:true,signal:controller.signal})
     },{target:path,name});instrumented=true
    }
    await action();await ready(path,name);const contentMs=performance.now()-start
    const render=await page.evaluate(({instrumented,cold})=>{const n=performance.getEntriesByType("navigation")[0];return {tapToReadyMs:instrumented&&window.__tap?.at!==null?window.__tap.ready??performance.now()-window.__tap.at:null,feedbackMs:window.__tap?.feedback??null,ttfbMs:cold&&n?n.responseStart-n.requestStart:null,fcpMs:cold?performance.getEntriesByName("first-contentful-paint")[0]?.startTime??null:null,lcpMs:cold?window.__lcp:null,vitals:window.__vitals??[],rscResources:performance.getEntriesByType("resource").filter(e=>e.name.includes("_rsc=")).map(e=>({path:new URL(e.name).pathname,start:e.startTime,ttfb:e.responseStart-e.startTime,transfer:e.responseEnd-e.responseStart}))}}, {instrumented,cold:operation.startsWith("cold")})
    await idle();const calls=requests.filter(r=>r.sample===sampleId),stats=phase=>{const xs=calls.filter(r=>r.phase===phase);return {requests:xs.length,sumMs:Math.round(xs.reduce((n,r)=>n+r.end-r.start,0)),spanMs:xs.length?Math.round(Math.max(...xs.map(r=>r.end))-Math.min(...xs.map(r=>r.start))):0}}
    results.push({scenario:scenario.name,trial,operation,contentMs:Math.round(contentMs),...render,server:stats("server"),browserApi:stats("browser")});console.log(`${scenario.name} ${trial}/${trials} ${operation}: ${Math.round(contentMs)}ms`)
   }
   const childName=scenario.children>1?"テスト児A2":"テスト児A1"
   await sample("cold-start",()=>page.goto("http://127.0.0.1:55438/baby"),"/baby",childName)
   for(const [operation,path,name]of [["baby-calendar","/calendar","予定"],["calendar-settings","/settings","設定"],["settings-baby","/baby","育児"]])await sample(operation,()=>page.getByRole("navigation",{name:"メインナビゲーション"}).getByRole("link",{name,exact:true}).click(),path,childName)
   await sample("back",()=>page.goBack(),"/settings")
   await sample("cold-settings",()=>page.goto("http://127.0.0.1:55438/settings"),"/settings")
   if(scenario.children>1){await page.goto("http://127.0.0.1:55438/baby");await ready("/baby",childName);await sample("switch-child",()=>page.getByLabel("記録する子ども").selectOption(cid),"/baby")}
   if(args.includes("--verify-ui")&&scenario.name==="normal"&&trial===1){
    const shots=args.find(a=>a.startsWith("--screenshots="))?.slice("--screenshots=".length);if(shots)mkdirSync(shots,{recursive:true})
    for(const width of [390,1280]){await page.setViewportSize({width,height:900});for(const [path,heading]of [["/baby/sleep","の睡眠"],["/baby/medical","の予防接種・健診"],["/baby/custom","のカスタム記録"],["/news","地域の子育てニュース"]]){await page.goto(`http://127.0.0.1:55438${path}`);await page.getByRole("heading",{name:new RegExp(heading)}).first().waitFor();if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error(`horizontal overflow ${path} ${width}`);if(shots)await page.screenshot({path:`${shots}/${path.replaceAll("/","-").slice(1)}-${width}.png`,fullPage:true})}}
   }
   await context.close()
  }
 }
 const percentile=(values,p)=>{const xs=[...values].sort((a,b)=>a-b);return xs[Math.ceil(xs.length*p)-1]}
 const groups=new Map();for(const r of results){const key=`${r.scenario}:${r.operation}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r)}
 const summary=[...groups].map(([key,rows])=>({key,n:rows.length,medianMs:percentile(rows.map(r=>r.contentMs),0.5),p95Ms:percentile(rows.map(r=>r.contentMs),0.95),medianTapMs:rows.every(r=>r.tapToReadyMs!==null)?percentile(rows.map(r=>r.tapToReadyMs),0.5):null,medianFeedbackMs:rows.every(r=>r.feedbackMs!==null)?percentile(rows.map(r=>r.feedbackMs),0.5):null,medianServerSpanMs:percentile(rows.map(r=>r.server.spanMs),0.5),medianServerRequests:percentile(rows.map(r=>r.server.requests),0.5)}))
 const result={source,method:"local production build; synthetic HTTP/Auth fixtures; Chrome 390px; SW blocked; external requests blocked; five fresh browser contexts per scenario by default; frame observer for tap readiness plus double animation-frame automation completion; p95 nearest rank (maximum with five trials); API span and sum are separate; not actual DB/Auth/Realtime/PWA/device proof",scenarios,trials,summary,results}
 if(output)writeFileSync(output,JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify({source,summary},null,2))
}finally{await browser?.close();app.kill("SIGTERM");api.closeAllConnections();api.close()}
