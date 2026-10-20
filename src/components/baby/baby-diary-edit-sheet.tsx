"use client"

import { useState, useTransition } from "react"
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
import { AlertCircle, Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  formatDiaryDateHeadingFromYmd,
  type BabyDiaryConflict,
} from "@/lib/domain/baby-diary"
import { upsertBabyDiary } from "@/app/(main)/baby/actions"
// startTransition 内の未処理 reject は error boundary へ bubble する。
// 圏外タップで全画面エラー化しないよう握ってトーストへ倒す（詳細は offline-error.ts）。
import { toastOfflineError } from "@/lib/utils/offline-error"
import type { BabyDiaryData } from "@/lib/types/baby"

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
}

/**
 * 育児日記の編集シート（1日1本）。空にして保存 = その日の日記を削除。
 * 親は dashboard の formKey 流儀で key 再マウントし、state を初期化式から再構築する。
 *
 * 保存が衝突（配偶者が先に保存 / 他端末で削除）したら、下書きは捨てずに textarea に
 * 残し、サーバの最新を並べて見せる。保持する版を最新へ進めるため、次の保存は
 * 相手の本文を見たうえでの意図した上書きになる。
 */
export function BabyDiaryEditSheet({
  open,
  onOpenChange,
  diaryDate,
  initialContent,
  initialUpdatedAt,
  onSaved,
}: BabyDiaryEditSheetProps) {
  const [content, setContent] = useState(initialContent)
  // 書いている日は開いた時点で固定する（親は開くたびに key で作り直す）。開いている最中に
  // 親の選択日が動いても（日跨ぎの自動追従など）、本文は開いた日のもの — prop をそのまま
  // 保存に使うと前日の本文を翌日の日記として upsert し、前日の日記が保存されぬ。
  const [targetDate] = useState(diaryDate)
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(initialUpdatedAt)
  const [conflict, setConflict] = useState<BabyDiaryConflict | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleSave() {
    startTransition(async () => {
      try {
        const result = await upsertBabyDiary(targetDate, content, expectedUpdatedAt)
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
        onSaved(result.diary, targetDate)
        toast.success(
          result.diary ? "日記を保存しました" : "日記を削除しました",
        )
        onOpenChange(false)
      } catch (err) {
        toastOfflineError("[baby-diary-edit-sheet] upsertBabyDiary", err)
      }
    })
  }

  const overwriting = conflict?.current != null
  // 衝突後に下書きが空（空白のみ含む。サーバは trim する）なら、保存は先に保存されていた
  // 行の条件付き DELETE になる。「上書き」と呼ぶと家族の本文を消す操作へ誘導するため、
  // 削除だと明示する。今の下書きで判定する（書き足せば上書きへ戻る）。
  const deletingCurrent = overwriting && content.trim() === ""

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
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
            placeholder="今日のできごとを書き残しましょう"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={isPending}
            rows={8}
            autoComplete="off"
            className="min-h-11 rounded-lg"
          />
        </div>

        <SheetFooter>
          <Button
            onClick={handleSave}
            disabled={isPending}
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
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
