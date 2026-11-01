import { test,expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"
test("睡眠タイマーは再読込後に再開でき、停止は一件として残る",async({page,approvedUser})=>{
 await loginViaMagicLink(page,approvedUser.email)
 await page.getByLabel("世帯名").fill("synthetic sleep household")
 await page.getByRole("button",{name:"世帯を作成する"}).click()
 await expect(page).toHaveURL(/\/baby/)
 await page.goto("/baby/sleep")
 await page.getByRole("button",{name:"寝た・計測を開始"}).click()
 await expect(page.getByRole("button",{name:"起きた・停止して記録"})).toBeVisible()
 await page.reload()
 await page.getByRole("button",{name:"起きた・停止して記録"}).click()
 await expect(page.getByRole("status")).toHaveText("保存しました")
 await page.reload()
 await expect(page.getByRole("button",{name:"寝た・計測を開始"})).toBeVisible()
 await expect(page.getByRole("button",{name:"時刻・メモを編集する"})).toHaveCount(1)
})
