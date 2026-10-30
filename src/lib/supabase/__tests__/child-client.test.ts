// @vitest-environment jsdom
import { describe,it,expect,vi,afterEach } from "vitest"
const factory=vi.hoisted(()=>vi.fn((_url:string,_key:string,options:unknown)=>({options})))
vi.mock("@supabase/ssr",()=>({createBrowserClient:factory}))
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks()})
describe("child clients keep immutable scope",()=>{
 it("reuses only the same browser child and never mutates another child's header",async()=>{
  vi.resetModules();const {createClient}=await import("../client")
  const a=createClient("synthetic-child-a"),b=createClient("synthetic-child-b")
  expect(createClient("synthetic-child-a")).toBe(a)
  expect(a).not.toBe(b)
  expect(factory.mock.calls[0][2]).toMatchObject({global:{headers:{"x-irori-child":"synthetic-child-a"}},isSingleton:false})
  expect(factory.mock.calls[1][2]).toMatchObject({global:{headers:{"x-irori-child":"synthetic-child-b"}}})
  expect(factory).toHaveBeenCalledTimes(2)
 })
 it("does not cache an authenticated SDK instance between server renders",async()=>{
  vi.stubGlobal("window",undefined);vi.resetModules();const {createClient}=await import("../client")
  expect(createClient("synthetic-child-a")).not.toBe(createClient("synthetic-child-a"))
 })
})
