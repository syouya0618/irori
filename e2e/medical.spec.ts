import { test,expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"
test("子どもの予防接種予定から完了へ更新し、カレンダーへ反映する",async({page,approvedUser})=>{
 await loginViaMagicLink(page,approvedUser.email)
 await page.getByLabel("世帯名").fill("synthetic medical household")
 await page.getByRole("button",{name:"世帯を作成する"}).click();await expect(page).toHaveURL(/\/baby/)
 await page.goto("/baby/medical")
 await page.getByLabel("名称",{exact:true}).fill("synthetic vaccine")
 await page.getByLabel("予定日",{exact:true}).fill("2026-01-01")
 await page.getByRole("button",{name:"保存する",exact:true}).click();await expect(page.getByRole("status")).toHaveText("保存しました")
 await page.getByRole("button",{name:"予定・実績を編集"}).click()
 await page.getByLabel("状態",{exact:true}).selectOption("completed")
 await page.getByLabel("実施日（完了時は必須）").fill("2026-01-01")
 await page.getByRole("button",{name:"保存する",exact:true}).click();await expect(page.getByText("完了 2026-01-01")).toBeVisible()
 await page.goto("/calendar?date=2026-01-01")
 await expect(page.getByText("完了: synthetic vaccine").first()).toBeVisible()
})
