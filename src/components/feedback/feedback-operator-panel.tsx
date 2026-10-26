"use client"

import { useRef, useState } from "react"
import { useFormStatus } from "react-dom"
import { useRouter } from "next/navigation"
import { CircleCheck, Loader2, Save, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { releaseFeedback, updateFeedbackStatus } from "@/app/(main)/feedback/inbox/actions"
import { preventFormAutoReset } from "@/app/(main)/settings/prevent-form-auto-reset"
import { newClientId } from "@/lib/utils/client-id"
import { toastOfflineError } from "@/lib/utils/offline-error"
import { segmentCn } from "@/lib/utils/segment-cn"
import {
  COMMIT_SHA_RE,
  FEEDBACK_STATUS_LABELS,
  OPERATOR_SETTABLE_STATUSES,
  commitShaMatches,
  normalizeCommitSha,
  type FeedbackStatus,
  type OperatorFeedbackResult,
  type OperatorSettableStatus,
} from "@/lib/domain/feedback"

/** 「返信だけ（状態は変えない）」を表す選択肢の値。 */
const COMMENT_ONLY = "comment-only"
type StatusChoice = OperatorSettableStatus | typeof COMMENT_ONLY

function SubmitButton({
  label,
  pendingLabel,
  disabled,
  icon: Icon,
}: {
  label: string
  pendingLabel: string
  disabled?: boolean
  icon: typeof Save
}) {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      disabled={pending || disabled}
      className="min-h-11 w-full cursor-pointer"
    >
      {pending ? (
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
      ) : (
        <Icon size={16} aria-hidden="true" />
      )}
      {pending ? pendingLabel : label}
    </Button>
  )
}

/**
 * 結果をトーストと画面へ返す。**「届いた」とは言わぬ** —— 知らせは配信キューに入るだけで、
 * 端末に表示されたかは分からぬ。投稿者のアプリの画面には必ず出る、までが言える範囲じゃ。
 */
function useResultHandler() {
  const router = useRouter()
  return (result: OperatorFeedbackResult, successText: string): boolean => {
    if (result.status === "ok") {
      toast.success(result.duplicate ? "この操作は既に保存されていました" : successText)
      router.refresh()
      return true
    }
    if (result.status === "conflict") {
      toast.error("開いた後に更新されていました。最新の内容を読み込みます")
      router.refresh()
      return true
    }
    toast.error(result.error)
    return false
  }
}

/**
 * 運用者の操作パネル（状態の変更・返信 / 本番反映の確定）。
 *
 * - 冪等: 操作の鍵は**欄を書き換えるまで変えぬ**。通信断の後の押し直し・送信中の連打の再生は
 *   同じ鍵で送り、DB が内容を照合して「記録済み」として返す（履歴が二重に増えぬ）。
 *   欄を書き換えたら鍵を捨てる —— 書き直した返信・選び直した状態・直した SHA を、前の操作の
 *   再送として扱わせぬため（同じ鍵で内容が違えば DB も IRF01 で拒む）。成功の直後にも鍵は捨てぬ
 *   （送信中の 2 度目が後から再生されても、同じ鍵ゆえ「記録済み」に畳まれる）
 * - 描画の前の連打は `inFlightRef` が捨てる
 * - 版: 開いた時点の `version` を送る。誰かが先に更新しておれば DB が IRF03 で拒み、読み直す
 * - 反映済みは**別のフォーム**でしか立てられぬ（DB も通常の状態変更では released を拒む）
 */
export function FeedbackOperatorPanel({
  feedbackId,
  version,
  status,
  released,
  runningDeploy,
}: {
  feedbackId: string
  version: number
  status: FeedbackStatus | null
  /** 証拠付きの released か */
  released: boolean
  /** このサーバが観測した稼働中のデプロイ（"production:<sha>"）。取れねば null */
  runningDeploy: string | null
}) {
  return (
    <div className="flex flex-col gap-4">
      <StatusForm feedbackId={feedbackId} version={version} status={status} />
      {released ? (
        <p className="glass flex items-start gap-2 rounded-2xl p-4 text-sm shadow-lg shadow-black/[0.04]">
          <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          反映済みとして確定しています。差し戻す場合は、上で状態を選び、理由を返信に書いてください。
        </p>
      ) : (
        <ReleaseForm feedbackId={feedbackId} version={version} runningDeploy={runningDeploy} />
      )}
    </div>
  )
}

function StatusForm({
  feedbackId,
  version,
  status,
}: {
  feedbackId: string
  version: number
  status: FeedbackStatus | null
}) {
  const handleResult = useResultHandler()
  const requestIdRef = useRef<string | null>(null)
  const inFlightRef = useRef(false)
  const commentRef = useRef<HTMLTextAreaElement>(null)
  const mergeRef = useRef<HTMLInputElement>(null)
  const [choice, setChoice] = useState<StatusChoice>(COMMENT_ONLY)
  /** 運用者が欄を書き換えた。次の送信は新しい操作として新しい鍵で送る。 */
  const markEdited = () => {
    requestIdRef.current = null
  }

  const target: FeedbackStatus | null = choice === COMMENT_ONLY ? status : choice
  const showMergeRef = target === "in_progress"
  // 返信が要る場面（DB も同じ規則で拒む）: 見送り・反映済みからの差し戻し・
  // 返信だけの操作（マージの記録欄が無い時）。
  const commentRequired =
    choice === "declined" ||
    (choice !== COMMENT_ONLY && status === "released") ||
    (choice === COMMENT_ONLY && !showMergeRef)

  async function handleSubmit(formData: FormData) {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      requestIdRef.current ??= newClientId()
      const requestId = requestIdRef.current
      const comment = formData.get("comment")
      const merge = formData.get("merge_ref")
      const result = await updateFeedbackStatus({
        feedbackId,
        requestId,
        expectedVersion: version,
        status: choice === COMMENT_ONLY ? null : choice,
        comment: typeof comment === "string" ? comment : null,
        mergeRef: showMergeRef && typeof merge === "string" ? merge : null,
      })
      const settled = handleResult(
        result,
        choice === COMMENT_ONLY
          ? "返信を保存しました。投稿者の画面に表示されます"
          : `「${FEEDBACK_STATUS_LABELS[choice]}」にしました。投稿者の画面に表示されます`,
      )
      if (settled && result.status === "conflict") {
        // 読み直した上での次の操作は、新しい鍵で送る。
        requestIdRef.current = null
      }
      // 送信中に運用者が書き換えておれば（markEdited が鍵を捨てた）、その書きかけを消さぬ。
      if (result.status === "ok" && requestIdRef.current === requestId) {
        // 鍵は捨てぬ（上の docstring）。欄を空にしても onChange は起きぬゆえ鍵は残り、
        // 運用者が次に書き始めた時に markEdited が捨てる。
        if (commentRef.current) commentRef.current.value = ""
        if (mergeRef.current) mergeRef.current.value = ""
        setChoice(COMMENT_ONLY)
      }
    } catch (err) {
      // 通信断。鍵は残す（書き換えずに押し直せば、DB が内容を照合して「記録済み」に畳む）。
      toastOfflineError("[feedback-operator-panel] updateFeedbackStatus", err)
    } finally {
      inFlightRef.current = false
    }
  }

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle>状態を変える・返信する</CardTitle>
      </CardHeader>
      <CardContent>
        <form ref={preventFormAutoReset} action={handleSubmit} className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">新しい状態</legend>
            <div className="grid grid-cols-2 gap-2">
              {[COMMENT_ONLY, ...OPERATOR_SETTABLE_STATUSES].map((value) => {
                const isCurrent = value !== COMMENT_ONLY && value === status
                const label =
                  value === COMMENT_ONLY
                    ? "返信だけ"
                    : `${FEEDBACK_STATUS_LABELS[value as OperatorSettableStatus]}${isCurrent ? "（今）" : ""}`
                return (
                  <label
                    key={value}
                    className={`${segmentCn(choice === value)} flex cursor-pointer items-center justify-center has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring`}
                  >
                    <input
                      type="radio"
                      name="status_choice"
                      value={value}
                      checked={choice === value}
                      disabled={isCurrent}
                      onChange={() => {
                        setChoice(value as StatusChoice)
                        markEdited()
                      }}
                      className="sr-only"
                    />
                    {label}
                  </label>
                )
              })}
            </div>
            <p className="text-sm text-muted-foreground">
              「反映済み」はここでは選べません。本番で確かめてから、下の確定フォームで記録します。
            </p>
          </fieldset>

          <div className="flex flex-col gap-2">
            <Label htmlFor="feedback-operator-comment">
              返信（投稿者に表示されます）{commentRequired ? "" : "・任意"}
            </Label>
            <Textarea
              id="feedback-operator-comment"
              ref={commentRef}
              name="comment"
              rows={3}
              placeholder={
                choice === "declined"
                  ? "見送る理由を書いてください"
                  : "対応の予定や、確かめてほしいことなど"
              }
              onChange={markEdited}
              className="min-h-24"
            />
            {choice === "declined" && (
              <p className="text-sm text-muted-foreground">見送りには理由が必要です。</p>
            )}
            {choice !== COMMENT_ONLY && status === "released" && (
              <p className="text-sm text-muted-foreground">
                反映済みを取り消す時は、理由が必要です（投稿者には「反映済み」が消えて見えます）。
              </p>
            )}
          </div>

          {showMergeRef && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="feedback-operator-merge">取り込み済みの変更（任意）</Label>
              <Input
                id="feedback-operator-merge"
                ref={mergeRef}
                name="merge_ref"
                autoComplete="off"
                placeholder="例: PR #241"
                onChange={markEdited}
                className="h-11"
              />
              <p className="text-sm text-muted-foreground">
                PR のマージなどを記録します。本番への反映ではないため、投稿者には
                「本番への反映はまだです」と表示されます。
              </p>
            </div>
          )}

          <SubmitButton label="保存する" pendingLabel="保存中…" icon={Save} />
        </form>
      </CardContent>
    </Card>
  )
}

function ReleaseForm({
  feedbackId,
  version,
  runningDeploy,
}: {
  feedbackId: string
  version: number
  runningDeploy: string | null
}) {
  const handleResult = useResultHandler()
  const requestIdRef = useRef<string | null>(null)
  const inFlightRef = useRef(false)
  const shaRef = useRef<HTMLInputElement>(null)
  const [verified, setVerified] = useState(false)
  const [sha, setSha] = useState("")
  /** SHA・リリース情報・返信を書き換えた。直した確定は新しい鍵で送る（前の確定の再送にせぬ）。 */
  const markEdited = () => {
    requestIdRef.current = null
  }

  const runningSha = runningDeploy ? runningDeploy.split(":")[1] ?? null : null
  const normalizedSha = normalizeCommitSha(sha)
  const shaValid = COMMIT_SHA_RE.test(normalizedSha)
  const matchesRunning = runningSha !== null && shaValid && commitShaMatches(normalizedSha, runningSha)

  async function handleSubmit(formData: FormData) {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      requestIdRef.current ??= newClientId()
      const note = formData.get("release_note")
      const comment = formData.get("release_comment")
      const result = await releaseFeedback({
        feedbackId,
        requestId: requestIdRef.current,
        expectedVersion: version,
        commitSha: sha,
        releaseNote: typeof note === "string" ? note : null,
        productionVerified: verified,
        comment: typeof comment === "string" ? comment : null,
      })
      handleResult(result, "反映済みにしました。投稿者の画面に表示されます")
      // 衝突なら読み直した上で新しい鍵で送る。成功の時は鍵を捨てぬ（再生された 2 度目を畳む）。
      if (result.status === "conflict") requestIdRef.current = null
    } catch (err) {
      // 通信断。鍵は残す（書き換えずに押し直せば、DB が内容を照合して「記録済み」に畳む）。
      toastOfflineError("[feedback-operator-panel] releaseFeedback", err)
    } finally {
      inFlightRef.current = false
    }
  }

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleCheck size={18} aria-hidden="true" />
          本番への反映を確定する
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form ref={preventFormAutoReset} action={handleSubmit} className="flex flex-col gap-4">
          <p className="flex items-start gap-2 rounded-xl bg-muted px-3 py-2 text-sm text-foreground">
            <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            PR のマージやプレビューでの確認だけでは確定しないでください。本番の irori で
            変更が動いていることを確かめてから記録します。確定すると投稿者に「反映済み」と表示されます。
          </p>

          <div className="flex flex-col gap-2">
            <Label htmlFor="feedback-release-sha">確かめたコミット（SHA・7〜40 桁）</Label>
            <Input
              id="feedback-release-sha"
              ref={shaRef}
              name="commit_sha"
              value={sha}
              onChange={(event) => {
                setSha(event.currentTarget.value)
                markEdited()
              }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="例: 1f79ab4"
              aria-invalid={sha !== "" && !shaValid ? true : undefined}
              className="h-11 font-mono"
            />
            {runningSha ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>
                  このサーバの稼働中デプロイ:{" "}
                  <span className="font-mono">{runningDeploy}</span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setSha(runningSha)
                    markEdited()
                    shaRef.current?.focus()
                  }}
                  className="min-h-11 cursor-pointer"
                >
                  この SHA を入れる
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                稼働中のデプロイを読み取れませんでした（本番以外の環境など）。
              </p>
            )}
            {matchesRunning && (
              <p className="text-sm text-muted-foreground">稼働中のデプロイと同じコミットです。</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="feedback-release-note">リリース情報（任意）</Label>
            <Input
              id="feedback-release-note"
              name="release_note"
              autoComplete="off"
              placeholder="例: v1.7.0 / デプロイの URL"
              onChange={markEdited}
              className="h-11"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="feedback-release-comment">投稿者への返信（任意）</Label>
            <Textarea
              id="feedback-release-comment"
              name="release_comment"
              rows={3}
              placeholder="例: 夜間は画面が暗くなるようにしました"
              onChange={markEdited}
              className="min-h-24"
            />
          </div>

          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl bg-muted px-3 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
            <input
              type="checkbox"
              name="production_verified"
              checked={verified}
              onChange={(event) => setVerified(event.currentTarget.checked)}
              className="mt-0.5 size-5 shrink-0 accent-primary"
            />
            <span>本番環境で、この変更が動いていることを確かめました</span>
          </label>

          <SubmitButton
            label="反映済みにする"
            pendingLabel="確定中…"
            icon={CircleCheck}
            disabled={!verified || !shaValid}
          />
        </form>
      </CardContent>
    </Card>
  )
}
