import { test,expect } from "./fixtures/test"
import { adminClient,loginViaMagicLink } from "./fixtures/auth"

test("共有は対象情報だけをオンラインで返し、取消後とオフラインで閉じる",async({page,browser,approvedUser,unapprovedUser})=>{
 test.setTimeout(180_000)
 await loginViaMagicLink(page,approvedUser.email)
 await page.getByLabel("世帯名").fill("synthetic sharing household")
 await page.getByRole("button",{name:"世帯を作成する"}).click()
 await expect(page).toHaveURL(/\/baby/)
 const db=adminClient()
 const {data:profile,error:pe}=await db.from("profiles").select("household_id").eq("id",approvedUser.id).single();if(pe)throw pe
 const {error:seed}=await db.from("baby_logs").insert({household_id:profile.household_id,logged_by:approvedUser.id,log_type:"feeding",feeding_type:"bottle",amount_ml:77,memo:"synthetic private memo"});if(seed)throw seed
 await page.goto("/children/sharing")
 await page.getByRole("button",{name:"閲覧招待を作成する"}).click()
 const link=page.getByLabel("閲覧招待リンク")
 await expect(link).toHaveValue(/\/invite\/[a-f0-9]{64}\/shared$/)
 const invite=await link.inputValue()
 const context=await browser.newContext()
 const viewer=await context.newPage()
 try{
  await loginViaMagicLink(viewer,unapprovedUser.email)
  await viewer.goto(invite)
  await viewer.getByRole("button",{name:"閲覧招待を受ける"}).click()
  await expect(viewer).toHaveURL(/\/shared\/[a-f0-9-]+$/)
  await expect(viewer.getByText("77",{exact:true})).toBeVisible()
  await expect(viewer.getByText("synthetic private memo")).toHaveCount(0)
  const denied=await context.request.get("/api/baby-export")
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
 }finally{await context.close()}
})
