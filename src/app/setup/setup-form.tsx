"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { Loader2, Home } from "lucide-react"
import { createHousehold } from "./actions"

export function SetupForm({ userId }: { userId: string }) {
  const router = useRouter()
  const [name, setName] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    const trimmedName = name.trim()
    if (!trimmedName) {
      toast.error("世帯名を入力してください")
      return
    }

    setIsLoading(true)

    const result = await createHousehold(trimmedName)

    if (result?.error) {
      toast.error(result.error)
      setIsLoading(false)
      return
    }

    router.push("/meals")
  }

  return (
    <div className="glass rounded-2xl p-6 shadow-lg shadow-black/[0.04]">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
        <Home className="size-6 text-primary" />
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="household-name">世帯名</Label>
          <Input
            id="household-name"
            type="text"
            placeholder="例: 田中家"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isLoading}
            required
            autoComplete="off"
            className="min-h-11 rounded-lg"
          />
          <p className="text-xs text-muted-foreground">
            あとから変更できます
          </p>
        </div>
        <Button
          type="submit"
          disabled={isLoading}
          className="min-h-11 w-full rounded-lg text-base font-semibold"
        >
          {isLoading ? (
            <>
              <Loader2 className="animate-spin" />
              作成中...
            </>
          ) : (
            "世帯を作成する"
          )}
        </Button>
      </form>
    </div>
  )
}
