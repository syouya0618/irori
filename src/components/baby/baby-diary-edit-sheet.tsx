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
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { formatDiaryDateHeadingFromYmd } from "@/lib/domain/baby-diary"
import { upsertBabyDiary } from "@/app/(main)/baby/actions"
// startTransition 内の未処理 reject は error boundary へ bubble する。
// 圏外タップで全画面エラー化しないよう握ってトーストへ倒す（詳細は offline-error.ts）。
import { toastOfflineError } from "@/lib/utils/offline-error"
import type { BabyDiaryData } from "@/lib/types/baby"

interface BabyDiaryEditSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 対象日（YYYY-MM-DD, JST）。1日1本の日記のキー。 */
  diaryDate: string
  /** 既存日記の本文（無ければ空文字）。親が key 再マウントで初期化する。 */
  initialContent: string
  /** 保存成功時に確定した日記（空保存で削除した時は null）を親へ渡す */
  onSaved: (diary: BabyDiaryData | null) => void
}

/**
 * 育児日記の編集シート（1日1本・upsert）。空にして保存 = その日の日記を削除。
 * 親は dashboard の formKey 流儀で key 再マウントし、state を初期化式から再構築する。
 */
export function BabyDiaryEditSheet({
  open,
  onOpenChange,
  diaryDate,
  initialContent,
  onSaved,
}: BabyDiaryEditSheetProps) {
  const [content, setContent] = useState(initialContent)
  const [isPending, startTransition] = useTransition()

  function handleSave() {
    startTransition(async () => {
      try {
        const result = await upsertBabyDiary(diaryDate, content)
        if (result.error) {
          toast.error(result.error)
          return
        }
        onSaved(result.diary)
        toast.success(
          result.diary ? "日記を保存しました" : "日記を削除しました",
        )
        onOpenChange(false)
      } catch (err) {
        toastOfflineError("[baby-diary-edit-sheet] upsertBabyDiary", err)
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom"
      >
        <SheetHeader className="pb-2">
          <SheetTitle>育児日記</SheetTitle>
          <SheetDescription>
            {formatDiaryDateHeadingFromYmd(diaryDate)}
            ・空にして保存するとこの日の日記を削除します
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-2">
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
            className="min-h-11 w-full"
          >
            {isPending ? (
              <>
                <Loader2 className="animate-spin" />
                保存中...
              </>
            ) : (
              "保存する"
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
