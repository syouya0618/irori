import { expect,it } from "vitest"
import { isCustomRequest,displayCustomValue } from "../custom-records"
const base={id:"e4000000-0000-4000-8000-000000000001",childId:"e4000000-0000-4000-8000-000000000002",version:null}
it("validates field types/options and keeps false and zero as record values",()=>{
 const field={...base,operation:"field",label:"synthetic choice",type:"choice",options:["A","B"],archived:false}
 expect(isCustomRequest(field)).toBe(true);expect(isCustomRequest({...field,options:["A","A"]})).toBe(false);expect(isCustomRequest({...field,type:"number"})).toBe(false)
 const r={...base,operation:"record",fieldId:base.id,value:0,loggedAt:"2026-01-01T00:00:00Z",memo:null,voided:false}
 expect(isCustomRequest(r)).toBe(true);expect(isCustomRequest({...r,value:false})).toBe(true);expect(isCustomRequest({...r,value:{arbitrary:"object"}})).toBe(false);expect(isCustomRequest({...r,value:Infinity})).toBe(false);expect(isCustomRequest({...r,childId:"bad"})).toBe(false)
 expect(displayCustomValue(false,"boolean")).toBe("いいえ");expect(displayCustomValue(0,"number")).toBe("0")
})
