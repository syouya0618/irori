import { expect,it } from "vitest"
import { isMedicalRequest } from "../medical"
const r={id:"e3000000-0000-4000-8000-000000000001",childId:"e3000000-0000-4000-8000-000000000002",version:null,value:{kind:"vaccination",title:"synthetic vaccine",dose:1,status:"planned",scheduled_date:"2026-01-01",completed_date:null,memo:null,remind:true,source_key:"jihs-2026-10-01"}}
it("validates official source, type, completion date and scope before sending",()=>{expect(isMedicalRequest(r)).toBe(true);for(const value of [{...r.value,source_key:"unknown"},{...r.value,scheduled_date:"2026-02-30"},{...r.value,status:"completed"},{...r.value,dose:0},{...r.value,kind:"checkup"}])expect(isMedicalRequest({...r,value})).toBe(false);expect(isMedicalRequest({...r,childId:"bad"})).toBe(false)})
