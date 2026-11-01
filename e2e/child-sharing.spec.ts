import { test,expect } from "./fixtures/test"
import { adminClient,loginViaMagicLink,createApprovedUser,cleanupUser,uniqueEmail } from "./fixtures/auth"
import { parseSharedSnapshot } from "../src/lib/domain/child-sharing"

test("共有は対象情報だけをオンラインで返し、取消後とオフラインで閉じる",async({page,browser,approvedUser,unapprovedUser},testInfo)=>{
 test.setTimeout(180_000)
 await loginViaMagicLink(page,approvedUser.email)
 await page.getByLabel("世帯名").fill("synthetic sharing household")
 await page.getByRole("button",{name:"世帯を作成する"}).click()
 await expect(page).toHaveURL(/\/baby/)
 const db=adminClient()
 const {data:profile,error:pe}=await db.from("profiles").select("household_id").eq("id",approvedUser.id).single();if(pe)throw pe
 const {data:child,error:ce}=await db.from("children").select("id").eq("household_id",profile.household_id).eq("is_legacy",true).single();if(ce)throw ce
 const {data:sibling,error:se}=await db.from("children").insert({household_id:profile.household_id,name:"synthetic unshared sibling"}).select("id").single();if(se)throw se
 const {error:seed}=await db.from("baby_logs").insert([{household_id:profile.household_id,child_id:child.id,logged_by:approvedUser.id,log_type:"feeding",feeding_type:"bottle",amount_ml:77,memo:"synthetic private memo"},{household_id:profile.household_id,child_id:sibling.id,logged_by:approvedUser.id,log_type:"feeding",feeding_type:"bottle",amount_ml:88}]);if(seed)throw seed
 await page.goto("/children/sharing")
 await page.getByLabel("共有する子ども").selectOption(child.id)
 await page.getByRole("button",{name:"閲覧招待を作成する"}).click()
 const link=page.getByLabel("閲覧招待リンク")
 await expect(link).toHaveValue(/\/invite\/[a-f0-9]{64}\/shared$/)
 const invite=await link.inputValue()
 const context=await browser.newContext()
 const viewer=await context.newPage()
 const other=await createApprovedUser(`share-other-${uniqueEmail(testInfo.workerIndex)}`)
 let otherHousehold:string|undefined
 try{
  const {data:household,error:he}=await db.from("households").insert({name:"synthetic unshared household"}).select("id").single();if(he)throw he
  otherHousehold=household.id
  const {error:oe}=await db.from("profiles").update({household_id:otherHousehold,role:"owner"}).eq("id",other.id);if(oe)throw oe
  const {error:fe}=await db.from("baby_logs").insert({household_id:otherHousehold,logged_by:other.id,log_type:"feeding",feeding_type:"bottle",amount_ml:99});if(fe)throw fe
  await loginViaMagicLink(viewer,unapprovedUser.email)
  await viewer.goto(invite)
  const snapshotResponse=viewer.waitForResponse(r=>new URL(r.url()).pathname.startsWith("/api/shared/")&&r.request().method()==="GET")
  await viewer.getByRole("button",{name:"閲覧招待を受ける"}).click()
  await expect(viewer).toHaveURL(/\/shared\/[a-f0-9-]+$/)
  const response=await snapshotResponse
  expect(response.status()).toBe(200)
  expect(response.headers()["cache-control"]).toContain("no-store")
  const body=await response.json(),snapshot=parseSharedSnapshot(body)
  expect(snapshot).not.toBeNull()
  expect(snapshot?.valid_for_ms).toBe(15000)
  expect(snapshot?.daily.map(row=>row.amount_ml)).toEqual([77])
  expect(JSON.stringify(body)).not.toContain("synthetic private memo")
  const {data:accepted,error:ae}=await db.from("profiles").select("is_approved,role,household_id").eq("id",unapprovedUser.id).single();if(ae)throw ae
  expect(accepted).toEqual({is_approved:true,role:"viewer",household_id:null})
  expect((await context.cookies()).some(cookie=>/^sb-.*-auth-token/.test(cookie.name))).toBe(true)
  await expect(viewer.getByText("77",{exact:true})).toBeVisible()
  await expect(viewer.getByText("88",{exact:true})).toHaveCount(0)
  await expect(viewer.getByText("99",{exact:true})).toHaveCount(0)
  await expect(viewer.getByText("synthetic private memo")).toHaveCount(0)
  const denied=await context.request.get(new URL("/api/baby-export",viewer.url()).href)
  expect(denied.status()).toBe(403)
  await context.setOffline(true)
  await expect(viewer.getByText("77",{exact:true})).toHaveCount(0)
  await context.setOffline(false)
  await expect(viewer.getByText("77",{exact:true})).toBeVisible()
  await page.getByRole("button",{name:"共有を取り消す"}).click()
  await expect(page.getByRole("status")).toHaveText("共有を取り消しました")
  await viewer.reload()
  await expect(viewer.getByText("77",{exact:true})).toHaveCount(0)
  await expect(viewer.getByRole("status")).toContainText(/失効|確認/)
  // A separate positive grant proves expiry denial independently of revocation.
  await page.getByRole("button",{name:"閲覧招待を作成する"}).click()
  await expect(link).not.toHaveValue(invite)
  await viewer.goto(await link.inputValue())
  await viewer.getByRole("button",{name:"閲覧招待を受ける"}).click()
  await expect(viewer.getByText("77",{exact:true})).toBeVisible()
  const shareId=new URL(viewer.url()).pathname.split("/").pop()!
  const {error:expired}=await db.from("child_shares").update({created_at:new Date(Date.now()-172800000).toISOString(),expires_at:new Date(Date.now()-86400000).toISOString()}).eq("id",shareId);if(expired)throw expired
  const forbidden=await context.request.get(new URL(`/api/shared/${shareId}`,viewer.url()).href)
  expect(forbidden.status()).toBe(403)
  expect(JSON.stringify(await forbidden.json())).not.toContain("77")
  await viewer.reload()
  await expect(viewer.getByText("77",{exact:true})).toHaveCount(0)
  await expect(viewer.getByRole("status")).toContainText(/失効|確認/)
 }finally{await context.close();await cleanupUser(other.id,otherHousehold)}
})
