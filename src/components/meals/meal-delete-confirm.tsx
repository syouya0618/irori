"use client"

import { Button } from "@/components/ui/button"
import { Loader2, Trash2 } from "lucide-react"

interface MealDeleteConfirmProps {
  showDeleteConfirm: boolean
  setShowDeleteConfirm: (show: boolean) => void
  isPending: boolean
  handleDelete: () => void
}

export function MealDeleteConfirm({
  showDeleteConfirm,
  setShowDeleteConfirm,
  isPending,
  handleDelete,
}: MealDeleteConfirmProps) {
  return (
    <div className="border-t pt-3">
      {showDeleteConfirm ? (
        <div className="flex items-center gap-2">
          <p className="flex-1 text-sm text-destructive">
            本当に削除しますか？
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowDeleteConfirm(false)}
            disabled={isPending}
          >
            キャンセル
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={isPending}
          >
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              "削除する"
            )}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowDeleteConfirm(true)}
          className="w-full text-destructive hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
          この献立を削除
        </Button>
      )}
    </div>
  )
}
