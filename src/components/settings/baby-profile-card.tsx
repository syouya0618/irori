"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Baby, Loader2 } from "lucide-react"
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
// startTransition 内の未処理 reject は error boundary へ bubble する（offline-error.ts）
import { toastOfflineError } from "@/lib/utils/offline-error"
import { todayJstString } from "@/lib/utils/date-jst"
import { formatElapsedMinutes } from "@/lib/utils/baby-log-labels"
import { FEEDING_INTERVAL_OPTIONS } from "@/lib/domain/baby-feeding-interval"

export function BabyProfileCard({
  initialProfile,
}: {
  initialProfile: {
    name: string | null
    birthDate: string | null
    feedingIntervalMin: number
  }
}) {
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
        // 楽観更新は無いため巻き戻し不要（表示はサーバー値のまま）
        toastOfflineError("[baby-profile-card] updateBabyProfile", err)
      }
    })
  }

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Baby size={18} />
          赤ちゃん情報
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form action={handleSave} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="baby_name">名前</Label>
            <Input
              id="baby_name"
              name="baby_name"
              defaultValue={initialProfile.name ?? ""}
              placeholder="赤ちゃんの名前"
              className="h-10"
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
              className="h-10"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="feeding_interval_min">授乳間隔</Label>
            <select
              id="feeding_interval_min"
              name="feeding_interval_min"
              defaultValue={String(initialProfile.feedingIntervalMin)}
              className="h-10 rounded-md border bg-background px-3 text-sm transition-colors duration-200"
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
      </CardContent>
    </Card>
  )
}
