// @vitest-environment jsdom
import { beforeEach,expect,it } from "vitest"
import { listRecordRequests,storeRecordRequest,removeRecordRequest,purgeOtherRecordRequests,type RecordRequest } from "../record-requests"
const owner={userId:"synthetic-user",householdId:"synthetic-household",childId:"e3000000-0000-4000-8000-000000000001"}
const r:RecordRequest={schema:1,id:"e3000000-0000-4000-8000-000000000002",owner,kind:"medical",payload:{childId:owner.childId,value:"frozen"}}
beforeEach(()=>localStorage.clear())
it("retains the first frozen payload, isolates scopes and removes only confirmed operations",()=>{expect(storeRecordRequest(r)).toBe(true);storeRecordRequest({...r,payload:{childId:owner.childId,value:"changed"}});expect(listRecordRequests(owner)[0].payload.value).toBe("frozen");expect(listRecordRequests({...owner,childId:r.id})).toEqual([]);expect(listRecordRequests({...owner,userId:"other"})).toEqual([]);removeRecordRequest(r);expect(listRecordRequests(owner)).toEqual([])})
it("purges another account without deleting siblings of the same owner",()=>{storeRecordRequest(r);purgeOtherRecordRequests({...owner,childId:r.id});expect(listRecordRequests(owner)).toHaveLength(1);purgeOtherRecordRequests({...owner,userId:"other"});expect(listRecordRequests(owner)).toEqual([])})

it("retains and reports future envelopes so another create cannot silently replace an unknown operation",async()=>{
 const {unreadableRecordCount,RECORD_REQUEST_PREFIX}=await import("../record-requests")
 const key=`${RECORD_REQUEST_PREFIX}${owner.userId}:${owner.householdId}:${owner.childId}:${r.id}`
 localStorage.setItem(key,JSON.stringify({...r,schema:2}));expect(listRecordRequests(owner)).toEqual([]);expect(unreadableRecordCount(owner)).toBe(1);expect(localStorage.getItem(key)).not.toBeNull();expect(unreadableRecordCount({...owner,userId:"other"})).toBe(0)
})
