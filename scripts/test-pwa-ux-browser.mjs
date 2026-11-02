// Local rendering benchmark with synthetic HTTP fixtures. Never an Auth/RLS/Realtime/device acceptance test.
// Build with the synthetic loopback URL/key before running. No environment files or live providers are read.
import { createServer } from "node:http"
import { spawn,spawnSync } from "node:child_process"
import { writeFileSync,mkdirSync,readdirSync } from "node:fs"
import { chromium, webkit, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
if(readdirSync(".").some(name=>/^\.env(?:\.|$)/.test(name)))throw new Error("measurement requires a checkout without environment files")
const output=process.argv[2];if(!output)throw new Error("output directory required")
mkdirSync(output,{recursive:true})
const source=spawnSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim()
const uid="00000000-0000-4000-8000-000000000001",hid="00000000-0000-4000-8000-000000000010",childId=n=>`00000000-0000-4000-8000-${String(20+n).padStart(12,"0")}`,cid=childId(0),now=new Date()
const user={id:uid,aud:"authenticated",role:"authenticated",email:"fixture@example.invalid",app_metadata:{},user_metadata:{},created_at:now.toISOString()}
const b64=v=>Buffer.from(JSON.stringify(v)).toString("base64url")
// Deliberately unsigned fixture JWT; only the isolated fake Auth service accepts this.
const token=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:uid,exp:Math.floor(Date.now()/1000)+7200,role:"authenticated"})}.c3ludGhldGlj`
const profile={id:uid,household_id:hid,is_approved:true,role:"owner",default_page:"baby",display_name:"テスト利用者A",avatar_url:null}
const household={id:hid,name:"架空の世帯A",baby_name:"テスト児A1",baby_birth_date:"2026-01-01",feeding_interval_min:180,bottle_default_ml:null}
let latency=0,rowCount=30,childCount=1,scope=0
const requests=[]
const api=createServer(async(req,res)=>{
 res.setHeader("Access-Control-Allow-Origin","http://127.0.0.1:55438");res.setHeader("Access-Control-Allow-Headers","*");res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");res.setHeader("Content-Type","application/json")
 if(req.method==="OPTIONS")return res.end()
 const url=new URL(req.url,"http://127.0.0.1:55439"),started=performance.now(),sample=scope,phase=req.headers.origin?"browser":"server"
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
 }finally{requests.push({sample,phase,path:url.pathname,start:started,end:performance.now()})}
})
await new Promise(resolve=>api.listen(55439,"127.0.0.1",resolve))
const childEnv=Object.fromEntries(["PATH","HOME","TMPDIR","LANG"].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
Object.assign(childEnv,{NEXT_PUBLIC_SUPABASE_URL:"http://127.0.0.1:55439",NEXT_PUBLIC_SUPABASE_ANON_KEY:"synthetic-public-key",NEXT_PUBLIC_APP_URL:"http://127.0.0.1:55438",NEXT_TELEMETRY_DISABLED:"1",TZ:"UTC"})
const app=spawn("pnpm",["exec","next","start","-H","127.0.0.1","-p","55438"],{env:childEnv,stdio:["ignore","pipe","pipe"]})
let readyOutput="";app.stdout.on("data",chunk=>{readyOutput=(readyOutput+chunk.toString()).slice(-2000)});app.stderr.on("data",()=>{})
let browser

const findings=[]
try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("server readiness deadline")),30000);app.once("exit",()=>reject(new Error("server exited")));app.stdout.on("data",b=>{if(b.toString().includes("Ready in")){clearTimeout(timer);resolve()}})})
 for(const [engineName,engine] of Object.entries({chromium,webkit})){
  browser=await engine.launch()
  for(const [width,scheme,large]of (process.argv.includes("--narrow")?[[320,"dark",true]]:[[390,"light",false],[320,"dark",true],[768,"light",false],[1280,"dark",false]])){
   childCount=2
   const context=await browser.newContext({viewport:{width,height:844},colorScheme:scheme,locale:"ja-JP",timezoneId:"Asia/Tokyo",serviceWorkers:"block",hasTouch:true})
   await context.route("**/*",r=>{const u=new URL(r.request().url());return u.hostname==="127.0.0.1"&&["55438","55439"].includes(u.port)?r.continue():r.abort()})
   const session={access_token:token,refresh_token:"synthetic",expires_at:Math.floor(Date.now()/1000)+7200,expires_in:7200,token_type:"bearer",user}
   await context.addCookies([{name:"sb-127-auth-token",value:`base64-${b64(session)}`,domain:"127.0.0.1",path:"/"}]);await context.addInitScript(()=>localStorage.setItem("irori:tour-seen:v1","1"))
   const page=await context.newPage();page.setDefaultTimeout(20000);const errors=[];page.on("pageerror",e=>errors.push(e.message))
   for(const [route,heading]of [["/baby",""],["/baby/sleep","睡眠"],["/baby/medical","予防接種"],["/children/sharing","閲覧"],["/news","地域の子育てニュース"],["/settings","設定"]]){
    await page.goto("http://127.0.0.1:55438"+route);await page.getByRole("navigation",{name:"メインナビゲーション"}).waitFor()
    if(process.argv.includes("--narrow")&&route!=="/baby")continue
    if(heading)await page.getByRole("heading",{name:new RegExp(heading)}).first().waitFor()
    if(large)await page.addStyleTag({content:"html { font-size: 200% !important; }"})
    if(route==="/baby"){
     await page.getByRole("button",{name:"搾乳",exact:true}).click();await page.getByRole("dialog").waitFor();await page.getByRole("button",{name:"閉じる",exact:true}).last().click();await expect(page.getByRole("dialog")).toBeHidden()
     await page.getByLabel("記録する子ども").selectOption(childId(1));if(engineName==="chromium")await expect(page.locator("span").filter({hasText:/^テスト児A2$/}).first()).toBeVisible();else {await expect(page.getByLabel("記録する子ども")).toBeEnabled();findings.push({engine:engineName,width,route:"/baby",check:"child-switch",status:(await context.cookies()).some(c=>c.name==="irori-child")?"OBSERVED":"BLOCKED",reason:"WebKit on HTTP loopback does not retain production Secure cookie; HTTPS/device acceptance required"})}

    }
    if(route==="/settings"){await page.getByRole("button",{name:"更新履歴を見る"}).click();const check=page.getByRole("button",{name:"新しい版を確かめる"});await expect(check).toBeEnabled();await expect.poll(()=>check.evaluate(e=>getComputedStyle(e).opacity)).toBe("1")}
    const geometry=await page.evaluate(()=>({inner:innerWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth,viewport:visualViewport?.width}));const overflow=geometry.scroll>geometry.inner
    const axe=await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21aa","wcag22aa"]).analyze()
    const targets=await page.locator("a,button,input,select").evaluateAll(es=>es.filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height}).map(e=>{const r=e.getBoundingClientRect();return {label:(e.textContent||e.getAttribute("aria-label")||e.tagName).trim().slice(0,50),w:Math.round(r.width),h:Math.round(r.height)}})).catch(()=>[])
    findings.push({engine:engineName,width,scheme,large,route,geometry,overflow,textOverflow:overflow?await page.evaluate(()=>{const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),out=[];for(let n=w.nextNode();n;n=w.nextNode()){if(!n.textContent.trim())continue;const r=document.createRange();r.selectNodeContents(n);if(r.getBoundingClientRect().right>innerWidth+1)out.push({text:n.textContent.slice(0,40),parent:n.parentElement.className,right:r.getBoundingClientRect().right})}return out}):[],violations:axe.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,html:n.html,summary:n.failureSummary}))})),overflowElements:overflow?await page.locator("body *").evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right}))):[],smallTargets:targets.filter(t=>t.h<24||t.w<24),pageErrors:[...errors]})
    if(width===390||width===320)await page.screenshot({path:`${output}/${engineName}-${width}-${route.replaceAll("/","-")}.png`,fullPage:true})
   }
   const manifest=await(await context.request.get("http://127.0.0.1:55438/manifest.webmanifest")).json();expect(manifest.start_url).toBe("/");expect(manifest.display).toBe("standalone")
   writeFileSync(`${output}/results.json`,JSON.stringify({source,findings},null,2));await context.close()
  }
  await browser.close();browser=null
 }
 browser=await chromium.launch()
 const swContext=await browser.newContext({serviceWorkers:"allow"})
 const offline=await swContext.newPage();await offline.goto("http://127.0.0.1:55438/offline")
 await expect.poll(()=>offline.evaluate(()=>!!navigator.serviceWorker.controller)).toBe(true)
 await swContext.setOffline(true);await offline.reload();await expect(offline.getByRole("heading")).toContainText("オフライン")
 await swContext.setOffline(false);await offline.reload();findings.push({check:"actual-service-worker-offline-online",engine:"chromium",status:"PASS",scope:"synthetic local offline document only"});await swContext.close();await browser.close();browser=null
 writeFileSync(`${output}/results.json`,JSON.stringify({source,method:"synthetic HTTP, no real auth/database/writes; Chromium/WebKit not iPhone; 200% CSS text approximation not OS text-size",findings},null,2))
 console.log(JSON.stringify({screens:findings.length,overflow:findings.filter(f=>f.overflow).length,axe:findings.filter(f=>f.violations?.length).map(f=>({route:f.route,width:f.width,engine:f.engine,ids:f.violations.map(v=>v.id)})),pageErrors:findings.filter(f=>f.pageErrors?.length).length}))
}finally{await browser?.close();app.kill("SIGTERM");api.closeAllConnections();api.close()}
