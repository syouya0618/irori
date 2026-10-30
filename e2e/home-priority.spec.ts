import { test,expect } from "./fixtures/test"
import { adminClient,loginViaMagicLink } from "./fixtures/auth"
test("年齢の既定表示を本人が調整して再読込後も使える",async({page,approvedUser})=>{
 await loginViaMagicLink(page,approvedUser.email);await page.getByLabel("世帯名").fill("synthetic age home");await page.getByRole("button",{name:"世帯を作成する"}).click();await expect(page).toHaveURL(/\/baby/)
 const db=adminClient(),{data:p,error:pe}=await db.from("profiles").select("household_id").eq("id",approvedUser.id).single();if(pe)throw pe
 const {error:ce}=await db.from("children").update({birth_date:"2020-01-01"}).eq("household_id",p.household_id).eq("is_legacy",true);if(ce)throw ce
 await page.reload();const links=page.getByRole("navigation",{name:"育児機能"}).getByRole("link");await expect(links.first()).toHaveText("カスタム記録")
 await page.getByText(/ホームの表示/).click();await page.getByLabel("ホームで優先する機能").selectOption("sleep");await expect(links.first()).toHaveText("睡眠")
 await page.reload();await expect(links.first()).toHaveText("睡眠");await expect(links).toHaveCount(3)
})
