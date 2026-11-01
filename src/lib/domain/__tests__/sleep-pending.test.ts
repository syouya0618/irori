// @vitest-environment jsdom
import { beforeEach,describe,it,expect } from "vitest"
import { listPendingSleep,putPendingSleep,removePendingSleep,purgeOtherSleepRequests,SLEEP_PENDING_PREFIX,type PendingSleep } from "../sleep-pending"
const child="f2000000-0000-4000-8000-000000000001",one="f2000000-0000-4000-8000-000000000002",two="f2000000-0000-4000-8000-000000000003"
const owner={userId:"synthetic-user",householdId:"synthetic-household",childId:child}
const pending=(nonce:string):PendingSleep=>({schemaVersion:1,nonce,owner,request:{kind:"start",id:nonce,childId:child},phase:"unknown",createdAt:"2026-01-01T00:00:00Z"})
beforeEach(()=>localStorage.clear())
describe("durable sleep requests",()=>{
 it("keeps separate requests so another tab cannot overwrite the first unknown operation",()=>{putPendingSleep(pending(one));putPendingSleep(pending(two));expect(listPendingSleep(owner).items).toHaveLength(2);removePendingSleep(pending(two));expect(listPendingSleep(owner).items[0].nonce).toBe(one)})
 it("does not resurrect a confirmed request when a delayed failure arrives",()=>{putPendingSleep(pending(one));removePendingSleep(pending(one));expect(putPendingSleep(pending(one),true)).toBe(false);expect(listPendingSleep(owner).items).toEqual([])})
 it("filters owner and child, and only purges other account/household scopes",()=>{putPendingSleep(pending(one));expect(listPendingSleep({...owner,childId:two}).items).toEqual([]);expect(listPendingSleep({...owner,userId:"other"}).items).toEqual([]);purgeOtherSleepRequests({...owner,userId:"other"});expect(listPendingSleep(owner).items).toEqual([])})
 it("retains an unreadable or future envelope for explicit recovery",()=>{const key=`${SLEEP_PENDING_PREFIX}${owner.userId}:${owner.householdId}:${child}:${one}`;localStorage.setItem(key,JSON.stringify({...pending(one),schemaVersion:2}));expect(listPendingSleep(owner).unreadable).toBe(true);expect(localStorage.getItem(key)).not.toBeNull()})
})
