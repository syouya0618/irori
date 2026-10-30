"use client"
import { useEffect,useRef,useState } from "react"
import Link from "next/link"
import { HOME_FOCUS_PREFIX,resolvedHomeFocus,type HomeFocus } from "@/lib/domain/home-priority"
import type { SaveOwner } from "@/lib/domain/save-attempt"
export function useHomeFocus(owner:SaveOwner&{childId:string}){
 const key=`${HOME_FOCUS_PREFIX}${owner.userId}:${owner.householdId}:${owner.childId}`
 const [choice,setChoice]=useState<HomeFocus>("auto"),scope=useRef(key)
 useEffect(()=>{Promise.resolve().then(()=>{try{const v=localStorage.getItem(scope.current);if(v==="sleep"||v==="medical"||v==="custom")setChoice(v)}catch{}})},[])
 function choose(value:HomeFocus){setChoice(value);try{localStorage.setItem(key,value)}catch{}}
 return {choice,choose}
}
const links={sleep:{label:"睡眠",path:"/baby/sleep"},medical:{label:"予防接種・健診",path:"/baby/medical"},custom:{label:"カスタム記録",path:"/baby/custom"}} as const
export function HomeTools({months,childId,choice,onChoose}:{months:number|null;childId:string;choice:HomeFocus;onChoose:(v:HomeFocus)=>void}){
 const focus=resolvedHomeFocus(months,choice),ordered=[focus,...(["sleep","medical","custom"] as const).filter(x=>x!==focus)]
 return <section aria-label="年齢に合わせた育児機能" className="flex flex-col gap-1"><nav className="grid grid-cols-4 gap-2" aria-label="育児機能">{ordered.map((id,i)=><Link key={id} prefetch={false} href={`${links[id].path}?child=${encodeURIComponent(childId)}`} className={`flex min-h-11 items-center justify-center rounded-xl border px-2 text-center text-xs ${i===0?"bg-primary/10 font-semibold text-primary":"text-muted-foreground"}`}>{links[id].label}</Link>)}<Link prefetch={false} href="/news" className="flex min-h-11 items-center justify-center rounded-xl border px-2 text-xs text-muted-foreground">ニュース</Link></nav>
  <details className="text-xs text-muted-foreground"><summary className="min-h-11 py-3">ホームの表示（{choice==="auto"?months===null?"年齢未設定":`${Math.floor(months)}か月・自動`:"自分で調整"}）</summary><label>優先する機能<select aria-label="ホームで優先する機能" value={choice} onChange={e=>onChoose(e.target.value as HomeFocus)} className="my-2 min-h-11 w-full rounded-xl border bg-background px-3"><option value="auto">年齢に合わせる</option><option value="sleep">睡眠・生活リズム</option><option value="medical">予防接種・健診</option><option value="custom">日記・カスタム記録</option></select></label><p>この端末・子どもごとに覚えます。記録の操作と履歴はいつでも利用できます。各カードは見出しから開閉できます。</p></details>
 </section>
}
