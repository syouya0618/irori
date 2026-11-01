import { expect,it } from "vitest"
import { resolvedHomeFocus,homeDetailOrder } from "../home-priority"
it("uses age stages only as a default and always honors the user's choice",()=>{
 expect(resolvedHomeFocus(null,"auto")).toBe("sleep");expect(resolvedHomeFocus(0,"auto")).toBe("sleep");expect(resolvedHomeFocus(6,"auto")).toBe("medical");expect(resolvedHomeFocus(24,"auto")).toBe("custom")
 for(const age of [null,0,6,24,100])for(const focus of ["sleep","medical","custom"] as const){expect(resolvedHomeFocus(age,focus)).toBe(focus);expect(new Set(homeDetailOrder(age,focus)).size).toBe(4)}
 expect(homeDetailOrder(25,"auto")[0]).toBe("diary");expect(homeDetailOrder(25,"sleep")[0]).toBe("temperature")
})
