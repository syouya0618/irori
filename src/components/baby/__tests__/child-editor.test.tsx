// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react"
import { afterEach,beforeEach,expect,it,vi } from "vitest"
import { ChildEditor } from "../child-editor"
import { saveChild } from "@/app/(main)/children/actions"
import { listRecordRequests } from "@/lib/domain/record-requests"
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}))
vi.mock("@/app/(main)/children/actions",()=>({saveChild:vi.fn()}))
const owner={userId:"synthetic-user",householdId:"synthetic-household"},firstId="e6000000-0000-4000-8000-000000000001",nextId="e6000000-0000-4000-8000-000000000002"
beforeEach(()=>{localStorage.clear();vi.resetAllMocks()});afterEach(cleanup)
it("restores an ambiguous child creation across reload and sends the original body with its original id",async()=>{
 vi.mocked(saveChild).mockRejectedValueOnce(new Error("synthetic lost response"));const first=render(<ChildEditor owner={owner} createId={firstId}/> )
 await waitFor(()=>expect(screen.getByRole("button",{name:"保存する"})).toBeEnabled());fireEvent.change(screen.getByLabelText("呼び名"),{target:{value:"synthetic sibling"}});fireEvent.click(screen.getByRole("button",{name:"保存する"}))
 await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("保存結果を確認できません"));const frozen=Object.fromEntries(vi.mocked(saveChild).mock.calls[0][0].entries());first.unmount()
 render(<ChildEditor owner={owner} createId={nextId}/>);await screen.findByRole("button",{name:"子どもの追加を同じ操作で確認"});expect(screen.getByRole("button",{name:"保存する"})).toBeDisabled()
 vi.mocked(saveChild).mockResolvedValueOnce({success:true,updatedAt:"2026-01-01T00:00:00Z",replayed:true});await act(async()=>fireEvent.click(screen.getByRole("button",{name:"子どもの追加を同じ操作で確認"})))
 expect(Object.fromEntries(vi.mocked(saveChild).mock.calls[1][0].entries())).toEqual(frozen);expect(listRecordRequests(owner)).toEqual([]);expect(screen.getByLabelText("呼び名")).toHaveValue("")
})
