"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ShieldCheck, UserPlus, Loader2, TriangleAlert } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { approveUser } from "@/app/(main)/settings/actions"
// 注意: ここは startTransition ではなくプレーンな async onClick ゆえ、reject は
// error boundary へ bubble せず **無言の unhandled rejection** になる（機序が別）。
import { toastOfflineError } from "@/lib/utils/offline-error"

export interface PendingUser {
  id: string
  display_name: string
  email: string
  created_at: string
}

/**
 * 承認待ち（インスタンスの運用者だけに出す・P1-02）。
 *
 * ⚠️ **承認は世帯への参加ではない（P2-26）。** approve_user は is_approved を立てるだけで、
 * 承認された人は /setup で**自分の世帯を新しく作る**。一度世帯に入ると退出も移籍も
 * できぬゆえ、家族を迎える操作だと誤読されると夫婦の世帯が二つに割れて戻せぬ。
 * 文言はこの事実と、家族を迎える正しい道（招待リンク）を必ず書いておくこと。
 *
 * `pendingUsers` が null = 一覧を**読めなかった**（＝0 件とは限らぬ）。
 */
export function ApprovalCard({
  pendingUsers,
}: {
  pendingUsers: PendingUser[] | null
}) {
  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck size={18} />
          承認待ち
          {pendingUsers && (
            <span className="ml-auto rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">
              {pendingUsers.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          このアプリに新しく登録した人です。承認すると、その人は自分の世帯を新しく作れるようになります。あなたの世帯には追加されません。
          家族を世帯に迎えるときは、「メンバー招待」から招待リンクを送ってください。
        </p>
        {pendingUsers ? (
          pendingUsers.map((pendingUser) => (
            <PendingUserRow key={pendingUser.id} user={pendingUser} />
          ))
        ) : (
          <p
            role="alert"
            className="flex items-start gap-2 text-sm text-muted-foreground"
          >
            <TriangleAlert
              size={16}
              className="mt-0.5 shrink-0 text-destructive"
              aria-hidden="true"
            />
            承認待ちの一覧を取得できませんでした。承認待ちがいないとは限りません。
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function PendingUserRow({ user }: { user: PendingUser }) {
  const router = useRouter()
  const [isApproving, setIsApproving] = useState(false)

  async function handleApprove() {
    setIsApproving(true)
    try {
      const result = await approveUser(user.id)
      if (result.error) {
        toast.error(result.error)
        setIsApproving(false)
      } else {
        toast.success(`${user.email} を承認しました`)
        router.refresh()
      }
    } catch (err) {
      // approveUser は redirect/notFound を投げない（settings/actions.ts の
      // approveUser は必ず { error } / { success } を返す）ため unstable_rethrow は不要。
      setIsApproving(false)
      toastOfflineError("[approval-card] approveUser", err)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 overflow-hidden">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <UserPlus size={16} className="text-muted-foreground" />
        </div>
        <div className="overflow-hidden">
          <p className="truncate text-sm font-medium">
            {user.display_name || user.email}
          </p>
          {user.display_name && (
            <p className="truncate text-xs text-muted-foreground">
              {user.email}
            </p>
          )}
        </div>
      </div>
      <Button
        size="sm"
        onClick={handleApprove}
        disabled={isApproving}
        className="min-h-11 shrink-0 cursor-pointer"
      >
        {isApproving ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          "承認"
        )}
      </Button>
    </div>
  )
}
