import { expect,it,vi } from "vitest"
import { deliverDueNotifications } from "../deliver"
import { createFakeNotifySupabase,emptyNotifyDb } from "./fake-notify-db"
vi.mock("../deliver-news",()=>({deliverRegionalNews:vi.fn().mockRejectedValue(new Error("synthetic news outage"))}))
it("a complete news outage cannot stop the preceding calendar delivery or heartbeat",async()=>{
 vi.spyOn(console,"error").mockImplementation(()=>{})
 const db=emptyNotifyDb(),now="2026-10-30T23:00:00Z",h="synthetic-household",u="synthetic-user"
 db.profiles.push({id:u,household_id:h,role:"member",is_approved:true})
 db.push_subscriptions.push({id:"synthetic-sub",user_id:u,endpoint:"https://fcm.googleapis.com/synthetic-calendar",p256dh:"fixture-key",auth:"fixture-auth",failure_count:0})
 db.calendar_events.push({household_id:h,event_uid:"synthetic-event",title:"synthetic visit",is_all_day:false,start_date:"2026-10-31",start_at:"2026-10-30T23:10:00Z"})
 db.event_reminders.push({household_id:h,event_uid:"synthetic-event",remind_at:now})
 const fake=createFakeNotifySupabase(db),sendPush=vi.fn().mockResolvedValue({ok:true})
 const result=await deliverDueNotifications(fake.client,{now:()=>new Date(now),readVapid:()=>({publicKey:"fixture-public",privateKey:"fixture-private",subject:"mailto:fixture@example.invalid"}),sendPush})
 expect(sendPush).toHaveBeenCalledTimes(1);expect(result.sent).toBe(1);expect(result.failed).toBe(1);expect(db.notification_heartbeat).toHaveLength(1)
})
