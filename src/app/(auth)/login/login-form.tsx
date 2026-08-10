"use client"

import { useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { Loader2, Mail } from "lucide-react"
import { messageForSignInError } from "@/lib/auth/auth-error-messages"

type FormState = "initial" | "loading" | "sent"

/**
 * `/auth/callback` へ渡す戻り先 URL を組み立てる。
 *
 * ⚠️ **`?error=` は必ず落とす。** ここは以前 `window.location.search` を丸ごと
 * 引き継いでおった。失敗理由を `/login?error=...` に載せるようにした今、素通し
 * すると **1 回目の失敗理由が 2 回目のリンクに紛れ込み、成功しても前回の
 * エラーを表示し続ける**罠になる。`returnTo` 等の他のクエリは従来どおり運ぶ。
 */
export function buildEmailRedirectTo(href: string): string {
  const url = new URL(href)
  const params = new URLSearchParams(url.search)
  params.delete("error")
  const query = params.toString()
  return `${url.origin}/auth/callback${query ? `?${query}` : ""}`
}

export function LoginForm() {
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
      email: email.trim(),
      options: { emailRedirectTo: buildEmailRedirectTo(window.location.href) },
    })

    if (error) {
      // ⚠️ 握り潰すな。ここは以前 error を丸ごと捨てて「送信に失敗しました」の
      // 一行だけを出しており、端末を触れぬ側からは原因が原理的に分からなかった。
      // Supabase の error は plain object ゆえ、フィールドを明示的に取り出す
      // （String(err) は "[object Object]" に化ける）。メールアドレスは PII ゆえ載せぬ。
      console.error("[login] signInWithOtp が失敗しました", {
        code: error.code,
        status: error.status,
        message: error.message,
        name: error.name,
      })
      toast.error(messageForSignInError(error), { duration: 10_000 })
      setFormState("initial")
      return
    }

    setFormState("sent")
  }

  if (formState === "sent") {
    return (
      <div className="glass rounded-2xl p-6 text-center shadow-lg shadow-black/[0.04]">
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
        {/*
          PKCE の検証子は「送信を押したブラウザ」の保存領域にしかない。ホーム画面の
          web app で送信してメールアプリからリンクを開くと別領域で開かれ、必ず失敗する。
          踏む前に伝えねば意味がないゆえ、送信直後のここに置く。
        */}
        <p className="mt-3 rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">
          リンクは<span className="font-medium text-foreground">この画面と同じアプリ</span>で開いてください。別のブラウザで開くとログインできません。
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
    )
  }

  return (
    <div className="glass rounded-2xl p-6 shadow-lg shadow-black/[0.04]">
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
    </div>
  )
}
