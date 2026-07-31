"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { User, Loader2 } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { updateProfile } from "@/app/(main)/settings/actions"
// startTransition 内の未処理 reject は error boundary へ bubble する（offline-error.ts）
import { toastOfflineError } from "@/lib/utils/offline-error"

interface ProfileCardProps {
  profile: {
    displayName: string
  }
  email: string
}

export function ProfileCard({ profile, email }: ProfileCardProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const handleUpdateProfile = (formData: FormData) => {
    startTransition(async () => {
      try {
        const result = await updateProfile(formData)
        if (result.error) {
          toast.error(result.error)
        } else {
          toast.success("プロフィールを更新しました")
          router.refresh()
        }
      } catch (err) {
        // 楽観更新は無いため巻き戻し不要（表示はサーバー値のまま）
        toastOfflineError("[profile-card] updateProfile", err)
      }
    })
  }

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <User size={18} />
          プロフィール
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form action={handleUpdateProfile} className="flex flex-col gap-4">
          {/* アバタープレースホルダー */}
          <div className="flex items-center gap-4">
            <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
              <User size={28} />
            </div>
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium">{profile.displayName || "未設定"}</p>
              <p className="text-xs text-muted-foreground">{email}</p>
            </div>
          </div>

          <Separator />

          <div className="flex flex-col gap-2">
            <Label htmlFor="display_name">表示名</Label>
            <Input
              id="display_name"
              name="display_name"
              defaultValue={profile.displayName}
              placeholder="表示名を入力"
              required
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
