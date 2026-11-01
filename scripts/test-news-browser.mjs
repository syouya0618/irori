// Synthetic HTTP/Auth only: not RLS, real Supabase, live RSS or device evidence.
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { chromium, expect } from "@playwright/test"
if (readdirSync(".").some(name => /^\.env(?:\.|$)/.test(name))) throw new Error("requires checkout without environment files")
const output = process.argv[2] || "/private/tmp/irori-news-shots"
mkdirSync(output, {recursive:true})
const uid="00000000-0000-4000-8000-000000000001",hid="00000000-0000-4000-8000-000000000010",now=new Date().toISOString()
const user={id:uid,aud:"authenticated",role:"authenticated",email:"fixture@example.invalid",app_metadata:{},user_metadata:{},created_at:now}
const b64=value=>Buffer.from(JSON.stringify(value)).toString("base64url")
const token=`${b64({alg:"HS256",typ:"JWT"})}.${b64({sub:uid,exp:Math.floor(Date.now()/1000)+7200,role:"authenticated"})}.c3ludGhldGlj`
let preference=null,claims=0
const statuses=["kakegawa-news","kakegawa-facilities","kakegawa-dining"].map(source_key=>({source_key,region_key:"kakegawa",claimed_at:null,last_success_at:now,last_error_at:null}))
const articles=[{id:"a".repeat(64),region_key:"kakegawa",source_key:"kakegawa-news",title:"合成ニュース・赤ちゃんの集い",url:"https://www.city.kakegawa.shizuoka.jp/kakekko/synthetic/infant.html",published_at:now,min_months:0,max_months:11},{id:"b".repeat(64),region_key:"kakegawa",source_key:"kakegawa-dining",title:"合成ニュース・小学生の集い",url:"https://www.city.kakegawa.shizuoka.jp/kakekko/synthetic/school.html",published_at:null,min_months:72,max_months:143}]
const api=createServer(async(req,res)=>{
 res.setHeader("Content-Type","application/json");res.setHeader("Access-Control-Allow-Origin","http://127.0.0.1:55438");res.setHeader("Access-Control-Allow-Headers","*");if(req.method==="OPTIONS")return res.end()
 const url=new URL(req.url,"http://127.0.0.1:55439");let data=[]
 let raw="";for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{}
 if(url.pathname==="/auth/v1/user")data=user
 if(url.pathname.endsWith("/profiles"))data=[{id:uid,household_id:hid,is_approved:true,role:"owner",display_name:"合成利用者",default_page:"baby"}]
 if(url.pathname.endsWith("/children"))data=[{id:"00000000-0000-4000-8000-000000000020",household_id:hid,birth_date:new Date(Date.now()-90*86400000).toISOString().slice(0,10),name:"合成児",updated_at:now,is_legacy:true}]
 if(url.pathname.endsWith("/news_preferences"))data=preference?[preference]:[]
 if(url.pathname.endsWith("/news_articles"))data=articles.filter(a=>url.searchParams.get("region_key")===`eq.${a.region_key}`)
 if(url.pathname.endsWith("/save_news_preferences")){preference={user_id:uid,region_key:body.p_region,enabled:body.p_enabled,updated_at:new Date().toISOString()};data={status:"saved"}}
 if(url.pathname.endsWith("/news_source_statuses"))data=preference?.region_key==="kakegawa"?statuses:[]
 if(url.pathname.endsWith("/claim_news_source")){claims++;data=false}
 if(Array.isArray(data)&&req.headers.accept?.includes("vnd.pgrst.object"))data=data[0]??null
 res.end(JSON.stringify(data))
})
await new Promise(resolve=>api.listen(55439,"127.0.0.1",resolve))
const env=Object.fromEntries(["PATH","HOME","TMPDIR","LANG"].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))
Object.assign(env,{NEXT_PUBLIC_SUPABASE_URL:"http://127.0.0.1:55439",NEXT_PUBLIC_SUPABASE_ANON_KEY:"synthetic-public-key",SUPABASE_SERVICE_ROLE_KEY:"synthetic-service-key",NEXT_PUBLIC_APP_URL:"http://127.0.0.1:55438",NEXT_TELEMETRY_DISABLED:"1",TZ:"UTC"})
const app=spawn("pnpm",["exec","next","start","-H","127.0.0.1","-p","55438"],{env,stdio:["ignore","pipe","pipe"]})
let browser, currentPage
try {
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("server readiness deadline")),30000);app.once("exit",()=>reject(new Error("server exited")));app.stdout.on("data",b=>{if(b.toString().includes("Ready in")){clearTimeout(timer);resolve()}})})
 const chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 browser=await chromium.launch(existsSync(chrome)?{executablePath:chrome}:{})
 for(const width of [390,1280]){
  preference=null
  const context=await browser.newContext({viewport:{width,height:844},locale:"ja-JP",timezoneId:"Asia/Tokyo",serviceWorkers:"block"})
  await context.route("**/*",route=>{const u=new URL(route.request().url());return u.hostname==="127.0.0.1"&&["55438","55439"].includes(u.port)?route.continue():route.abort()})
  const session={access_token:token,refresh_token:"synthetic",expires_at:Math.floor(Date.now()/1000)+7200,expires_in:7200,token_type:"bearer",user}
  await context.addCookies([{name:"sb-127-auth-token",value:`base64-${b64(session)}`,domain:"127.0.0.1",path:"/"}])
  await context.addInitScript(()=>localStorage.setItem("irori:tour-seen:v1","1"))
  const page=await context.newPage();currentPage=page;page.setDefaultTimeout(15000);page.on("pageerror",error=>console.error(error.message))
  await page.goto("http://127.0.0.1:55438/news")
  await expect(page.getByLabel("ニュースの地域")).toHaveValue("")
  await page.getByLabel("ニュースの地域").selectOption("kakegawa")
  await page.getByRole("button",{name:"ニュース設定を保存"}).click()
  await expect(page.getByRole("status")).toHaveText("保存しました")
  await expect(page.getByRole("link",{name:"合成ニュース・赤ちゃんの集い"})).toBeVisible()
  await expect(page.getByRole("link",{name:"合成ニュース・小学生の集い"})).toHaveCount(0)
  await page.getByRole("link",{name:"年齢の絞り込みを外す"}).click()
  await expect(page.getByRole("link",{name:"合成ニュース・小学生の集い"})).toBeVisible()
  await expect(page.getByText(/掲載日不明/).first()).toBeVisible()
  await page.getByRole("button",{name:"配信元から記事を更新"}).click()
  await expect(page.getByText("取得中、または直前に確認済みです。少し時間をおいて一覧を読み直してください。")).toBeVisible()
  await page.getByLabel("新着がある朝8時に通知する").check()
  await page.getByRole("button",{name:"ニュース設定を保存"}).click()
  await expect(page.getByText("保存しました",{exact:true})).toBeVisible()
  await page.reload()
  await expect(page.getByLabel("新着がある朝8時に通知する")).toBeChecked()
  await expect(page.getByLabel("ニュースの地域")).toHaveValue("kakegawa")
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error(`overflow ${width}`)
  await page.screenshot({path:`${output}/news-${width}.png`,fullPage:true})
  for(const region of ["sapporo","yokohama"]){await page.getByLabel("ニュースの地域").selectOption(region);await page.getByRole("button",{name:"ニュース設定を保存"}).click();await expect(page.getByText("保存しました",{exact:true})).toBeVisible();await expect(page.getByRole("link",{name:"合成ニュース・赤ちゃんの集い"})).toHaveCount(0)}
  await context.close()
 }
 if(claims!==6)throw new Error(`expected three cooldown claims per width, got ${claims}`)
 console.log("PASS synthetic news save/reload/filter/notification/region isolation/cooldown; widths 390,1280; no actual Supabase/RSS/device proof")
} catch(error) { if(currentPage){console.error(await currentPage.locator("body").innerText());await currentPage.screenshot({path:`${output}/failure.png`,fullPage:true})}throw error } finally {await browser?.close();app.kill("SIGTERM");api.closeAllConnections();api.close()}
