import { Skeleton } from "@/components/ui/skeleton"

export default function ShoppingLoading() {
  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-8">
      {/* ヘッダー */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-32 rounded-md" />
        <Skeleton className="h-4 w-20 rounded-md" />
      </div>

      {/* 追加フォーム スケルトン */}
      <Skeleton className="h-11 w-full rounded-lg" />

      {/* タブ スケルトン */}
      <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-8 flex-1 rounded-md" />
        ))}
      </div>

      {/* カテゴリーグループ スケルトン */}
      {Array.from({ length: 3 }, (_, groupIndex) => (
        <div key={groupIndex} className="mt-1">
          {/* カテゴリーヘッダー */}
          <div className="flex items-center gap-2 px-1 pb-1 pt-3">
            <Skeleton className="size-3.5 rounded-sm" />
            <Skeleton className="h-3 w-12 rounded-md" />
          </div>

          {/* アイテム一覧 */}
          <div className="glass divide-y divide-border/30 rounded-2xl shadow-lg shadow-black/[0.04]">
            {Array.from(
              { length: groupIndex === 0 ? 4 : groupIndex === 1 ? 3 : 2 },
              (_, itemIndex) => (
                <div
                  key={itemIndex}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  {/* チェックボックス */}
                  <Skeleton className="size-5 flex-shrink-0 rounded-md" />

                  {/* テキスト */}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Skeleton className="h-4 w-24 rounded-md" />
                    <Skeleton className="h-3 w-14 rounded-md" />
                  </div>

                  {/* バッジ */}
                  <Skeleton className="h-5 w-14 flex-shrink-0 rounded-full" />
                </div>
              )
            )}
          </div>
        </div>
      ))}

      {/* アクションボタン スケルトン */}
      <div className="mt-2 flex items-center gap-2">
        <Skeleton className="h-11 flex-1 rounded-lg" />
        <Skeleton className="h-11 flex-1 rounded-lg" />
      </div>
    </div>
  )
}
