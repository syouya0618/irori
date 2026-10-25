"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Baby, Loader2, TriangleAlert } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateBabyProfile } from "@/app/(main)/settings/actions"
import { preventFormAutoReset } from "@/app/(main)/settings/prevent-form-auto-reset"
// startTransition 内の未処理 reject は error boundary へ bubble する（offline-error.ts）
import { toastOfflineError } from "@/lib/utils/offline-error"
import { todayJstString } from "@/lib/utils/date-jst"
import { formatElapsedMinutes } from "@/lib/utils/baby-log-labels"
import { FEEDING_INTERVAL_OPTIONS } from "@/lib/domain/baby-feeding-interval"

interface BabyProfile {
  name: string | null
  birthDate: string | null
  feedingIntervalMin: number
}

export function BabyProfileCard({
  initialProfile,
}: {
  /**
   * null = 世帯を**読めなかった**（＝空欄とは限らぬ）。空欄のフォームを出せば、
   * 保存の 1 クリックで名前と生年月日を NULL に上書きする（P2-31）。
   */
  initialProfile: BabyProfile | null
}) {
  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Baby size={18} />
          赤ちゃん情報
        </CardTitle>
      </CardHeader>
      <CardContent>
        {initialProfile ? (
          <BabyProfileForm initialProfile={initialProfile} />
        ) : (
          // ⚠️ **「読めなかった」を「未設定」として描かぬ**（通知カードの digest と同じ筋）。
          // 保存の口を出さぬことで、一過性の障害の最中の上書きを構造的に塞ぐ。
          <p
            role="alert"
            className="flex items-start gap-2 text-sm text-muted-foreground"
          >
            <TriangleAlert
              size={16}
              className="mt-0.5 shrink-0 text-destructive"
              aria-hidden="true"
            />
            赤ちゃん情報を取得できませんでした。上書きを防ぐため、今は変更できません。
            時間をおいて開き直してください。
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function BabyProfileForm({ initialProfile }: { initialProfile: BabyProfile }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleSave = (formData: FormData) => {
    startTransition(async () => {
      try {
        const result = await updateBabyProfile(formData)
        if (result.error) {
          toast.error(result.error)
        } else {
          toast.success("赤ちゃん情報を更新しました")
          router.refresh()
        }
      } catch (err) {
        // 楽観更新は無いため巻き戻し不要（入力は打ったまま残る）
        toastOfflineError("[baby-profile-card] updateBabyProfile", err)
      }
    })
  }

  return (
    // ⚠️ **ref を外すな（P2-30）。** React 19 は action の後でフォームを無条件に reset し、
    // select は初回描画の defaultValue へ戻る。続けて名前だけを直して保存すると授乳間隔が
    // 黙って巻き戻る。`onReset` では止まらず、onSubmit へ替えると hydration 前の送信が
    // 素の GET になる —— 理由は preventFormAutoReset の docstring。
    <form
      ref={preventFormAutoReset}
      action={handleSave}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="baby_name">名前</Label>
        <Input
          id="baby_name"
          name="baby_name"
          defaultValue={initialProfile.name ?? ""}
          placeholder="赤ちゃんの名前"
          className="h-11"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="baby_birth_date">生年月日</Label>
        <Input
          id="baby_birth_date"
          name="baby_birth_date"
          type="date"
          defaultValue={initialProfile.birthDate ?? ""}
          max={todayJstString()}
          className="h-11"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="feeding_interval_min">授乳間隔</Label>
        <select
          id="feeding_interval_min"
          name="feeding_interval_min"
          defaultValue={String(initialProfile.feedingIntervalMin)}
          className="h-11 rounded-md border bg-background px-3 text-sm transition-colors duration-200"
        >
          {FEEDING_INTERVAL_OPTIONS.map((min) => (
            <option key={min} value={min}>
              {formatElapsedMinutes(min)}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          最後の授乳の開始からこの時間後を「次の授乳の目安」に表示します（搾乳は起点になりません）
        </p>
      </div>
      <Button
        type="submit"
        size="lg"
        disabled={isPending}
        className="cursor-pointer self-end"
      >
        {isPending ? (
          <Loader2 size={16} className="animate-spin" />
        ) : null}
        保存
      </Button>
    </form>
  )
}
