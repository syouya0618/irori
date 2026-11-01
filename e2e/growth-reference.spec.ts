import { test,expect } from "./fixtures/test"
import { adminClient,loginViaMagicLink } from "./fixtures/auth"
test("対象児の月齢・性別に対応した公式基準帯を表示する",async({page,approvedUser})=>{
 await loginViaMagicLink(page,approvedUser.email)
 await page.getByLabel("世帯名").fill("synthetic growth household");await page.getByRole("button",{name:"世帯を作成する"}).click();await expect(page).toHaveURL(/\/baby/)
 const db=adminClient();const {data:p,error:pe}=await db.from("profiles").select("household_id").eq("id",approvedUser.id).single();if(pe)throw pe
 const {data:c,error:ce}=await db.from("children").select("id").eq("household_id",p.household_id).eq("is_legacy",true).single();if(ce)throw ce
 const {error:ue}=await db.from("children").update({birth_date:"2025-01-01",sex:"female"}).eq("id",c.id);if(ue)throw ue
 const {error:le}=await db.from("baby_logs").insert({household_id:p.household_id,child_id:c.id,logged_by:approvedUser.id,log_type:"growth",logged_at:"2025-02-01T03:00:00Z",weight_g:4400,height_cm:54.5});if(le)throw le
 await page.reload();await page.getByRole("button",{name:/成長の記録/}).click()
 await expect(page.getByRole("img",{name:"体重の月齢別パーセンタイル帯と測定値"})).toBeVisible()
 await expect(page.getByRole("link",{name:/出典: こども家庭庁/})).toBeVisible()
})
