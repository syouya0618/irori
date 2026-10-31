"use client"
import { usePathname } from "next/navigation"
import BabyLoading from "./loading/baby-loading"
import CalendarLoading from "./loading/calendar-loading"
import SettingsLoading from "./loading/settings-loading"
/** A persistent boundary retains the revealed page during a transition; cold loads keep their skeleton. */
export function MainLoading(){
 const path=usePathname()??"/baby"
 return <div role="status" aria-label="読み込み中" aria-busy="true">{path.startsWith("/calendar")?<CalendarLoading/>:path.startsWith("/settings")?<SettingsLoading/>:<BabyLoading/>}</div>
}
