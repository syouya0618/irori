import { test,expect } from "./fixtures/test"
import { adminClient,loginViaMagicLink } from "./fixtures/auth"
test("本人の任意地域だけの記事を読み、通知は明示的に切り替えられる",async({page,approvedUser})=>{
 await loginViaMagicLink(page,approvedUser.email);await page.getByLabel("世帯名").fill("synthetic news household");await page.getByRole("button",{name:"世帯を作成する"}).click();await expect(page).toHaveURL(/\/baby/)
 await page.goto("/news");await page.getByLabel("ニュースの地域").selectOption("sapporo");await page.getByRole("button",{name:"ニュース設定を保存"}).click();await expect(page.getByRole("status")).toHaveText("保存しました")
 const db=adminClient(),published=new Date(Date.now()-3600000).toISOString()
 const {error}=await db.from("news_articles").upsert([{region_key:"sapporo",id:"a".repeat(64),title:"synthetic selected news",url:"https://www.city.sapporo.jp/synthetic/selected.html",published_at:published},{region_key:"yokohama",id:"b".repeat(64),title:"synthetic other region",url:"https://www.city.yokohama.lg.jp/synthetic/other.html",published_at:published}]);if(error)throw error
 await page.reload();await expect(page.getByRole("link",{name:"synthetic selected news"})).toBeVisible();await expect(page.getByText("synthetic other region")).toHaveCount(0)
 const checkbox=page.getByLabel("新着がある朝8時に通知する");await expect(checkbox).not.toBeChecked();await checkbox.check();await page.getByRole("button",{name:"ニュース設定を保存"}).click();await expect(page.getByRole("status")).toHaveText("保存しました");await page.reload();await expect(checkbox).toBeChecked()
})
