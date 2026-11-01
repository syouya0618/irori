import { describe,it,expect } from "vitest"
import { isSleepRequest,mergeSleepSessions,sleepMinutesByDay,type SleepSession } from "../sleep"
const child="f1000000-0000-4000-8000-000000000001"
const id="f1000000-0000-4000-8000-000000000002"
export const row=(patch:Partial<SleepSession>={}):SleepSession=>({id,child_id:child,household_id:"synthetic-household",started_at:"2026-01-01T13:00:00Z",ended_at:"2026-01-01T17:00:00Z",started_by:"synthetic-user",ended_by:"synthetic-user",memo:null,voided:false,created_at:"2026-01-01T13:00:00Z",updated_at:"2026-01-01T17:00:00.000001Z",...patch})
describe("sleep rhythm",()=>{
 it("clips a cross-midnight session into JST days",()=>expect(sleepMinutesByDay([row()],"2026-01-01",2)).toEqual([{date:"2026-01-01",minutes:120},{date:"2026-01-02",minutes:120}]))
 it("unions overlapping intervals and excludes ongoing or voided rows",()=>{
  const values=[row(),row({id:"overlap",started_at:"2026-01-01T14:00:00Z"}),row({id:"active",ended_at:null}),row({id:"void",started_at:"2026-01-01T10:00:00Z",voided:true})]
  expect(sleepMinutesByDay(values,"2026-01-01",1)[0].minutes).toBe(120)
 })
 it("keeps the newest microsecond version when a delayed local response crosses a fresh server read",()=>{
  const older=row({ended_at:null}),newer=row({updated_at:"2026-01-01T17:00:00.000002+00:00"})
  expect(mergeSleepSessions([newer],[older])[0]).toEqual(newer)
  expect(mergeSleepSessions([older],[newer])[0]).toEqual(newer)
 })
 it("validates scope, version and the frozen operation id",()=>{
  expect(isSleepRequest({kind:"start",id,childId:child})).toBe(true)
  expect(isSleepRequest({kind:"stop",id,childId:child,version:"2026-01-01T00:00:00.000001Z",stopId:id})).toBe(true)
  expect(isSleepRequest({kind:"stop",id,childId:child})).toBe(false)
  expect(isSleepRequest({kind:"start",id,childId:child,end:"2026-01-01T00:00:00Z"})).toBe(false)
  expect(isSleepRequest({kind:"start",id,childId:"another child"})).toBe(false)
 })
})
