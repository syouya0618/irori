// @vitest-environment jsdom
import { act,cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react"
import { afterEach,beforeEach,expect,it,vi } from "vitest"
import { SleepView } from "../sleep-view"
import { saveSleep } from "@/app/(main)/baby/sleep/actions"
import { listPendingSleep } from "@/lib/domain/sleep-pending"
import type { SleepSession } from "@/lib/domain/sleep"
vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()})}))
vi.mock("@/app/(main)/baby/sleep/actions",()=>({saveSleep:vi.fn()}))
vi.mock("@/lib/hooks/use-server-clock",()=>({useServerClock:()=>({serverNowIso:()=>"2026-01-02T03:00:00Z"})}))
const owner={userId:"synthetic-user",householdId:"synthetic-household",childId:"f2000000-0000-4000-8000-000000000001"}
const row={id:"f2000000-0000-4000-8000-000000000002",child_id:owner.childId,household_id:owner.householdId,started_at:"2026-01-01T23:00:00Z",ended_at:null,updated_at:"2026-01-01T23:00:00.000001Z",voided:false,memo:null,started_by:owner.userId,ended_by:null,created_at:"2026-01-01T23:00:00Z"} satisfies SleepSession
const view=(active:SleepSession|null=null)=><SleepView owner={owner} childName="synthetic child" initialSessions={active?[active]:[]} initialActive={active} feedings={[]}/>
beforeEach(()=>{localStorage.clear();vi.resetAllMocks()});afterEach(cleanup)
it("restores a server timer after reload without starting a new operation",async()=>{
 render(view(row));await waitFor(()=>expect(screen.getByRole("button",{name:"起きた・停止して記録"})).toBeEnabled())
 expect(screen.getByText(/から睡眠中/)).toBeVisible();expect(saveSleep).not.toHaveBeenCalled()
})
it("keeps the frozen operation after an ambiguous response and confirms it after remount",async()=>{
 vi.mocked(saveSleep).mockRejectedValueOnce(new Error("synthetic lost response"))
 const first=render(view());const button=screen.getByRole("button",{name:"寝た・計測を開始"});await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button)
 await screen.findByRole("button",{name:"同じ操作を確認する"});await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("保存結果を確認できません"))
 const frozen=vi.mocked(saveSleep).mock.calls[0][0];expect(listPendingSleep(owner).items).toHaveLength(1)
 first.unmount();render(view());await screen.findByRole("button",{name:"同じ操作を確認する"})
 vi.mocked(saveSleep).mockResolvedValueOnce({result:{status:"replayed",session:{...row,id:frozen.id}}})
 await act(async()=>fireEvent.click(screen.getByRole("button",{name:"同じ操作を確認する"})))
 expect(vi.mocked(saveSleep).mock.calls[1][0]).toEqual(frozen);expect(listPendingSleep(owner).items).toEqual([])
 expect(screen.getByRole("button",{name:"起きた・停止して記録"})).toBeVisible()
})
it("shows the competing session and does not blindly send another start",async()=>{
 vi.mocked(saveSleep).mockResolvedValueOnce({result:{status:"conflict",session:row}})
 render(view());await waitFor(()=>expect(screen.getByRole("button",{name:"寝た・計測を開始"})).toBeEnabled())
 fireEvent.click(screen.getByRole("button",{name:"寝た・計測を開始"}));await waitFor(()=>expect(screen.getByRole("status")).toHaveTextContent("別の端末"))
 expect(saveSleep).toHaveBeenCalledTimes(1);expect(listPendingSleep(owner).items).toEqual([])
})
