"use client"
import { usePathname } from "next/navigation"
import BabyLoading from "./loading/baby-loading"
import CalendarLoading from "./loading/calendar-loading"
import ChoresLoading from "./loading/chores-loading"
import SettingsLoading from "./loading/settings-loading"
/** A persistent boundary retains the revealed page during a transition; cold loads keep their skeleton. */
export function MainLoading(){
 const path=usePathname()??"/baby"
 // 家事（/chores とその下位）で育児の骨組みを出さぬ。接頭辞が似ただけの path（/choresx）は家事ではない
 const chores=path==="/chores"||path.startsWith("/chores/")
 return <div role="status" aria-label="読み込み中" aria-busy="true">{path.startsWith("/calendar")?<CalendarLoading/>:path.startsWith("/settings")?<SettingsLoading/>:chores?<ChoresLoading/>:<BabyLoading/>}</div>
}
