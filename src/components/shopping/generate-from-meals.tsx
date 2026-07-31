"use client"

import { useState, useTransition } from "react"
import { CalendarDays, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog"
import {
  generateFromMeals,
  previewMealIngredients,
} from "@/app/(main)/shopping/actions"
import type { ShoppingItemData } from "./shopping-item"
// startTransition 内の未処理 reject は error boundary へ bubble する（offline-error.ts）
import { toastOfflineError } from "@/lib/utils/offline-error"

interface GenerateFromMealsProps {
  /**
   * 追加成功時に、サーバが返した挿入行そのものを親へ渡す（楽観挿入用）。
   * Realtime の INSERT が届かぬ回（issue #92）でも一覧へ即反映する唯一の経路。
   */
  onAdded?: (items: ShoppingItemData[]) => void
}

export function GenerateFromMeals({ onAdded }: GenerateFromMealsProps = {}) {
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen)
    if (newOpen) {
      // ダイアログを開くときにプレビュー数を取得
      setIsLoadingPreview(true)
      previewMealIngredients()
        .then((result) => {
          setPreviewCount(result.count)
        })
        .catch(() => {
          setPreviewCount(0)
        })
        .finally(() => {
          setIsLoadingPreview(false)
        })
    }
  }

  const handleGenerate = () => {
    startTransition(async () => {
      try {
        const result = await generateFromMeals()
        if (result.error) {
          toast.error(result.error)
        } else if (result.success) {
          // 行が返らない実装/モックでも落ちないよう存在を確認してから渡す
          // （親は id で dedupe する前提のため undefined は流せない）。
          if (result.items) onAdded?.(result.items)
          toast.success(`${result.count}件の食材を追加しました`)
        }
        setOpen(false)
      } catch (err) {
        // 楽観挿入は無いため巻き戻し不要。ダイアログは閉じずに残し、
        // 電波が戻ったらそのまま再実行できるようにする。
        toastOfflineError("[generate-from-meals] generateFromMeals", err)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="lg"
            className="cursor-pointer flex-1"
          />
        }
      >
        <CalendarDays size={16} />
        献立から追加
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>献立から食材を追加</DialogTitle>
          <DialogDescription>
            {isLoadingPreview ? (
              <span className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                確認中...
              </span>
            ) : previewCount === 0 ? (
              "今週の献立から追加できる食材がありません。献立を登録するか、既にリストに追加済みでないか確認してください。"
            ) : (
              `今週の献立から${previewCount}件の食材を買い物リストに追加しますか？（既にリストにある食材は除外されます）`
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" className="cursor-pointer" />
            }
          >
            キャンセル
          </DialogClose>
          <Button
            onClick={handleGenerate}
            disabled={isPending || isLoadingPreview || previewCount === 0}
            className="cursor-pointer"
          >
            {isPending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : null}
            追加する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
