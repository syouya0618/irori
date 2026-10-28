"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { Loader2, Mail } from "lucide-react"
import {
  isSignInResultUnknown,
  messageForSignInError,
  SIGN_IN_RESULT_UNKNOWN_MESSAGE,
} from "@/lib/auth/auth-error-messages"
import {
  cooldownRemainingSec,
  raceWithTimeout,
  readLastSendAt,
  SIGN_IN_TIMEOUT_MS,
  writeLastSendAt,
} from "./login-resend"
import { recordClientFailure } from "@/lib/diagnostics/diagnostic-summary"

/**
 * - initial: 入力
 * - loading: 送信中
 * - sent: サーバが受け付けた（メールが届いたとは言わぬ — 配達は端末から確かめられぬ）
 * - unknown: 送れたか分からぬ（通信断・期限切れ）。届いておるかを先に確かめさせる
 */
type FormState = "initial" | "loading" | "sent" | "unknown"

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

/**
 * 再送の間隔の残り（1 秒ごとに読み直す。読み上げは釦の名前だけ — 毎秒の live region にはせぬ）。
 * 送った時刻を置く時は「今」も同じ値で置く（古い「今」と比べると、送った直後の 1 秒に釦が開いて
 * 連打できてしまう — 実際にテストで踏んだ）。
 */
function useCooldown(): {
  remaining: number
  lastSentAt: number | null
  setLastSentAt: (at: number | null, nowMs: number) => void
} {
  const [state, setState] = useState<{ lastSentAt: number | null; now: number }>({
    lastSentAt: null,
    now: 0,
  })
  const remaining = cooldownRemainingSec(state.lastSentAt, state.now)
  useEffect(() => {
    if (state.lastSentAt === null) return
    const id = setInterval(() => setState((s) => ({ ...s, now: Date.now() })), 1000)
    return () => clearInterval(id)
  }, [state.lastSentAt])
  return {
    remaining,
    lastSentAt: state.lastSentAt,
    setLastSentAt: (at, nowMs) => setState({ lastSentAt: at, now: nowMs }),
  }
}

/**
 * マジックリンクのログイン（既存方式を保つ。OTP コード方式・メールのテンプレート・SMTP は
 * 外部設定の承認が要るゆえここでは変えぬ）。2026-10-27 E3 で足したもの:
 * - 送信の期限（15 秒）と例外の捕捉。期限切れ・通信断は「送れたか分からぬ」として扱う
 * - 同じアドレスへの再送（60 秒の間隔を表示）。「別のアドレスで試す」とは分ける
 * - 期限切れ・別のブラウザで開いた時の戻り方の説明
 */
export function LoginForm() {
  const [email, setEmail] = useState("")
  const [formState, setFormState] = useState<FormState>("initial")
  // 送った後の画面からの再送か（送信中もその画面のまま待たせる）
  const [resending, setResending] = useState(false)
  // 最後に送った時刻（再送の間隔）。リロードを跨ぐよう sessionStorage から始める（アドレスは残さぬ）
  const { remaining: cooldown, setLastSentAt } = useCooldown()
  useEffect(() => {
    // 開いた時点の端末保存から 1 度だけ読む（外部ストアの読み出し）
    setLastSentAt(readLastSendAt(), Date.now())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 開いた時の 1 度だけ
  }, [])

  function markSent() {
    const at = Date.now()
    writeLastSendAt(at)
    setLastSentAt(at, at)
  }

  async function send(fromSentPanel = false) {
    const address = email.trim()
    if (!address) {
      toast.error("メールアドレスを入力してください")
      return
    }
    // 間隔で止めるのは「同じアドレスに送り直す」だけ。入力の画面からの送信（別のアドレス・
    // 再読込の後）は止めず、直前に送ったことを案内に出す（家族が同じ端末で続けて入る時を塞がぬ）
    if (fromSentPanel && cooldown > 0) return
    setResending(fromSentPanel)
    setFormState("loading")
    const startedAt = Date.now()
    try {
      const supabase = createClient()
      const outcome = await raceWithTimeout(
        supabase.auth.signInWithOtp({
          email: address,
          options: { emailRedirectTo: buildEmailRedirectTo(window.location.href) },
        }),
        SIGN_IN_TIMEOUT_MS,
      )
      if (outcome.kind === "timeout") {
        // 要求は取り消せぬ。届いておればメールは出る — 押し直しで上限に当たらぬよう間隔を置く
        console.error("[login] signInWithOtp が期限内に返りませんでした", { timeoutMs: SIGN_IN_TIMEOUT_MS })
        recordClientFailure({ op: "login", kind: "timeout", elapsedMs: Date.now() - startedAt })
        markSent()
        setFormState("unknown")
        return
      }
      const { error } = outcome.value
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
        if (isSignInResultUnknown(error)) {
          recordClientFailure({ op: "login", kind: "network", elapsedMs: Date.now() - startedAt })
          markSent()
          setFormState("unknown")
          return
        }
        recordClientFailure({
          op: "login",
          kind: (error.status ?? 0) >= 500 ? "http-5xx" : "rejected",
          elapsedMs: Date.now() - startedAt,
        })
        toast.error(messageForSignInError(error), { duration: 10_000 })
        setFormState("initial")
        return
      }
      markSent()
      setFormState("sent")
    } catch (err) {
      // 想定外の例外（auth-js は通常 error を返す）。送れたかは分からぬ側に倒す
      console.error("[login] signInWithOtp で例外", {
        message: err instanceof Error ? err.message : String(err),
      })
      recordClientFailure({ op: "login", kind: "result-unknown", elapsedMs: Date.now() - startedAt })
      markSent()
      setFormState("unknown")
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    await send()
  }

  const resendLabel =
    cooldown > 0 ? `同じアドレスに送り直す（あと${cooldown}秒）` : "同じアドレスに送り直す"

  if (formState === "sent" || formState === "unknown" || (formState === "loading" && resending)) {
    const unknown = formState === "unknown"
    return (
      <div className="glass rounded-2xl p-6 text-center shadow-lg shadow-black/[0.04]">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
          <Mail className="size-6 text-primary" aria-hidden="true" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">
          {unknown ? "送信できたか確かめられませんでした" : "ログインリンクを送りました"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground" role={unknown ? "alert" : undefined}>
          {unknown ? (
            SIGN_IN_RESULT_UNKNOWN_MESSAGE
          ) : (
            <>
              <span className="font-medium text-foreground">{email}</span>
              {" "}宛てに送信を受け付けました。メールを確認してリンクをタップしてください。届いていないときは、迷惑メールのフォルダも確かめてください。
            </>
          )}
        </p>
        {/*
          PKCE の検証子は「送信を押したブラウザ」の保存領域にしかない。ホーム画面の
          web app で送信してメールアプリからリンクを開くと別領域で開かれ、必ず失敗する。
          踏む前に伝えねば意味がないゆえ、送信直後のここに置く。
        */}
        <div className="mt-3 flex flex-col gap-1 rounded-lg bg-muted/50 p-2 text-left text-xs text-muted-foreground">
          <p>
            リンクは<span className="font-medium text-foreground">この画面と同じアプリ</span>で開いてください。別のブラウザで開くとログインできません。
          </p>
          <p>
            別のブラウザで開いてしまったときや、「期限切れ」「無効」と出たときは、この画面に戻って送り直してください。リンクには有効期限があり、使えるのは一度だけです。
          </p>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void send(true)}
            disabled={cooldown > 0 || formState === "loading"}
            className="min-h-11 w-full"
          >
            {formState === "loading" ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                送信中...
              </>
            ) : (
              resendLabel
            )}
          </Button>
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => {
              setFormState("initial")
              setEmail("")
            }}
          >
            別のメールアドレスで試す
          </Button>
        </div>
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
        {cooldown > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="login-recent-send">
            この端末から少し前に送ったばかりです。同じアドレスなら、まず届いていないか確かめてください。
          </p>
        )}
        <Button
          type="submit"
          disabled={formState === "loading"}
          className="min-h-11 w-full rounded-lg text-base font-semibold"
        >
          {formState === "loading" ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
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
