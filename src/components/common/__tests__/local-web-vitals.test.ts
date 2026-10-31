// @vitest-environment jsdom
import { beforeEach,expect,it,vi } from "vitest"
import { reportLocalVital } from "../local-web-vitals"
vi.mock("next/web-vitals",()=>({useReportWebVitals:vi.fn()}))
beforeEach(()=>localStorage.clear())
it("requires explicit local opt-in and only emits numeric performance metadata",()=>{
 const listener=vi.fn();window.addEventListener("irori:web-vital",listener)
 const metric={name:"INP",value:123,rating:"good",navigationType:"navigate",id:"synthetic-private-id",navigationURL:"https://example.invalid/private/child",entries:[{target:"synthetic-private-node"}]}
 reportLocalVital(metric as never);expect(listener).not.toHaveBeenCalled()
 localStorage.setItem("irori:measure-performance:v1","1");reportLocalVital(metric as never)
 expect(listener.mock.calls[0][0].detail).toEqual({name:"INP",value:123,rating:"good",navigationType:"navigate"});window.removeEventListener("irori:web-vital",listener)
})
