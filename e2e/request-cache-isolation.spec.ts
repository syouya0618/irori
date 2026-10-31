import { test,expect } from "./fixtures/test"
import { adminClient,cleanupUser,createApprovedUser,loginViaMagicLink,uniqueEmail } from "./fixtures/auth"
test("リクエスト内の認証共有が別ブラウザ利用者のプロフィール・子どもを混ぜない",async({page,browser,approvedUser},testInfo)=>{
 const other=await createApprovedUser(`cache-${uniqueEmail(testInfo.workerIndex)}`),context=await browser.newContext(),second=await context.newPage()
 await second.addInitScript(()=>localStorage.setItem("irori:tour-seen:v1","1"))
 let otherHousehold:string|undefined
 try{
  await loginViaMagicLink(page,approvedUser.email);await page.getByLabel("世帯名").fill("synthetic cache household A");await page.getByRole("button",{name:"世帯を作成する"}).click();await expect(page).toHaveURL(/\/baby/)
  await loginViaMagicLink(second,other.email);await second.getByLabel("世帯名").fill("synthetic cache household B");await second.getByRole("button",{name:"世帯を作成する"}).click();await expect(second).toHaveURL(/\/baby/)
  const db=adminClient(),{data:p,error:pe}=await db.from("profiles").select("household_id").eq("id",other.id).single();if(pe)throw pe;otherHousehold=p.household_id
  for(let n=0;n<3;n++){
   await Promise.all([page.goto("/settings"),second.goto("/settings")])
   await expect(page.getByText("synthetic cache household A",{exact:true})).toBeVisible();await expect(page.getByText("synthetic cache household B",{exact:true})).toHaveCount(0)
   await expect(second.getByText("synthetic cache household B",{exact:true})).toBeVisible();await expect(second.getByText("synthetic cache household A",{exact:true})).toHaveCount(0)
  }
 }finally{await context.close();await cleanupUser(other.id,otherHousehold)}
})
