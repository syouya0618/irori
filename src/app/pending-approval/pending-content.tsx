"use client"

import { useState, useRef, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, Clock, LogOut, RefreshCw } from "lucide-react"
import { signOut } from "./actions"

export function PendingContent() {
  const router = useRouter()
  const [isChecking, setIsChecking] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  function handleCheck() {
    setIsChecking(true)
    router.refresh()
    timerRef.current = setTimeout(() => setIsChecking(false), 1500)
  }

  async function handleSignOut() {
    setIsSigningOut(true)
    await signOut()
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="glass rounded-2xl p-6 text-center shadow-lg shadow-black/[0.04]">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-amber-500/10">
            <Clock className="size-6 text-amber-500" />
          </div>

          <h2 className="text-lg font-semibold text-foreground">
            承認待ち
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            管理者の承認をお待ちください。承認されると自動的にアプリをご利用いただけます。
          </p>

          <div className="mt-6 flex flex-col gap-3">
            <Button
              onClick={handleCheck}
              disabled={isChecking}
              className="min-h-11 w-full rounded-lg text-base font-semibold"
            >
              {isChecking ? (
                <>
                  <Loader2 className="animate-spin" />
                  確認中...
                </>
              ) : (
                <>
                  <RefreshCw className="size-4" />
                  承認状態を確認
                </>
              )}
            </Button>

            <Button
              variant="ghost"
              onClick={handleSignOut}
              disabled={isSigningOut}
              className="min-h-11 w-full rounded-lg text-muted-foreground"
            >
              {isSigningOut ? (
                <Loader2 className="animate-spin" />
              ) : (
                <LogOut className="size-4" />
              )}
              ログアウト
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
