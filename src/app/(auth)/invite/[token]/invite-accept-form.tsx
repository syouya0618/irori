"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { Loader2, Users } from "lucide-react"
import { acceptInvitation } from "./actions"
import type { HouseholdRole } from "@/lib/types/database"

interface InviteAcceptFormProps {
  invitationId: string
  householdName: string
  role: HouseholdRole
  userId: string
}

const roleLabels: Record<HouseholdRole, string> = {
  owner: "オーナー",
  member: "メンバー",
  viewer: "閲覧者",
}

export function InviteAcceptForm({
  invitationId,
  householdName,
  role,
  userId,
}: InviteAcceptFormProps) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)

  async function handleAccept() {
    setIsLoading(true)

    const result = await acceptInvitation(invitationId)

    if (result?.error) {
      toast.error(result.error)
      setIsLoading(false)
      return
    }

    toast.success("世帯に参加しました")
    router.push("/meals")
  }

  return (
    <div className="glass rounded-2xl p-6 shadow-lg shadow-black/[0.04]">
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
          <Users className="size-6 text-primary" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">世帯への招待</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          以下の世帯に招待されています
        </p>
      </div>

      <div className="mt-4 rounded-lg bg-secondary/50 px-4 py-3 text-center">
        <p className="text-base font-semibold text-foreground">
          {householdName}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {roleLabels[role]}として参加
        </p>
      </div>

      <Button
        onClick={handleAccept}
        disabled={isLoading}
        className="mt-6 min-h-11 w-full rounded-lg text-base font-semibold"
      >
        {isLoading ? (
          <>
            <Loader2 className="animate-spin" />
            参加中...
          </>
        ) : (
          "参加する"
        )}
      </Button>
    </div>
  )
}
