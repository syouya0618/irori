"use client"

import { useEffect, useRef, useState } from "react"
import { useFormStatus } from "react-dom"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Loader2, MessageSquarePlus, Send } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { submitFeedback } from "@/app/(main)/feedback/actions"
import { preventFormAutoReset } from "@/app/(main)/settings/prevent-form-auto-reset"
import { isClientId, newClientId } from "@/lib/utils/client-id"
import { toastOfflineError } from "@/lib/utils/offline-error"
import {
  FEEDBACK_BODY_MAX,
  FEEDBACK_TITLE_MAX,
  checkFeedbackText,
  countCodePoints,
  feedbackTextErrorMessage,
  normalizeFeedbackText,
} from "@/lib/domain/feedback"
import {
  appendDiagnostic,
  collectDiagnosticSummary,
  DIAGNOSTIC_HEADER,
  recordClientFailure,
} from "@/lib/diagnostics/diagnostic-summary"
import { clientBuildId } from "@/lib/release/build-info"
import { RELEASE_NAME } from "@/lib/release/release-notes"
import { noteServerActionFailure, STALE_CLIENT_ACTION_MESSAGE } from "@/lib/pwa/app-version"

/**
 * 下書きと送信の鍵の置き場（**sessionStorage**）。
 *
 * - 鍵（requestId）を下書きと一緒に持つのは、通信断の後に画面を開き直しても**同じ鍵で**
 *   送り直せるようにするため（応答だけが失われた送信が DB に在れば、同じ 1 行が返る）
 * - localStorage にせぬのは、共用端末で次の利用者に要望の下書きを残さぬため（タブ・PWA を
 *   閉じれば消える）。キーにも利用者 id を入れ、持ち主の違う下書きは読まぬ
 * - 読み書きは try/catch で包む（プライベートブラウズ等で例外になりうる）
 */
const DRAFT_KEY_PREFIX = "irori:feedback-draft:v1:"

interface Draft {
  requestId: string
  title: string
  /** 利用者が書いた本文（診断は含まぬ） */
  body: string
  /**
   * 添えると決めた診断の文面（2026-10-27 E4）。**鍵（requestId）ごとに 1 度だけ作って固定する** —
   * 押し直しのたびに作り直すと、追跡 id や経過が変わって本文が変わり、同じ鍵の再送が「別の内容」
   * （IRF01 の衝突）になる。添えておらねば null。
   */
  diagnostic: string | null
}

const DIAGNOSTIC_MAX_LENGTH = 800

function isDiagnosticText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(DIAGNOSTIC_HEADER) &&
    countCodePoints(value) <= DIAGNOSTIC_MAX_LENGTH
  )
}

function draftKey(userId: string): string {
  return `${DRAFT_KEY_PREFIX}${userId}`
}

function readDraft(userId: string): Draft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(userId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const { requestId, title, body, diagnostic } = parsed as Record<string, unknown>
    if (!isClientId(requestId) || typeof title !== "string" || typeof body !== "string") {
      return null
    }
    // 旧版の下書き（diagnostic を持たぬ）は「添えておらぬ」。形の崩れた診断も添えぬ側へ倒す
    return { requestId, title, body, diagnostic: isDiagnosticText(diagnostic) ? diagnostic : null }
  } catch (err) {
    console.warn("[feedback-form] 下書きを読めなかった", {
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

function writeDraft(userId: string, draft: Draft): void {
  try {
    sessionStorage.setItem(draftKey(userId), JSON.stringify(draft))
  } catch (err) {
    // 保存できぬ端末でも送信は止めぬ（同じ画面の中では鍵を ref に持っておる）。
    console.warn("[feedback-form] 下書きを保存できなかった", {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

function clearDraft(userId: string): void {
  try {
    sessionStorage.removeItem(draftKey(userId))
  } catch (err) {
    console.warn("[feedback-form] 下書きを消せなかった", {
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending} className="min-h-11 w-full cursor-pointer">
      {pending ? (
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
      ) : (
        <Send size={16} aria-hidden="true" />
      )}
      {pending ? "送信中…" : "送る"}
    </Button>
  )
}

/**
 * 要望の投稿フォーム。
 *
 * ## 二重送信・通信断で同じ要望を 2 件にせぬ
 * 1. 送る意図ごとに 1 つの鍵（UUID）を作り、**成功を確かめるまで変えぬ**。押し直し・再送・
 *    開き直し（sessionStorage）でも同じ鍵を送る → DB の UNIQUE が同じ 1 行を返す
 * 2. 送信中は `inFlightRef` が 2 度目の送信を捨て、ボタンも押せぬ（描画の前の連打も止める）
 * 3. 鍵が同じで文面が違う（通信断の後に書き直した）なら DB は IRF01 を返す。黙って古い方を
 *    返さず、鍵を作り直して「前の送信が届いておる」ことを知らせる
 *
 * ## `<form action>` を保つ
 * hydration 前の送信を React が捕まえて後で再生する（`onSubmit` だけにすると素の GET になり、
 * 要望の本文が URL・履歴・サーバのログに載る）。自動 reset は `preventFormAutoReset` で止め、
 * 失敗した時に打ち直しを強いぬ。欄は非制御（DOM の値 = FormData が正本）。
 */
export function FeedbackForm({ userId }: { userId: string }) {
  const router = useRouter()
  const titleRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const requestIdRef = useRef<string | null>(null)
  // 成功を確かめた鍵。**成功の直後に鍵を捨てぬ** —— React の form action は送信中の 2 度目を
  // 後から再生しうる（同じ FormData のまま）。鍵を捨てておれば 2 度目が新しい鍵で 2 件目を作る。
  // 鍵を替えるのは、利用者が次に欄を書き換えた時だけ（`handleEdit`）。
  const settledKeyRef = useRef<string | null>(null)
  const inFlightRef = useRef(false)
  const [titleLength, setTitleLength] = useState(0)
  const [bodyLength, setBodyLength] = useState(0)
  const [fieldError, setFieldError] = useState<{
    field: "title" | "body"
    message: string
  } | null>(null)
  const [formMessage, setFormMessage] = useState<string | null>(null)
  /** 同じ鍵で先に届いておった要望（conflict の時）。そこへ辿れるようにする */
  const [priorFeedbackId, setPriorFeedbackId] = useState<string | null>(null)
  /**
   * 添える診断の文面（null = 添えぬ。既定はオフ）。ここに入っておる文字列を**そのまま**見せ、
   * そのまま本文の末尾へ付けて送る。ref は送信の関数が最新の値を読むため（state と同じ値）
   */
  const [diagnostic, setDiagnostic] = useState<string | null>(null)
  const diagnosticRef = useRef<string | null>(null)

  function applyDiagnostic(next: string | null) {
    diagnosticRef.current = next
    setDiagnostic(next)
  }

  useEffect(() => {
    const draft = readDraft(userId)
    if (!draft) return
    requestIdRef.current = draft.requestId
    // 打ち始めておる欄は上書きせぬ（hydration 前に打った文字を消さぬ）。
    if (titleRef.current && titleRef.current.value === "") titleRef.current.value = draft.title
    if (bodyRef.current && bodyRef.current.value === "") bodyRef.current.value = draft.body
    // 開いた時点の端末保存（sessionStorage）から 1 度だけ復元する（外部ストアの読み出し）。
    setTitleLength(countCodePoints(titleRef.current?.value ?? ""))
    setBodyLength(countCodePoints(bodyRef.current?.value ?? ""))
    // 同じ鍵で添えておった診断は、作り直さずそのまま戻す（同じ内容の再送にするため）
    diagnosticRef.current = draft.diagnostic
    setDiagnostic(draft.diagnostic)
  }, [userId])

  function persistCurrentDraft() {
    requestIdRef.current ??= newClientId()
    writeDraft(userId, {
      requestId: requestIdRef.current,
      title: titleRef.current?.value ?? "",
      body: bodyRef.current?.value ?? "",
      diagnostic: diagnosticRef.current,
    })
  }

  /**
   * 「診断情報を添える」を切り替えた。添える時はその場で 1 度だけ作り（追跡 id も新しく作る）、
   * 送る本文が変わるゆえ欄の書き換えと同じ扱い（送り終えた鍵なら作り直す）にする。
   */
  function handleDiagnosticToggle(checked: boolean) {
    applyDiagnostic(
      checked ? collectDiagnosticSummary({ releaseName: RELEASE_NAME, buildId: clientBuildId() }) : null,
    )
    handleEdit()
  }

  /** 利用者が欄を書き換えた。送り終えた鍵のままなら、新しい要望として鍵を作り直す。 */
  function handleEdit() {
    if (requestIdRef.current !== null && requestIdRef.current === settledKeyRef.current) {
      requestIdRef.current = newClientId()
    }
    persistCurrentDraft()
  }

  function clearFields() {
    if (titleRef.current) titleRef.current.value = ""
    if (bodyRef.current) bodyRef.current.value = ""
    setTitleLength(0)
    setBodyLength(0)
    // 次の要望には添えぬ（既定のオフへ戻す）
    applyDiagnostic(null)
  }

  async function handleSubmit(formData: FormData) {
    // 描画の前の連打（disabled が反映される前の 2 度目）を捨てる。
    if (inFlightRef.current) return
    inFlightRef.current = true
    setFieldError(null)
    setFormMessage(null)
    setPriorFeedbackId(null)
    try {
      const rawTitle = formData.get("title")
      const rawBody = formData.get("body")
      const title = normalizeFeedbackText(typeof rawTitle === "string" ? rawTitle : "")
      const body = normalizeFeedbackText(typeof rawBody === "string" ? rawBody : "")

      const titleError = checkFeedbackText(title, {
        max: FEEDBACK_TITLE_MAX,
        multiline: false,
        required: true,
      })
      if (titleError) {
        setFieldError({
          field: "title",
          message: feedbackTextErrorMessage(titleError, { label: "要望", max: FEEDBACK_TITLE_MAX }),
        })
        titleRef.current?.focus()
        return
      }
      const bodyError = checkFeedbackText(body, {
        max: FEEDBACK_BODY_MAX,
        multiline: true,
        required: false,
      })
      if (bodyError) {
        setFieldError({
          field: "body",
          message: feedbackTextErrorMessage(bodyError, {
            label: "詳しい内容",
            max: FEEDBACK_BODY_MAX,
          }),
        })
        bodyRef.current?.focus()
        return
      }

      // 診断を添えるなら本文の末尾へ付ける。上限は付けた後の全体で数える（サーバと同じ）
      const attached = diagnosticRef.current
      const sentBody = appendDiagnostic(body, attached)
      if (attached !== null) {
        const combinedError = checkFeedbackText(sentBody, {
          max: FEEDBACK_BODY_MAX,
          multiline: true,
          required: false,
        })
        if (combinedError) {
          setFieldError({
            field: "body",
            message:
              combinedError === "too_long"
                ? `診断情報を添えると ${FEEDBACK_BODY_MAX} 文字を超えます。詳しい内容を短くするか、診断情報を外してください`
                : feedbackTextErrorMessage(combinedError, { label: "詳しい内容", max: FEEDBACK_BODY_MAX }),
          })
          bodyRef.current?.focus()
          return
        }
      }

      // 送る**前に**鍵と下書きを保存する（応答が返らぬまま閉じても、開き直して同じ鍵で送れる）。
      // 鍵は FormData と同じ瞬間の値で決める（再生された 2 度目も、送り終えた鍵を使う）。
      requestIdRef.current ??= newClientId()
      const requestId = requestIdRef.current
      if (requestId !== settledKeyRef.current) {
        writeDraft(userId, { requestId, title, body, diagnostic: attached })
      }
      const result = await submitFeedback({ requestId, title, body: sentBody })

      if (result.status === "created" || result.status === "duplicate") {
        settledKeyRef.current = requestId
        clearDraft(userId)
        clearFields()
        toast.success(
          result.status === "created"
            ? "要望を送りました"
            : "この要望は既に届いています",
        )
        router.push(`/feedback/${result.feedbackId}`)
        return
      }
      if (result.status === "conflict") {
        // 同じ鍵の前の送信が別の文面で届いておる。今の文面は残し、鍵だけ作り直す。
        // 一覧も読み直す（応答を失った初回の送信は、まだ画面の一覧に出ておらぬ）。
        requestIdRef.current = newClientId()
        persistCurrentDraft()
        setPriorFeedbackId(result.feedbackId)
        setFormMessage(
          "前に送った要望が既に届いています。内容を確かめ、書き直した内容も送りたいときは、もう一度「送る」を押してください",
        )
        router.refresh()
        return
      }
      if (result.field) {
        setFieldError({ field: result.field, message: result.error })
      } else {
        setFormMessage(result.error)
      }
      toast.error(result.error)
    } catch (err) {
      // 通信断。鍵と下書きは残す — 書き換えずに押し直せば DB が同じ 1 行に畳む。
      // 一覧も読み直しておく（届いておれば、押し直す前に一覧に出る）。読み直しの失敗は
      // 次の可視化で取り直すゆえ、ここでは待たぬ。
      if (noteServerActionFailure(err)) {
        // 古い画面のまま新しいデプロイへ送った（action が見つからぬ）。サーバでは何も実行されておらぬ
        recordClientFailure({ op: "feedback", kind: "stale-client" })
        setFormMessage(STALE_CLIENT_ACTION_MESSAGE)
        return
      }
      recordClientFailure({ op: "feedback", kind: "result-unknown" })
      toastOfflineError("[feedback-form] submitFeedback", err)
      setFormMessage(
        "送信できたか確かめられませんでした。そのままもう一度「送る」を押しても、同じ要望が二重に届くことはありません",
      )
      router.refresh()
    } finally {
      inFlightRef.current = false
    }
  }

  const titleInvalid = fieldError?.field === "title"
  const bodyInvalid = fieldError?.field === "body"

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquarePlus size={18} aria-hidden="true" />
          要望を送る
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          ref={preventFormAutoReset}
          action={handleSubmit}
          noValidate
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="feedback-title">要望（ひとことで）</Label>
            <Input
              id="feedback-title"
              ref={titleRef}
              name="title"
              autoComplete="off"
              enterKeyHint="next"
              // 上限はコードポイントで数える（DB と同じ）。maxLength は UTF-16 単位ゆえ、
              // 絵文字を含む正しい入力を切らぬよう倍にして「巨大な貼り付け」だけを止める。
              maxLength={FEEDBACK_TITLE_MAX * 2}
              placeholder="例: 夜は画面を暗くしてほしい"
              aria-invalid={titleInvalid || undefined}
              aria-describedby={titleInvalid ? "feedback-title-count feedback-title-error" : "feedback-title-count"}
              onChange={(event) => {
                setTitleLength(countCodePoints(event.currentTarget.value))
                handleEdit()
              }}
              className="h-11"
            />
            <p id="feedback-title-count" className="text-sm text-muted-foreground">
              {titleLength} / {FEEDBACK_TITLE_MAX} 文字
            </p>
            {titleInvalid && (
              <p id="feedback-title-error" role="alert" className="text-sm text-destructive">
                {fieldError.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="feedback-body">詳しい内容（任意）</Label>
            <Textarea
              id="feedback-body"
              ref={bodyRef}
              name="body"
              rows={5}
              maxLength={FEEDBACK_BODY_MAX * 2}
              placeholder="どの画面で・どんな時に困ったか、などを書いてください"
              aria-invalid={bodyInvalid || undefined}
              aria-describedby={bodyInvalid ? "feedback-body-count feedback-body-error" : "feedback-body-count"}
              onChange={(event) => {
                setBodyLength(countCodePoints(event.currentTarget.value))
                handleEdit()
              }}
              className="min-h-28"
            />
            <p id="feedback-body-count" className="text-sm text-muted-foreground">
              {bodyLength} / {FEEDBACK_BODY_MAX} 文字
            </p>
            {bodyInvalid && (
              <p id="feedback-body-error" role="alert" className="text-sm text-destructive">
                {fieldError.message}
              </p>
            )}
          </div>

          {/* 任意の診断（既定はオフ）。添える前に全文を見せ、その文面をそのまま本文の末尾へ付ける */}
          <div className="flex flex-col gap-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={diagnostic !== null}
                onChange={(event) => handleDiagnosticToggle(event.currentTarget.checked)}
                aria-describedby="feedback-diagnostic-note"
                className="size-5 shrink-0 cursor-pointer accent-primary"
              />
              診断情報を添える（任意）
            </label>
            <p id="feedback-diagnostic-note" className="text-sm text-muted-foreground">
              アプリの版・端末の種類・この画面で直近に起きた失敗の種類だけです。日記や記録の内容、赤ちゃんの名前、メールアドレスは含みません。
            </p>
            {diagnostic !== null && (
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium" id="feedback-diagnostic-preview-label">
                  添える内容（このまま本文の末尾に付きます）
                </p>
                <pre
                  aria-labelledby="feedback-diagnostic-preview-label"
                  data-testid="feedback-diagnostic-preview"
                  className="whitespace-pre-wrap break-words rounded-xl bg-muted px-3 py-2 font-sans text-sm text-foreground"
                >
                  {diagnostic}
                </pre>
                <p className="text-sm text-muted-foreground">
                  診断情報を含めて {(bodyLength === 0 ? 0 : bodyLength + 2) + countCodePoints(diagnostic)} / {FEEDBACK_BODY_MAX} 文字
                </p>
              </div>
            )}
          </div>

          <p className="text-sm text-muted-foreground">
            送った内容は、あなたと運用者だけが見られます。同じ世帯の家族にも表示されません。
          </p>

          {formMessage && (
            <div role="status" className="flex flex-col gap-1 rounded-xl bg-muted px-3 py-2 text-sm text-foreground">
              <p>{formMessage}</p>
              {priorFeedbackId && (
                <Link
                  href={`/feedback/${priorFeedbackId}`}
                  className="touch-target -mx-1 inline-flex w-fit items-center gap-1 rounded-lg px-1 font-medium underline underline-offset-4 transition-colors duration-200 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  前に届いた要望を見る
                </Link>
              )}
            </div>
          )}

          <SubmitButton />
        </form>
      </CardContent>
    </Card>
  )
}
