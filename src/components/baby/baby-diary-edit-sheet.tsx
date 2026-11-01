"use client"

import { useChildScope } from "./child-scope"

import { useEffect, useState, useTransition } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { AlertCircle, History, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  formatDiaryDateHeadingFromYmd,
  type BabyDiaryConflict,
} from "@/lib/domain/baby-diary"
import { upsertBabyDiary } from "@/app/(main)/baby/actions"
// startTransition 内の未処理 reject は error boundary へ bubble する。
// 圏外タップで全画面エラー化しないよう握ってトーストへ倒す（詳細は offline-error.ts）。
import { logOfflineError } from "@/lib/utils/offline-error"
import { SAVE_UNKNOWN_MESSAGE } from "@/lib/domain/save-attempt"
import { useDraft } from "@/lib/hooks/use-draft"
import { DRAFT_RETENTION_NOTE, type DraftOwner } from "@/lib/domain/draft-storage"
import { formatTimeJst, toJstDateString } from "@/lib/utils/date-jst"
import type { BabyDiaryData } from "@/lib/types/baby"

/** 日記の端末下書きの中身（`useDraft` の T） */
export interface DiaryDraftContent {
  text: string
}

export function isDiaryDraftContent(v: unknown): v is DiaryDraftContent {
  return typeof v === "object" && v !== null && typeof (v as { text?: unknown }).text === "string"
}

interface BabyDiaryEditSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * 対象日（YYYY-MM-DD, JST）。1日1本の日記のキー。**マウント時の値だけを使う**
   * （親が開くたびに key で作り直す前提。開いた後の変化は無視する）。
   */
  diaryDate: string
  /** 既存日記の本文（無ければ空文字）。親が key 再マウントで初期化する。 */
  initialContent: string
  /**
   * 既存日記の版（updated_at。無ければ null）。保存時にそのまま送り、サーバが
   * 「開いた時から誰も書き換えていない」ことを確かめる（P1-06 楽観的排他）。
   * 文字列のまま扱うこと — `new Date()` を通すとマイクロ秒が落ちて常に衝突する。
   */
  initialUpdatedAt: string | null
  /**
   * サーバで確定している日記（空保存で削除した時は null）と、書いた日を親へ渡す。
   * 保存成功時に加え、衝突時もサーバの最新（他端末で削除済みなら null）を渡して背後の
   * 表示を揃える。日付を添えるのは、保存の通信中に閉じられて親の選択日が動いた後でも、
   * 親が「選択日の日記か」を確かめられるようにするため（削除は diary が null ゆえ日付が要る）。
   */
  onSaved: (diary: BabyDiaryData | null, diaryDate: string) => void
  /**
   * 端末下書きの持ち主（2026-10-27 テーマ B）。null / 省略なら端末へは書かぬ（従来どおり、
   * 閉じると入力は消える）。同じ利用者・世帯・日付の下書きだけを戻す。
   */
  owner?: DraftOwner | null
}

/**
 * 育児日記の編集シート（1日1本）。空にして保存 = その日の日記を削除。
 * 親は dashboard の formKey 流儀で key 再マウントし、state を初期化式から再構築する。
 *
 * 保存が衝突（配偶者が先に保存 / 他端末で削除）したら、下書きは捨てずに textarea に
 * 残し、サーバの最新を並べて見せる。保持する版を最新へ進めるため、次の保存は
 * 相手の本文を見たうえでの意図した上書きになる。
 *
 * 端末下書き（2026-10-27）: 打った本文は止まってから端末へ写す（`useDraft`）。開き直し・再読込で
 * 「前回の下書きがあります」と出し、「戻す」「破棄」を選ばせる（自動では戻さぬ — 一貫して一つの
 * 方式）。下書きを始めた後に日記が別の端末で保存されておれば（版が違う）、その旨とサーバの本文を
 * 見せ、戻しても**下書きを始めた時の版**のまま送る — サーバが衝突を返し、既存の衝突の表示で
 * 見比べてから上書きを選ばせる（自動で上書きせぬ）。
 */
export function BabyDiaryEditSheet({
  open,
  onOpenChange,
  diaryDate,
  initialContent,
  initialUpdatedAt,
  onSaved,
  owner = null,
}: BabyDiaryEditSheetProps) {
  const childScope = useChildScope()
  const childId = childScope?.id
  const [content, setContent] = useState(initialContent)
  // 書いている日は開いた時点で固定する（親は開くたびに key で作り直す）。開いている最中に
  // 親の選択日が動いても（日跨ぎの自動追従など）、本文は開いた日のもの — prop をそのまま
  // 保存に使うと前日の本文を翌日の日記として upsert し、前日の日記が保存されぬ。
  const [targetDate] = useState(diaryDate)
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(initialUpdatedAt)
  const [conflict, setConflict] = useState<BabyDiaryConflict | null>(null)
  const [isPending, startTransition] = useTransition()

  // 下書きの版 = 下書きを始めた時に見ておったサーバの版。衝突で進めぬ（衝突の後に閉じても、
  // 開き直すと「別の端末で更新されています」と出て、もう一度見比べさせる）
  const [draftBaseVersion, setDraftBaseVersion] = useState(initialUpdatedAt)
  const draft = useDraft<DiaryDraftContent>({
    owner,
    target: { kind: "diary", date: targetDate },
    baseVersion: draftBaseVersion,
    isContent: isDiaryDraftContent,
    enabled: !isPending,
  })
  const restored = draft.restored
  // サーバの本文と同じ下書きは戻す意味が無い（保存は済んでおる）。黙って片付ける
  const offer = restored && restored.content.text !== initialContent ? restored : null
  const offerStale = offer !== null && offer.baseVersion !== initialUpdatedAt
  const [offerState, setOfferState] = useState<"pending" | "restored" | "dismissed">("pending")
  const offerPending = offer !== null && offerState === "pending"
  const [confirmClose, setConfirmClose] = useState(false)
  const { clear: clearDraft } = draft
  const redundantDraft = restored !== null && offer === null
  useEffect(() => {
    if (redundantDraft) clearDraft()
  }, [redundantDraft, clearDraft])

  function handleChange(next: string) {
    // 入力欄の値はそのまま持つ（trim・整形・書き戻しをせぬ。IME の変換中の値を壊さぬ）
    setContent(next)
    setConfirmClose(false)
    // 「前回の下書き」を戻すか破棄するか決める前は端末へ書かぬ — 書くと同じ鍵の前の下書きを無言で
    // 上書きし、「戻す」が見えておるのに閉じて開き直すと消えておる（独立レビュー 2026-10-28）
    if (offer && offerState === "pending") return
    if (next !== initialContent) {
      draft.update({ text: next })
    } else if (offerState !== "pending") {
      // 開いた時の本文へ戻した = 下書きは要らぬ。戻すか決めておらぬ下書きは消さぬ
      draft.clear()
    }
  }

  function restoreDraft() {
    if (!offer) return
    setContent(offer.content.text)
    // 下書きを始めた時の版で送る（古ければサーバが衝突を返す = 自動で上書きせぬ）
    setExpectedUpdatedAt(offer.baseVersion)
    setDraftBaseVersion(offer.baseVersion)
    setOfferState("restored")
  }

  function dismissDraft() {
    draft.clear()
    setOfferState("dismissed")
  }

  /**
   * 閉じる要求。入力が端末に残せぬ（書けなんだ・持ち主が無い）まま閉じようとしたら、閉じる前に
   * 「閉じると入力が消えます」と知らせる。残せる時はそのまま閉じる（閉じる時に書き切る）。
   */
  function handleOpenChange(next: boolean) {
    if (!next && owner && content !== initialContent && !confirmClose) {
      const result = draft.flush()
      const failed = (result !== null && !result.ok) || (result === null && draft.failureMessage !== null)
      if (failed) {
        setConfirmClose(true)
        return
      }
    }
    setConfirmClose(false)
    onOpenChange(next)
  }

  function handleSave() {
    startTransition(async () => {
      try {
        const result = await upsertBabyDiary(targetDate, content, expectedUpdatedAt, ...(childId ? [childId] as const : []))
        if (result.conflict) {
          // 下書き（content）には触れない。版を最新へ進め、相手の本文を見せる。
          setConflict(result.conflict)
          setExpectedUpdatedAt(result.conflict.current?.updated_at ?? null)
          onSaved(result.conflict.current, targetDate)
          return
        }
        if (result.error) {
          toast.error(result.error)
          return
        }
        // 保存できた = この日の下書きだけを消す。ただし「戻す/破棄」を選んでおらぬ前回の下書きは、
        // 保存した本文に入っておらぬゆえ消さぬ（独立レビュー 3 周目。仕様 B「正しい対象だけを消す」）
        if (!offerPending) draft.clear()
        onSaved(result.diary, targetDate)
        toast.success(
          result.diary ? "日記を保存しました" : "日記を削除しました",
        )
        onOpenChange(false)
      } catch (err) {
        // 例外は結果不明（保存が届いた後に応答だけが失われたかもしれぬ。「未保存」と決めつけぬ）。
        // 日記の保存は同じ本文なら成功として返る（冪等）ゆえ、同じ内容で送り直せば確かめられる。
        // 本文は端末へ書き切っておく（再読込しても戻せる）
        draft.flush()
        logOfflineError("[baby-diary-edit-sheet] upsertBabyDiary", err)
        toast.error(SAVE_UNKNOWN_MESSAGE)
      }
    })
  }

  const overwriting = conflict?.current != null
  // 衝突後に下書きが空（空白のみ含む。サーバは trim する）なら、保存は先に保存されていた
  // 行の条件付き DELETE になる。「上書き」と呼ぶと家族の本文を消す操作へ誘導するため、
  // 削除だと明示する。今の下書きで判定する（書き足せば上書きへ戻る）。
  const deletingCurrent = overwriting && content.trim() === ""
  // 下書きの書いた時刻（端末の時計。いつの下書きか分かるように添えるだけ）
  const offerWhen = offer
    ? `${toJstDateString(offer.updatedAt) === targetDate ? "" : `${toJstDateString(offer.updatedAt).slice(5).replace("-", "/")} `}${formatTimeJst(offer.updatedAt)}`
    : null

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom"
      >
        <SheetHeader className="pb-2">
          <SheetTitle>育児日記</SheetTitle>
          <SheetDescription>
            {formatDiaryDateHeadingFromYmd(targetDate)}
            ・空にして保存するとこの日の日記を削除します
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-2">
          {/* 端末に残っていた下書き（同じ利用者・世帯・日付だけ）。自動では戻さず選ばせる */}
          {offer && offerState === "pending" && (
            <div
              role="status"
              className={`flex flex-col gap-2 rounded-xl px-3 py-2 text-sm ${
                offerStale
                  ? "border border-amber-500/40 bg-amber-50 dark:bg-amber-950/40"
                  : "bg-primary/10"
              }`}
            >
              <p className="flex items-start gap-2 font-medium">
                <History size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                  前回の下書きがあります
                  {offerWhen && (
                    <span className="font-normal text-muted-foreground">（{offerWhen} に入力）</span>
                  )}
                </span>
              </p>
              {offerStale && (
                <p className="text-xs">
                  この日の日記は別の端末で更新されています。今の本文は下の入力欄に出しています。
                  下書きを戻して保存すると、保存の前に今の本文と見比べられます。
                </p>
              )}
              <p className="max-h-32 overflow-y-auto rounded-lg bg-background/60 p-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
                {offer.content.text}
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={restoreDraft} className="min-h-11 flex-1">
                  戻す
                </Button>
                <Button type="button" variant="ghost" onClick={dismissDraft} className="min-h-11 flex-1">
                  破棄
                </Button>
              </div>
            </div>
          )}

          {/* 古い版の下書きを戻した: サーバの今の本文を並べて見せる（自動では上書きせぬ） */}
          {offer && offerStale && offerState === "restored" && !conflict && (
            <div className="flex flex-col gap-1 rounded-xl border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950/40">
              <span className="text-xs font-medium">
                この日の日記は別の端末で更新されています。今の本文:
              </span>
              <p className="max-h-32 overflow-y-auto rounded-lg bg-background/60 p-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
                {initialContent || "（本文なし）"}
              </p>
            </div>
          )}

          {/* 保存の衝突。枠は予定の編集シートの保存前エラーと同じ部品・配色で組む。
              書いた人は断定しない（応答が失われた自分の保存・同じ利用者の別端末も
              同じ形で衝突する）。 */}
          {conflict && (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm"
            >
              <p className="flex items-start gap-2 font-medium text-destructive">
                <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {conflict.current
                  ? "この日の日記は別の端末で先に保存されていました（家族またはご自身）"
                  : "この日の日記は他の端末で削除されていました"}
              </p>
              <p className="text-xs text-muted-foreground">
                {!conflict.current
                  ? "あなたの下書きはそのまま残しています。「保存する」を押すと、この下書きで新しく保存します。"
                  : deletingCurrent
                    ? "下書きが空のため、保存すると先に保存されていた本文ごと削除されます。残す場合は本文を取り込むか、保存せずに閉じてください。"
                    : "あなたの下書きはそのまま残しています。先に保存されていた本文を確かめ、必要なら取り込んでから「上書きして保存する」を押してください。"}
              </p>
              {conflict.current && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    先に保存されていた本文
                  </span>
                  <p className="max-h-40 overflow-y-auto rounded-lg bg-background/60 p-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
                    {conflict.current.content}
                  </p>
                </div>
              )}
            </div>
          )}

          <Textarea
            aria-label="日記本文"
            aria-describedby="diary-draft-note"
            placeholder="今日のできごとを書き残しましょう"
            value={content}
            onChange={(e) => handleChange(e.target.value)}
            // 「前回の下書き」を戻すか破棄するか決めるまでは入力を止める（独立レビュー 2026-10-28）。
            // 打てると、前の下書きを上書きする（無言の消失）か、打った本文を端末に残せぬ（逆向きの
            // 消失）かのどちらかになる。選ぶのは 1 タップ
            disabled={isPending || offerPending}
            rows={8}
            autoComplete="off"
            className="min-h-11 rounded-lg"
          />
          {owner &&
            (offerPending ? (
              <p id="diary-draft-note" className="text-xs text-muted-foreground">
                上の「戻す」か「破棄」を選ぶと入力・保存できます（前回の下書きを消さぬため）
              </p>
            ) : draft.failureMessage ? (
              // 書けなんだ時は「下書き保存済み」と言わぬ
              <p id="diary-draft-note" role="alert" className="text-xs text-destructive">
                {draft.failureMessage}
              </p>
            ) : draft.externalChange === "cleared" ? (
              <p id="diary-draft-note" className="text-xs text-muted-foreground">
                別のタブでこの日の下書きが保存または破棄されました。この画面の入力はそのまま残っています。
              </p>
            ) : (
              <p id="diary-draft-note" className="text-xs text-muted-foreground">
                {DRAFT_RETENTION_NOTE}
              </p>
            ))}
        </div>

        <SheetFooter>
          {confirmClose ? (
            <div role="group" aria-labelledby="diary-close-title" className="flex flex-col gap-2">
              <p id="diary-close-title" className="text-sm font-medium text-destructive">
                {draft.failureMessage ?? "この端末に下書きを残せません。閉じると入力が消えます"}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmClose(false)}
                  className="min-h-11 flex-1"
                >
                  編集を続ける
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    setConfirmClose(false)
                    onOpenChange(false)
                  }}
                  className="min-h-11 flex-1"
                >
                  入力を捨てて閉じる
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={handleSave}
              // 選ぶまでは本文を直せぬゆえ保存するものも無い。保存させると、残した下書きが古い版を
              // 持ったまま残り、次に開いた時「別の端末で更新されています」と誤って出る（独立レビュー 3 周目）
              disabled={isPending || offerPending}
              variant={deletingCurrent ? "destructive" : "default"}
              className="min-h-11 w-full"
            >
              {isPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  保存中...
                </>
              ) : deletingCurrent ? (
                "保存されている日記を削除する"
              ) : overwriting ? (
                "上書きして保存する"
              ) : (
                "保存する"
              )}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
