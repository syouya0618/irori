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

export function GenerateFromMeals() {
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
      const result = await generateFromMeals()
      if (result.error) {
        toast.error(result.error)
      } else if (result.success) {
        toast.success(`${result.count}件の食材を追加しました`)
      }
      setOpen(false)
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
