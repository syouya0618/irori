import { test,expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"
test("世帯項目を定義し、記録・検索・編集・JSON出力できる",async({page,approvedUser})=>{
 await loginViaMagicLink(page,approvedUser.email);await page.getByLabel("世帯名").fill("synthetic custom household");await page.getByRole("button",{name:"世帯を作成する"}).click();await expect(page).toHaveURL(/\/baby/)
 await page.goto("/baby/custom");await page.getByText("世帯の項目を管理",{exact:true}).click();await page.getByLabel("項目名",{exact:true}).fill("synthetic custom value");await page.getByRole("button",{name:"項目を保存",exact:true}).click();await expect(page.getByRole("status")).toHaveText("保存しました")
 await page.getByLabel("値",{exact:true}).fill("7");await page.getByRole("button",{name:"記録を保存",exact:true}).click();await expect(page.getByRole("button",{name:"記録を編集",exact:true})).toHaveCount(1)
 await page.getByLabel("記録を検索",{exact:true}).fill("synthetic custom value");await page.getByRole("button",{name:"検索する",exact:true}).click();await expect(page.getByRole("button",{name:"記録を編集",exact:true})).toHaveCount(1)
 await page.getByRole("button",{name:"記録を編集",exact:true}).click();await page.getByLabel("値",{exact:true}).fill("9");await page.getByRole("button",{name:"記録を保存",exact:true}).click();await expect(page.getByText("9",{exact:true})).toBeVisible()
 const download=page.waitForEvent("download");await page.getByRole("button",{name:"追加記録のJSONを書き出す"}).click();expect((await download).suggestedFilename()).toBe("irori-additional-records.json")
})
