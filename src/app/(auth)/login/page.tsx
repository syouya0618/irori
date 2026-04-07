"use client"

import { useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { Loader2, Mail, Flame } from "lucide-react"

type FormState = "initial" | "loading" | "sent"

export default function LoginPage() {
  const [email, setEmail] = useState("")
  const [formState, setFormState] = useState<FormState>("initial")

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    if (!email.trim()) {
      toast.error("メールアドレスを入力してください")
      return
    }

    setFormState("loading")

    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback${window.location.search}`,
      },
    })

    if (error) {
      toast.error("送信に失敗しました。もう一度お試しください。")
      setFormState("initial")
      return
    }

    setFormState("sent")
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* App branding */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <Flame className="size-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            うちのログ
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            夫婦の献立・買い物・暮らしをひとつに
          </p>
        </div>

        {/* Glass card */}
        <div className="glass rounded-2xl p-6 shadow-lg shadow-black/[0.04]">
          {formState === "sent" ? (
            <div className="text-center">
              <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
                <Mail className="size-6 text-primary" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">
                メールを送信しました
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{email}</span>
                {" "}にログインリンクを送信しました。メールを確認してリンクをタップしてください。
              </p>
              <Button
                variant="ghost"
                className="mt-4"
                onClick={() => {
                  setFormState("initial")
                  setEmail("")
                }}
              >
                別のメールアドレスで試す
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">メールアドレス</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="example@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={formState === "loading"}
                  required
                  autoComplete="email"
                  className="min-h-11 rounded-lg"
                />
              </div>
              <Button
                type="submit"
                disabled={formState === "loading"}
                className="min-h-11 w-full rounded-lg text-base font-semibold"
              >
                {formState === "loading" ? (
                  <>
                    <Loader2 className="animate-spin" />
                    送信中...
                  </>
                ) : (
                  "マジックリンクを送信"
                )}
              </Button>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          パスワード不要。メールアドレスだけでログインできます。
        </p>
      </div>
    </div>
  )
}
