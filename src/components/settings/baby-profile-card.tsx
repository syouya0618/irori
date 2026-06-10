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

export function BabyProfileCard({
  initialProfile,
}: {
  initialProfile: { name: string | null; birthDate: string | null }
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleSave = (formData: FormData) => {
    startTransition(async () => {
      const result = await updateBabyProfile(formData)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success("赤ちゃん情報を更新しました")
        router.refresh()
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
              className="h-10"
            />
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
