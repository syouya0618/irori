import { describe, expect, it } from "vitest"
import { googleEventObservation, googleFields, managedSeriesId } from "../managed-events"
import { toExportEvent } from "@/lib/domain/google-calendar-export"

const local = {id:"12345678-1234-4123-8123-123456789abc",title:"帰省",is_all_day:true,start_date:"2026-12-31",end_date:"2027-01-02",start_at:null,end_at:null}
const legacy = { ...toExportEvent(local,"owner"), etag:"v1" }

describe("managed Google events",()=>{
  it("adopts the v1 identity only with both correctly scoped markers",()=>{
    expect(googleEventObservation(legacy,"owner").legacy).toBe(local.id)
    expect(googleEventObservation(legacy,"spouse").state).toBe("protected")
    expect(googleEventObservation({...legacy,extendedProperties:undefined},"owner").state).toBe("protected")
  })
  it("round trips a multiday all-day interval without including private fields",()=>{
    const observed=googleEventObservation({...legacy,id:"google-id"},"owner")
    expect(observed.doc).toEqual({title:"帰省",timing:{start:"2026-12-31",end:"2027-01-02"}})
    expect(googleFields(observed.doc)).toEqual({summary:"帰省",start:{date:"2026-12-31"},end:{date:"2027-01-03"}})
  })
  it("normalizes offset timestamps without losing a DST fold or crossing dates",()=>{
    const obs=googleEventObservation({...legacy,id:"event",start:{dateTime:"2026-11-01T01:45:00-04:00"},end:{dateTime:"2026-11-01T01:45:00-05:00"}},"owner")
    expect(googleFields(obs.doc)).toMatchObject({start:{dateTime:"2026-11-01T05:45:00.000Z"},end:{dateTime:"2026-11-01T06:45:00.000Z"}})
  })
  it("recognizes sparse cancellations and keeps recurrence identities scoped by calendar",()=>{
    expect(googleEventObservation({id:"a",status:"cancelled"},"owner").state).toBe("cancelled")
    expect(managedSeriesId("a","x")).not.toBe(managedSeriesId("b","x"))
    expect(managedSeriesId("a","x")).toBe(managedSeriesId("a","x"))
  })
  it("does not export through guest-bearing events or accept incomplete dates",()=>{
    expect(googleEventObservation({...legacy,attendees:[{}]},"owner").state).toBe("protected")
    expect(()=>googleEventObservation({...legacy,end:undefined},"owner")).toThrow()
  })
})
