"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { Loader2, Users } from "lucide-react"
import { joinByInviteToken } from "./actions"

export function JoinByInviteForm() {
  const [value, setValue] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    const trimmed = value.trim()
    if (!trimmed) {
      toast.error("招待リンクまたはコードを入力してください")
      return
    }

    setIsLoading(true)

    // 成功時: server action 内で redirect() が throw され、ここには戻らない
    // 失敗時: { error: string } が返る
    const result = await joinByInviteToken(trimmed)

    if (result?.error) {
      toast.error(result.error)
      setIsLoading(false)
    }
  }

  return (
    <div className="glass rounded-2xl p-6 shadow-lg shadow-black/[0.04]">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
        <Users className="size-6 text-primary" />
      </div>

      <div className="mb-4 text-center">
        <h2 className="text-base font-semibold text-foreground">
          招待を受けている方はこちら
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          家族から届いた招待リンクを貼り付けると、その世帯に参加できます
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="invite-link">招待リンク</Label>
          <Input
            id="invite-link"
            type="text"
            inputMode="url"
            placeholder="https://.../invite/..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={isLoading}
            autoComplete="off"
            className="min-h-11 rounded-lg"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={isLoading}
          className="min-h-11 w-full rounded-lg text-base font-semibold"
        >
          {isLoading ? (
            <>
              <Loader2 className="animate-spin" />
              参加中...
            </>
          ) : (
            "招待から参加する"
          )}
        </Button>
      </form>
    </div>
  )
}
