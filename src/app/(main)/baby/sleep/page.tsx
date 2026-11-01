import { getChildContext } from "@/lib/supabase/child-context"
import { SleepView } from "@/components/baby/sleep-view"
import { SLEEP_COLUMNS } from "@/lib/domain/sleep"
import { BABY_LOG_COLUMNS } from "@/lib/domain/baby-log-columns"
import { jstDayStartIso,shiftYmd,todayJstString } from "@/lib/utils/date-jst"
export default async function SleepPage({searchParams}:{searchParams:Promise<{child?:string}>}){
 const {supabase,child,userId,householdId}=await getChildContext((await searchParams).child)
 const from=jstDayStartIso(shiftYmd(todayJstString(),-9))
 const [{data:sessions,error:sleepError},{data:active,error:activeError},{data:feeding,error:feedingError}]=await Promise.all([
  supabase.from("sleep_sessions").select(SLEEP_COLUMNS).eq("household_id",householdId).eq("child_id",child.id).gte("started_at",from).order("started_at",{ascending:false}).limit(501),
  supabase.from("sleep_sessions").select(SLEEP_COLUMNS).eq("household_id",householdId).eq("child_id",child.id).is("ended_at",null).eq("voided",false).maybeSingle(),
  supabase.from("baby_logs").select(BABY_LOG_COLUMNS).eq("household_id",householdId).eq("child_id",child.id).eq("log_type","feeding").gte("logged_at",from).order("logged_at",{ascending:false}).limit(501),
 ])
 if(sleepError||activeError||feedingError)throw new Error("睡眠と授乳の記録を取得できませんでした")
 return <SleepView key={child.id} owner={{userId,householdId,childId:child.id}} childName={child.name} initialSessions={(sessions??[]).slice(0,500)} initialActive={active} feedings={(feeding??[]).slice(0,500)} truncated={(sessions?.length??0)>500||(feeding?.length??0)>500}/>
}
