import { Skeleton } from "@/components/ui/skeleton"

export default function CalendarLoading() {
  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-8">
      {/* 月ナビ */}
      <Skeleton className="h-12 w-full rounded-2xl" />

      {/* 月グリッド(6週 × 7日) */}
      <div className="glass rounded-2xl p-2">
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={`h${i}`} className="mx-auto h-3 w-4 rounded" />
          ))}
          {Array.from({ length: 42 }, (_, i) => (
            <Skeleton key={i} className="h-11 rounded-lg" />
          ))}
        </div>
      </div>

      {/* アジェンダ */}
      <Skeleton className="h-4 w-28 rounded" />
      <Skeleton className="h-11 w-full rounded-xl" />
      <Skeleton className="h-11 w-full rounded-xl" />
    </div>
  )
}
