import { Skeleton } from "@/components/ui/skeleton"

export default function BabySearchLoading() {
  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-36">
      <div className="flex items-center gap-3">
        <Skeleton className="size-11 rounded-2xl" />
        <Skeleton className="h-6 w-28" />
      </div>
      {/* 条件フォーム */}
      <div className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
        <Skeleton className="h-11 w-full rounded-lg" />
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-11 rounded-lg" />
          <Skeleton className="h-11 rounded-lg" />
          <Skeleton className="h-11 rounded-lg" />
        </div>
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>
      {/* 結果 */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="glass flex items-center gap-3 rounded-2xl p-3 shadow-lg shadow-black/[0.04]"
          >
            <Skeleton className="h-3 w-12" />
            <div className="flex flex-1 flex-col gap-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
