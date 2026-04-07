import { Skeleton } from "@/components/ui/skeleton"

const MEAL_TYPES = ["朝", "昼", "夕"]

export default function MealsLoading() {
  return (
    <div className="flex flex-col gap-3 px-4 pt-4">
      {/* 週ナビゲーションヘッダー スケルトン */}
      <div className="glass flex flex-col items-center gap-2 rounded-2xl px-4 py-3 shadow-lg shadow-black/[0.04]">
        <div className="flex w-full items-center justify-between">
          <Skeleton className="size-11 rounded-lg" />
          <Skeleton className="h-4 w-32 rounded-md" />
          <Skeleton className="size-11 rounded-lg" />
        </div>
      </div>

      {/* 曜日ごとのスケルトン (7日分) */}
      <div className="flex flex-col gap-2 pb-4">
        {Array.from({ length: 7 }, (_, dayIndex) => (
          <div
            key={dayIndex}
            className={`rounded-2xl p-3 ${
              dayIndex === 0
                ? "glass shadow-lg shadow-black/[0.04] ring-1 ring-primary/20"
                : "bg-muted/30"
            }`}
          >
            {/* 日付ヘッダー */}
            <div className="mb-2 flex items-center gap-2">
              <Skeleton className="h-4 w-20 rounded-md" />
              {dayIndex === 0 && (
                <Skeleton className="h-4 w-8 rounded-full" />
              )}
            </div>

            {/* 朝・昼・夕 のスロット */}
            <div className="flex gap-2">
              {MEAL_TYPES.map((type) => (
                <div key={type} className="flex min-w-0 flex-1 flex-col gap-1">
                  <Skeleton className="mx-auto h-3 w-5 rounded-md" />
                  <Skeleton className="h-16 w-full rounded-2xl" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
