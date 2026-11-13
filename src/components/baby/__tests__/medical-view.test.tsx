// @vitest-environment jsdom
import "@/lib/domain/__tests__/record-request-test-keys"
import { act,cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react"
import { afterEach,beforeEach,expect,it,vi } from "vitest"
import { MedicalView } from "../medical-view"
import { saveMedical } from "@/app/(main)/baby/medical/actions"
import { listRecordRequests } from "@/lib/domain/record-requests"
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}))
vi.mock("@/app/(main)/baby/medical/actions",()=>({saveMedical:vi.fn()}))
const owner={userId:"synthetic-user",householdId:"synthetic-household",childId:"e3000000-0000-4000-8000-000000000001"}
const view=()=> <MedicalView owner={owner} childName="synthetic child" records={[]} truncated={false}/>
beforeEach(()=>{localStorage.clear();vi.resetAllMocks()});afterEach(cleanup)
it("restores an ambiguous medical operation with the same id, child, date and version",async()=>{
 const writes=vi.spyOn(Storage.prototype,"setItem")
 try{
 vi.mocked(saveMedical).mockRejectedValueOnce(new Error("synthetic lost response"))
 const first=render(view());await waitFor(()=>expect(screen.getByRole("button",{name:"保存する"})).toBeEnabled())
 fireEvent.change(screen.getByLabelText("名称",{exact:true}),{target:{value:"synthetic vaccine"}})
 fireEvent.change(screen.getByLabelText("予定日",{exact:true}),{target:{value:"2026-01-01"}})
 fireEvent.click(screen.getByRole("button",{name:"保存する"}))
 await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("保存結果を確認できません"))
 const frozen=vi.mocked(saveMedical).mock.calls[0][0];expect(await listRecordRequests(owner)).toHaveLength(1)
 const ciphertextWrites=writes.mock.calls.map(([key],index)=>key.startsWith("irori:record-request:v1:")?index:-1).filter(index=>index>=0)
 expect(ciphertextWrites).toHaveLength(1)
 expect(writes.mock.invocationCallOrder[ciphertextWrites[0]]).toBeLessThan(vi.mocked(saveMedical).mock.invocationCallOrder[0])
 writes.mockClear()
 first.unmount();render(view());await screen.findByRole("button",{name:"保存結果を同じ操作で確認"})
 vi.mocked(saveMedical).mockResolvedValueOnce({status:"replayed"})
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"保存結果を同じ操作で確認"})))
 expect(vi.mocked(saveMedical).mock.calls[1][0]).toEqual(frozen);expect(await listRecordRequests(owner)).toEqual([])
 expect(writes).not.toHaveBeenCalled()
 }finally{writes.mockRestore()}
})

it("keeps the memory-only warning visible when a failed persistence is followed by an unknown save",async()=>{
 const spy=vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("synthetic unavailable storage")})
 try{
  vi.mocked(saveMedical).mockResolvedValueOnce({error:"synthetic unknown",failure:"unknown"});render(view());await waitFor(()=>expect(screen.getByRole("button",{name:"保存する"})).toBeEnabled())
  fireEvent.change(screen.getByLabelText("名称",{exact:true}),{target:{value:"synthetic vaccine"}});fireEvent.change(screen.getByLabelText("予定日",{exact:true}),{target:{value:"2026-01-01"}});fireEvent.click(screen.getByRole("button",{name:"保存する"}))
  await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("保存結果を確認できません"));expect(screen.getByRole("alert")).toHaveTextContent("控えを端末に残せていません")
 }finally{spy.mockRestore()}
})

it("retains the original unknown operation when a later retry is rejected, then confirms that same body",async()=>{
 vi.mocked(saveMedical).mockRejectedValueOnce(new Error("synthetic lost response"))
 render(view());await waitFor(()=>expect(screen.getByRole("button",{name:"保存する"})).toBeEnabled())
 fireEvent.change(screen.getByLabelText("名称",{exact:true}),{target:{value:"synthetic vaccine"}})
 fireEvent.change(screen.getByLabelText("予定日",{exact:true}),{target:{value:"2026-01-01"}})
 fireEvent.click(screen.getByRole("button",{name:"保存する"}))
 await screen.findByText("保存結果を確認できません。同じ操作で確認し直してください")
 const frozen=vi.mocked(saveMedical).mock.calls[0][0]
 vi.mocked(saveMedical).mockResolvedValueOnce({error:"synthetic expired login",failure:"rejected"})
 // 保存結果の文が見えても React Transition が収束する前の釦はdisabledのことがある。
 await waitFor(()=>expect(screen.getByRole("button",{name:"保存結果を同じ操作で確認"})).toBeEnabled())
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"保存結果を同じ操作で確認"})))
 await waitFor(()=>expect(vi.mocked(saveMedical)).toHaveBeenCalledTimes(2))
 expect(vi.mocked(saveMedical).mock.calls[1][0]).toEqual(frozen)
 expect(await listRecordRequests(owner)).toHaveLength(1)
 expect(screen.getByRole("button",{name:"保存する"})).toBeDisabled()
 vi.mocked(saveMedical).mockResolvedValueOnce({status:"replayed"})
 await waitFor(()=>expect(screen.getByRole("button",{name:"保存結果を同じ操作で確認"})).toBeEnabled())
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"保存結果を同じ操作で確認"})))
 await waitFor(()=>expect(vi.mocked(saveMedical)).toHaveBeenCalledTimes(3))
 expect(vi.mocked(saveMedical).mock.calls[2][0]).toEqual(frozen)
 expect(await listRecordRequests(owner)).toEqual([])
})
