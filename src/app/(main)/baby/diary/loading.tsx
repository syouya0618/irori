import { Skeleton } from "@/components/ui/skeleton"

export default function BabyDiaryLoading() {
  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-8">
      {/* Header (back + title) */}
      <div className="flex items-center gap-3">
        <Skeleton className="size-11 rounded-2xl" />
        <Skeleton className="h-6 w-16" />
      </div>

      {/* Date groups */}
      {[1, 2].map((g) => (
        <div key={g} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-32" />
          <div className="glass flex flex-col gap-3 rounded-2xl p-3 shadow-lg shadow-black/[0.04]">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-4 w-10 shrink-0" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
