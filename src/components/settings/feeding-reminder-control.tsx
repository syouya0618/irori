"use client"

import { useState, useTransition } from "react"
import { Milk } from "lucide-react"
import { updateFeedingReminder } from "@/app/(main)/settings/actions"
import { FEEDING_REMINDER_DEFAULT, FEEDING_REMINDER_OPTIONS } from "@/lib/notifications/feeding-rules"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const items = [
  { value: "none", label: "通知しない" },
  ...FEEDING_REMINDER_OPTIONS.map((m) => ({ value: String(m), label: `${m}分前` })),
]

export function FeedingReminderControl({ minutes, unknown, reachable, reachabilityKnown }: {
  minutes: number | null; unknown: boolean; reachable: boolean; reachabilityKnown: boolean
}) {
  const [choice, setChoice] = useState(minutes === null ? "none" : String(minutes))
  const [uncertain, setUncertain] = useState(false)
  const [message, setMessage] = useState("")
  const [pending, startTransition] = useTransition()
  const unavailable = unknown || uncertain
  function save(next: string) {
    if (pending || unavailable || next === choice) return
    startTransition(async () => {
      try {
        setMessage("")
        const result = await updateFeedingReminder(next === "none" ? null : Number(next))
        if (result.error) {
          setMessage(result.error)
          setUncertain(true)
          return
        }
        setChoice(next)
        setMessage(next === "none" ? "授乳の通知を止めました。" : "授乳の通知時間を保存しました。")
      } catch {
        // 応答の喪失は「保存されなかった」証明ではない。旧値を確定として見せない。
        setUncertain(true)
        setMessage("保存結果を確認できません。再読み込みして設定を確かめてください。")
      }
    })
  }
  const shownItems = unavailable ? [{ value: "unknown", label: "確認できません" }, ...items] : items
  return (
    <section aria-label="次の授乳の通知" className="flex flex-col gap-2">
      <Label htmlFor="feeding-reminder" className="flex items-center gap-1.5 text-sm font-medium">
        <Milk size={14} aria-hidden="true" />次の授乳を通知
      </Label>
      <p id="feeding-reminder-help" className="text-xs text-muted-foreground">
        最後の授乳開始と授乳間隔から、次の目安をお知らせします。搾乳は含みません。
        目安は授乳の指示ではありません。赤ちゃんの様子に合わせてください。
        5分間隔で確認するため、通知が遅れる場合があります。
      </p>
      <Select items={shownItems} value={unavailable ? "unknown" : choice}
        onValueChange={(value) => { if (value !== null) void save(value) }} disabled={pending || unavailable}>
        <SelectTrigger id="feeding-reminder" aria-label="次の授乳を通知する時間"
          aria-describedby="feeding-reminder-help" className="min-h-11 w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{shownItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
      {choice === "none" && !unavailable && <Button type="button" variant="outline" className="min-h-11 self-start"
        disabled={pending} onClick={() => void save(String(FEEDING_REMINDER_DEFAULT))}>15分前で始める</Button>}
      {!unavailable && choice !== "none" && reachabilityKnown && !reachable &&
        <p className="text-xs text-muted-foreground">通知を受け取る端末がありません。この端末または受け取りたい端末で、上の通知登録を行ってください。</p>}
      {unavailable && <p className="text-xs text-muted-foreground">授乳通知の設定を確認できません。再読み込みしてください（通知がOFFとは限りません）。</p>}
      <p role="status" className="text-xs text-muted-foreground">{pending ? "保存しています…" : message}</p>
    </section>
  )
}
