import { createRequire } from "node:module"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import path from "node:path"
const repo=fileURLToPath(new URL("..",import.meta.url))
const require=createRequire(repo+"/package.json")
const ts=require("typescript")
const {chromium,webkit}=require("@playwright/test")
const hashModules=path.join(path.dirname(require.resolve("@noble/hashes/sha2.js")),"esm")
const origin="http://127.0.0.1:55438"
const previousSource=execFileSync("git",["show","83bc267336db6c2199f1ffa0c5c737c03809aaec:src/lib/domain/record-requests.ts"],{cwd:repo,encoding:"utf8"})
const results=[]
try{
for(const [name,engine] of Object.entries({chromium,webkit})){
 const profile=mkdtempSync(path.join(tmpdir(),"irori-replay-"+name+"-"))
 let context
 try {
 context=await engine.launchPersistentContext(profile)
 const configure=async context=>context.route("**/*",async route=>{
  if(new URL(route.request().url()).origin!==origin)throw Error("external network forbidden")
  const pathname=new URL(route.request().url()).pathname
  if(pathname==="/"){await route.fulfill({contentType:"text/html",body:"<!doctype html><title>synthetic storage lab</title>"});return}
  if(/^\/vendor\/noble\/[a-z0-9_]+\.js$/.test(pathname)){
   const code=readFileSync(path.join(hashModules,path.posix.basename(pathname)),"utf8").replaceAll("'@noble/hashes/crypto'","'/vendor/noble/crypto.js'")
   await route.fulfill({contentType:"text/javascript",body:code});return
  }
  if(!pathname.startsWith("/src/")||!pathname.endsWith(".js")||pathname.includes(".."))throw Error("unexpected module")
  const filename=repo+pathname.replace(/\.js$/,".ts")
  let code=ts.transpileModule(pathname==="/src/lib/domain/legacy-record-requests.js"?previousSource:readFileSync(filename,"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
  code=code.replace(/from\s*["']([^"']+)["']/g,(match,specifier)=>{
   if(specifier.startsWith("@noble/hashes/"))return 'from "/vendor/noble/'+specifier.slice("@noble/hashes/".length).replace(/\.js$/,"")+'.js"'
   const url=specifier.startsWith("@/")?"/src/"+specifier.slice(2):path.posix.resolve(path.posix.dirname(pathname),specifier)
   return 'from "'+url.replace(/\.ts$/,"")+'.js"'
  })
  await route.fulfill({contentType:"text/javascript",body:code})
 })
 await configure(context)
 let page=await context.newPage()
 await page.goto(origin)
 await page.setContent('<label>状態<select name="status"><option value="planned">予定</option><option value="completed">完了</option></select></label>')
 results.push({browser:name,case:"medical-locator",exactLabel:await page.getByLabel("状態",{exact:true}).count(),combobox:await page.getByRole("combobox",{name:"状態",exact:true}).count()})
 await page.getByRole("combobox",{name:"状態",exact:true}).selectOption("completed")
 const result=await page.evaluate(async()=>{
  const m=await import("/src/lib/domain/record-requests.js")
  const c="e9000000-0000-4000-8000-000000000001",id="e9000000-0000-4000-8000-000000000002"
  const owner={userId:"fixture-browser-user",householdId:"fixture-browser-household",childId:c}
  const request={schema:1,id,owner,kind:"medical",payload:{id,childId:c,version:"2026-10-31T00:00:00.123456+00:00",value:{kind:"vaccination",title:"synthetic-private-title",dose:1,status:"planned",scheduled_date:"2026-11-01",completed_date:null,memo:"synthetic-private-memo",remind:false,source_key:"jichi-jihs-20261001"}}}
  // Use the repository's actual source key, without changing a validation boundary.
  const {MEDICAL_SOURCES}=await import("/src/lib/domain/medical.js");request.payload.value.source_key=MEDICAL_SOURCES.vaccination.key
  const assert=(v,message)=>{if(!v)throw Error(message)}
  const k=m.RECORD_REQUEST_PREFIX+owner.userId+":"+owner.householdId+":"+c+":"+id
  const checks=[]
  assert(await m.storeRecordRequest(request),"encrypt write")
  const raw=localStorage.getItem(k);assert(raw&&!raw.includes("synthetic-private")&&!raw.includes("2026-11-01")&&!raw.includes("vaccination"),"plaintext at rest")
  const marker=localStorage.getItem("irori:record-request-owner:v1"),parsed=JSON.parse(marker)
  assert(JSON.stringify(Object.keys(parsed).sort())===JSON.stringify(["epoch","ownerHash","schema"])&&parsed.schema===2&&/^[a-f0-9]{64}$/.test(parsed.ownerHash),"minimal owner marker")
  for(const value of [owner.userId,owner.householdId,c,id,"payload","memo"])assert(!marker.includes(value),"raw owner marker")
  const standard=await crypto.subtle.digest("SHA-256",new TextEncoder().encode("irori:record-request-owner:v2\0"+JSON.stringify([owner.userId,owner.householdId])))
  assert(parsed.ownerHash===Array.from(new Uint8Array(standard),n=>n.toString(16).padStart(2,"0")).join(""),"standard owner fingerprint")
  assert(JSON.stringify((await m.listRecordRequests(owner))[0])===JSON.stringify(request),"roundtrip exact")
  const previous=await import("/src/lib/domain/legacy-record-requests.js")
  assert(previous.unreadableRecordCount(owner)===1&&previous.listRecordRequests(owner).length===0,"old bundle must block opaque encrypted request")
  await m.storeRecordRequest({...request,payload:{...request.payload,value:{...request.payload.value,title:"changed"}}})
  assert(localStorage.getItem(k)===raw,"first write immutable");checks.push("encrypted-first-write")
  window.fixtureRequest=request;window.fixtureKey=k;window.fixtureRaw=raw
  checks.push("previous-bundle-blocks-new-envelope","minimal-owner-marker")
  return checks
 })
 results.push({browser:name,checks:result})
 await context.close()
 context=await engine.launchPersistentContext(profile)
 await configure(context)
 page=await context.newPage()
 await page.goto(origin)
 results.push({browser:name,checks:await page.evaluate(async()=>{
  const m=await import("/src/lib/domain/record-requests.js")
  const owner={userId:"fixture-browser-user",householdId:"fixture-browser-household",childId:"e9000000-0000-4000-8000-000000000001"}
  const loaded=await m.readRecordRequests(owner)
  if(loaded.unreadable||loaded.items.length!==1||loaded.items[0].payload.value.memo!=="synthetic-private-memo")throw Error("restart restore")
  window.fixtureRequest=loaded.items[0];window.fixtureKey=m.RECORD_REQUEST_PREFIX+owner.userId+":"+owner.householdId+":"+owner.childId+":"+loaded.items[0].id
  window.fixtureRaw=localStorage.getItem(window.fixtureKey)
  const marker=localStorage.getItem("irori:record-request-owner:v1")
  await m.purgeOtherRecordRequests({...owner,childId:"e9000000-0000-4000-8000-000000000009"})
  if(localStorage.getItem("irori:record-request-owner:v1")!==marker)throw Error("same-owner restart/child switch changed marker")
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open("irori-record-request-keys",1);r.onsuccess=()=>resolve(r.result);r.onerror=reject})
  const key=await new Promise((resolve,reject)=>{const tx=db.transaction("keys","readonly"),r=tx.objectStore("keys").get(JSON.stringify([owner.userId,owner.householdId]));r.onsuccess=()=>resolve(r.result);r.onerror=reject})
  if(key.extractable)throw Error("extractable key")
  let exported=false;try{await crypto.subtle.exportKey("raw",key);exported=true}catch{}
  if(exported)throw Error("key export")
  db.close()
  return ["browser-restart-idb-key","key-nonextractable","same-owner-restart-marker"]
 })})
 results.push({browser:name,checks:await page.evaluate(async()=>{
  const m=await import("/src/lib/domain/record-requests.js"),request=window.fixtureRequest,k=window.fixtureKey
  const raw=localStorage.getItem(k),sealed=JSON.parse(raw)
  sealed.ciphertext=(sealed.ciphertext[0]==="A"?"B":"A")+sealed.ciphertext.slice(1);localStorage.setItem(k,JSON.stringify(sealed))
  const broken=localStorage.getItem(k),r=await m.readRecordRequests(request.owner)
  if(r.items.length||r.unreadable!==1||localStorage.getItem(k)!==broken||m.countRecordRequests(request.owner)!==1)throw Error("tamper preservation")
  localStorage.setItem(k,raw)
  const other={...request,id:"e9000000-0000-4000-8000-000000000003"}
  const otherKey=k.slice(0,-36)+other.id;localStorage.setItem(otherKey,raw)
  const copied=await m.readRecordRequests(request.owner)
  if(copied.items.length!==1||copied.unreadable!==1)throw Error("owner/id AAD")
  localStorage.removeItem(otherKey)
  m.removeRecordRequest(request)
  // The legacy case needs only a synthetic boolean body; the medical body above
  // is tested through the production encryption boundary, never a plaintext sink.
  const legacy={schema:1,id:"e9000000-0000-4000-8000-000000000002",owner:{userId:"fixture-browser-user",householdId:"fixture-browser-household",childId:"e9000000-0000-4000-8000-000000000001"},kind:"custom",payload:{operation:"record",id:"e9000000-0000-4000-8000-000000000004",childId:"e9000000-0000-4000-8000-000000000001",version:null,fieldId:"e9000000-0000-4000-8000-000000000001",value:false,loggedAt:"2026-10-31T00:00:00Z",memo:"synthetic legacy replay",voided:false}}
  localStorage.setItem(k,JSON.stringify(legacy))
  const restored=await m.readRecordRequests(legacy.owner)
  if(restored.unreadable||JSON.stringify(restored.items[0])!==JSON.stringify(legacy)||localStorage.getItem(k).includes("synthetic legacy replay"))throw Error("legacy migration")
  const future=JSON.stringify({schema:99,opaque:"synthetic future format"});localStorage.setItem(otherKey,future)
  await m.readRecordRequests(request.owner)
  if(localStorage.getItem(otherKey)!==future)throw Error("future preservation")
  localStorage.removeItem(otherKey)
  return ["tamper-preserved","aad-owner-operation","legacy-migration","future-preserved"]
 })})
 await context.setOffline(true)
 results.push({browser:name,checks:await page.evaluate(async()=>{
  const m=await import("/src/lib/domain/record-requests.js")
  const r=await m.readRecordRequests(window.fixtureRequest.owner)
  if(r.items.length!==1||r.unreadable)throw Error("offline restore")
  return ["offline-restore"]
 })})
 await context.setOffline(false)
 results.push({browser:name,checks:await page.evaluate(async()=>{
  const m=await import("/src/lib/domain/record-requests.js"),owner=window.fixtureRequest.owner,k=window.fixtureKey,raw=localStorage.getItem(k)
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open("irori-record-request-keys",1);r.onsuccess=()=>resolve(r.result);r.onerror=reject})
  await new Promise((resolve,reject)=>{const tx=db.transaction("keys","readwrite");tx.objectStore("keys").clear();tx.oncomplete=resolve;tx.onerror=reject});db.close()
  const missing=await m.readRecordRequests(owner)
  if(missing.items.length||missing.unreadable!==1||localStorage.getItem(k)!==raw||m.countRecordRequests(owner)!==1)throw Error("missing key destroyed recovery evidence")
  return ["missing-key-preserved-and-blocked"]
 })})
 await page.evaluate(async()=>{const m=await import("/src/lib/domain/record-requests.js");await m.purgeOtherRecordRequests({userId:"parallel-fixture",householdId:"parallel-household"})})
 const second=await context.newPage();await second.goto(origin)
 await page.evaluate(()=>{localStorage.removeItem("irori:record-request-owner:v1")})
 const parallel=async(page,id)=>page.evaluate(async id=>{
  const m=await import("/src/lib/domain/record-requests.js"),c="e9000000-0000-4000-8000-000000000001"
  return m.storeRecordRequest({schema:1,id,owner:{userId:"parallel-fixture",householdId:"parallel-household",childId:c},kind:"custom",payload:{operation:"record",id,childId:c,version:null,fieldId:c,value:false,loggedAt:"2026-10-31T00:00:00Z",memo:null,voided:false}})
 },id)
 const parallelOwner={userId:"parallel-fixture",householdId:"parallel-household"}
 const parallelIds=["e9000000-0000-4000-8000-000000000005","e9000000-0000-4000-8000-000000000006"]
 const written=await Promise.all([parallel(page,parallelIds[0]),parallel(second,parallelIds[1])])
 if(!written.every(Boolean))throw Error("parallel writes: store returned "+JSON.stringify(written))
 // 読み戻しだけを行う（再送しない）。keys = そのタブから見える暗号文の数、ids = 復号できた控え
 const readParallel=tab=>tab.evaluate(async owner=>{
  const m=await import("/src/lib/domain/record-requests.js")
  const r=await m.readRecordRequests(owner)
  return {ids:r.items.map(item=>item.id).sort(),unreadable:r.unreadable,keys:Object.keys(localStorage).filter(k=>k.startsWith(m.RECORD_REQUEST_PREFIX+owner.userId+":")).length}
 },parallelOwner)
 // 1) 保存の成功と復号: 書いたタブ自身では、自分の控えが遅れずに見え、復号できる
 for(const [tab,id] of [[page,parallelIds[0]],[second,parallelIds[1]]]){
  const own=await readParallel(tab)
  if(!own.ids.includes(id)||own.unreadable)throw Error("own-tab readback: "+JSON.stringify({id,...own}))
 }
 // 2) 別タブからの可視性: 別タブへの localStorage の反映は、書込の Promise の解決より遅れうる。
 //    同じ2件を再送せず、両方のタブの読み戻しだけを最大2秒観測する。最後まで欠ければ失敗にする。
 for(const tab of [page,second]){
  let seen
  for(let i=0;i<20;i++){
   seen=await readParallel(tab)
   if(seen.ids.length===2&&seen.unreadable===0)break
   if(i<19)await new Promise(resolve=>setTimeout(resolve,100))
  }
  if(seen.ids.length!==2||seen.unreadable)throw Error("cross-tab visibility after 2s: "+JSON.stringify(seen))
 }
 // 3) 永続化と鍵: ブラウザを閉じて開き直しても2つの暗号文が残り、IndexedDB の1つの鍵で両方を復号できる
 await context.close();context=await engine.launchPersistentContext(profile);await configure(context);page=await context.newPage();await page.goto(origin)
 const persisted=await readParallel(page)
 if(persisted.ids.join()!==[...parallelIds].sort().join()||persisted.unreadable)throw Error("parallel writes after browser restart: "+JSON.stringify(persisted))
 results.push({browser:name,checks:["parallel-tabs-key-creation","cold-owner-marker-initialization","own-tab-readback","cross-tab-visibility","parallel-restart-persistence"]})
 results.push({browser:name,checks:await page.evaluate(async()=>{
  const m=await import("/src/lib/domain/record-requests.js"),owner={userId:"parallel-fixture",householdId:"parallel-household",childId:"e9000000-0000-4000-8000-000000000001"}
  const open=indexedDB.open.bind(indexedDB)
  let release,opened
  const ready=new Promise(resolve=>{opened=resolve})
  indexedDB.open=(...args)=>{
   const request=open(...args)
   Object.defineProperty(request,"onsuccess",{set(handler){request.addEventListener("success",event=>{release=()=>handler.call(request,event);opened()})}})
   return request
  }
  const stale=m.purgeOtherRecordRequests({userId:"other-fixture",householdId:"other-household"})
  await ready
  indexedDB.open=open
  await m.purgeOtherRecordRequests(owner)
  const id="e9000000-0000-4000-8000-000000000007",c=owner.childId
  const entry={schema:1,id,owner,kind:"custom",payload:{operation:"record",id,childId:c,version:null,fieldId:c,value:false,loggedAt:"2026-10-31T00:00:00Z",memo:null,voided:false}}
  if(!await m.storeRecordRequest(entry))throw Error("returned owner store")
  release();await stale
  const retained=await m.readRecordRequests(owner)
  if(retained.items.length!==1||retained.unreadable)throw Error("stale cleanup deleted a returned owner's key")
  m.removeRecordRequest(entry)
  const k=m.RECORD_REQUEST_PREFIX+owner.userId+":"+owner.householdId+":"+c+":"+id
  localStorage.setItem(k,JSON.stringify(entry))
  const migrated=await Promise.all([m.readRecordRequests(owner),m.readRecordRequests(owner)])
  if(migrated.some(r=>r.items.length!==1||r.unreadable))throw Error("parallel migration reported false corruption")
  return ["delayed-cleanup-returned-owner","parallel-legacy-readers"]
 })})
 results.push({browser:name,checks:await page.evaluate(async()=>{
  const m=await import("/src/lib/domain/record-requests.js"),owner={userId:"parallel-fixture",householdId:"parallel-household",childId:"e9000000-0000-4000-8000-000000000001"}
  const markerKey="irori:record-request-owner:v1",id="e9000000-0000-4000-8000-000000000007",k=m.RECORD_REQUEST_PREFIX+owner.userId+":"+owner.householdId+":"+owner.childId+":"+id
  const before=localStorage.getItem(k)
  localStorage.setItem(markerKey,JSON.stringify({owner:JSON.stringify([owner.userId,owner.householdId]),epoch:crypto.randomUUID()}))
  const migrated=await m.readRecordRequests(owner)
  if(migrated.items.length!==1||migrated.unreadable||localStorage.getItem(k)!==before||localStorage.getItem(markerKey).includes(owner.userId))throw Error("legacy marker migration")
  const request=migrated.items[0],originalMarker=localStorage.getItem(markerKey)
  const stale=m.purgeOtherRecordRequests({userId:"late-owner",householdId:"late-household"})
  if(localStorage.getItem(markerKey)===originalMarker)throw Error("owner switch was deferred")
  await m.purgeOtherRecordRequests(owner)
  const marker=localStorage.getItem(markerKey)
  await stale
  if(localStorage.getItem(markerKey)!==marker)throw Error("late cleanup reactivated old owner")
  if(!await m.storeRecordRequest(request))throw Error("owner return recovery")
  const future='{"schema":99,"opaque":"synthetic future control"}'
  localStorage.setItem(markerKey,future)
  if(await m.storeRecordRequest(request))throw Error("unknown marker admitted write")
  await m.purgeOtherRecordRequests(owner)
  if(localStorage.getItem(markerKey)!==future)throw Error("unknown marker destroyed")
  localStorage.setItem(markerKey,marker)
  return ["legacy-marker-migration","synchronous-owner-transition","future-owner-marker-preserved"]
 })})
 await context.close();context=await engine.launchPersistentContext(profile);await configure(context);page=await context.newPage();await page.goto(origin)
 const afterRestart=await page.evaluate(async()=>{const m=await import("/src/lib/domain/record-requests.js");return m.readRecordRequests({userId:"parallel-fixture",householdId:"parallel-household"})})
 if(afterRestart.items.length!==1||afterRestart.unreadable)throw Error("returned owner's key did not survive browser restart")
 results.push({browser:name,checks:["returned-owner-browser-restart"]})
 } finally {
  await context?.close()
  rmSync(profile,{recursive:true,force:true})
 }
}
}catch(error){
 // ジョブのログを読めぬ時の手掛かりとして、理由を GitHub Actions の注記へ出す（値は合成のものだけ）
 console.log("::error title=Encrypted replay storage::"+String(error?.message??error).replace(/\s+/g," ").slice(0,900)+" passed="+JSON.stringify(results.map(r=>r.browser+":"+(r.checks??[r.case]).join("+"))))
 throw error
}
console.log(JSON.stringify(results,null,2))
