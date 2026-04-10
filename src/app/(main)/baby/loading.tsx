import { Skeleton } from "@/components/ui/skeleton"

export default function BabyLoading() {
  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-36">
      {/* Date nav */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-24" />
        <div className="flex gap-2">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="size-8 rounded-lg" />
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="glass flex flex-col items-center gap-2 rounded-2xl p-3 shadow-lg shadow-black/[0.04]"
          >
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <Skeleton
            key={i}
            className="h-14 rounded-2xl"
          />
        ))}
      </div>

      {/* Timeline */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="glass flex items-center gap-3 rounded-2xl p-3 shadow-lg shadow-black/[0.04]"
          >
            <Skeleton className="size-10 rounded-full" />
            <div className="flex flex-1 flex-col gap-1">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
    </div>
  )
}
