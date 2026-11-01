// @vitest-environment jsdom
import { act,cleanup,render,screen } from "@testing-library/react"
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest"
import { SharedView } from "../shared-view"
vi.mock("next/navigation",()=>({useRouter:()=>({replace:vi.fn(),refresh:vi.fn()})}))
vi.mock("@/app/invite/[token]/shared/actions",()=>({acceptChildShare:vi.fn()}))
const snapshot={child_name:"synthetic shared child",daily:[{log_type:"feeding",amount_ml:77}],health:[],diary:[],expires_at:null,valid_for_ms:15000,window_note:"synthetic window"}
const response=()=>({ok:true,json:async()=>snapshot})
beforeEach(()=>{vi.useFakeTimers();Object.defineProperty(navigator,"onLine",{configurable:true,value:true});Object.defineProperty(document,"visibilityState",{configurable:true,value:"visible"})})
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals()})
async function flush(){await act(async()=>{await Promise.resolve();await Promise.resolve()})}
describe("shared viewing requires a fresh online confirmation",()=>{
 it("clears private content offline and ignores a response from before that boundary",async()=>{
  let finish:((v:unknown)=>void)|undefined
  const fetch=vi.fn().mockResolvedValueOnce(response()).mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  vi.stubGlobal("fetch",fetch)
  render(<SharedView id="synthetic-share"/>);await flush()
  expect(screen.getByText("synthetic shared child")).toBeVisible()
  await act(async()=>{vi.advanceTimersByTime(10000)})
  act(()=>window.dispatchEvent(new Event("offline")))
  expect(screen.queryByText("synthetic shared child")).toBeNull()
  await act(async()=>finish?.(response()));await flush()
  expect(screen.queryByText("synthetic shared child")).toBeNull()
  expect(fetch.mock.calls[0][1]).toMatchObject({cache:"no-store",redirect:"error"})
 })
 it("does not keep the last snapshot when refresh stops responding",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(response()).mockImplementation(()=>new Promise(()=>{})))
  render(<SharedView id="synthetic-share"/>);await flush()
  expect(screen.getByText("synthetic shared child")).toBeVisible()
  await act(async()=>{vi.advanceTimersByTime(15001)})
  expect(screen.queryByText("synthetic shared child")).toBeNull()
 })
 it("removes private DOM before a hidden page can be restored",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response()))
  render(<SharedView id="synthetic-share"/>);await flush()
  act(()=>window.dispatchEvent(new Event("pagehide")))
  expect(screen.queryByText("synthetic shared child")).toBeNull()
 })
 it("denied or invalid responses never render a stale successful snapshot",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:false}))
  render(<SharedView id="synthetic-share"/>);await flush()
  expect(screen.queryByText("synthetic shared child")).toBeNull()
  expect(screen.getByRole("status")).toHaveTextContent("失効")
 })
})
