import { describe,it,expect } from "vitest"
import { parseSharedSnapshot,parseShareList } from "../child-sharing"
const valid={child_name:"synthetic",window_note:"window",valid_for_ms:15000,daily:[],health:[],diary:[],expires_at:null}
describe("shared snapshot transport",()=>{
 it("accepts a bounded snapshot",()=>expect(parseSharedSnapshot(valid)).not.toBeNull())
 it.each([0,-1,NaN,Infinity,15001])("rejects an invalid lease: %s",valid_for_ms=>expect(parseSharedSnapshot({...valid,valid_for_ms})).toBeNull())
 it("rejects unstructured rows and invalid lists",()=>{expect(parseSharedSnapshot({...valid,daily:[null]})).toBeNull();expect(parseShareList([{}])).toBeNull()})
})
