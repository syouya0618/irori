// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react"
import { afterEach,beforeEach,expect,it,vi } from "vitest"
import { CustomView } from "../custom-view"
import { saveCustom } from "@/app/(main)/baby/custom/actions"
import type { CustomField } from "@/lib/domain/custom-records"
import { listRecordRequests } from "@/lib/domain/record-requests"
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}))
vi.mock("@/app/(main)/baby/custom/actions",()=>({saveCustom:vi.fn()}))
const owner={userId:"synthetic-user",householdId:"synthetic-household",childId:"e4000000-0000-4000-8000-000000000001"}
const field:CustomField={id:"e4000000-0000-4000-8000-000000000002",household_id:owner.householdId,label:"synthetic numeric",value_type:"number",options:[],archived:false,created_at:"2026-01-01T00:00:00Z",updated_at:"2026-01-01T00:00:00Z"}
const view=()=> <CustomView owner={owner} childName="synthetic child" fields={[field]} fieldsTruncated={false} records={[]} hasMore={false} query="" fieldFilter="" page={0} nowIso="2026-01-01T00:00:00Z"/>
beforeEach(()=>{localStorage.clear();vi.resetAllMocks()});afterEach(cleanup)
it("restores a frozen typed custom record after an ambiguous response",async()=>{
 vi.mocked(saveCustom).mockRejectedValueOnce(new Error("synthetic lost response"));const first=render(view())
 await waitFor(()=>expect(screen.getByRole("button",{name:"記録を保存"})).toBeEnabled());fireEvent.change(screen.getByLabelText("値",{exact:true}),{target:{value:"0"}});fireEvent.click(screen.getByRole("button",{name:"記録を保存"}))
 await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("保存結果を確認できません"));const frozen=vi.mocked(saveCustom).mock.calls[0][0];expect(frozen).toMatchObject({childId:owner.childId,value:0});first.unmount()
 render(view());await screen.findByRole("button",{name:"保存結果を同じ操作で確認"});vi.mocked(saveCustom).mockResolvedValueOnce({status:"replayed"});await act(async()=>fireEvent.click(screen.getByRole("button",{name:"保存結果を同じ操作で確認"})))
 expect(vi.mocked(saveCustom).mock.calls[1][0]).toEqual(frozen);expect(listRecordRequests(owner)).toEqual([])
})
