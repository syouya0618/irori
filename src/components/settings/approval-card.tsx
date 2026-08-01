"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ShieldCheck, UserPlus, Loader2 } from "lucide-react"
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

export function ApprovalCard({ pendingUsers }: { pendingUsers: PendingUser[] }) {
  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck size={18} />
          承認待ち
          <span className="ml-auto rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">
            {pendingUsers.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {pendingUsers.map((pendingUser) => (
          <PendingUserRow key={pendingUser.id} user={pendingUser} />
        ))}
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
        className="shrink-0 cursor-pointer"
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
