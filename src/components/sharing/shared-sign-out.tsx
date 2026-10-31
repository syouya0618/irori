"use client"
import { useState,useTransition } from "react"
import { unstable_rethrow } from "next/navigation"
import { signOut } from "@/app/(main)/settings/actions"
import { unsubscribeCurrentDevice } from "@/app/(main)/settings/push-actions"
import { unsubscribePushForSignOut } from "@/lib/pwa/push-unsubscribe"
import { clearCacheOwner,purgeHouseholdCaches } from "@/lib/pwa/sw-messages"
export function SharedSignOut() {
 const [pending,start]=useTransition()
 const [error,setError]=useState("")
 return <div className="mx-auto max-w-lg px-4 pb-8"><button disabled={pending} className="min-h-11 rounded-xl border px-4 text-sm" onClick={()=>start(async()=>{
  try { await unsubscribePushForSignOut(unsubscribeCurrentDevice);await purgeHouseholdCaches();const r=await signOut();setError(r.error) }
  catch(err){try{unstable_rethrow(err)}catch(signal){void clearCacheOwner();throw signal}setError("ログアウトを確認できませんでした。もう一度お試しください")}
 })}>{pending ? "ログアウト中" : "ログアウト"}</button>{error && <p role="alert" className="text-sm">{error}</p>}</div>
}
