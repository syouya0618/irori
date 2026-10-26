import { Skeleton } from "@/components/ui/skeleton"

export default function FeedbackLoading() {
  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-16 rounded" />
        <Skeleton className="h-7 w-40 rounded" />
        <Skeleton className="h-4 w-full rounded" />
      </div>
      {/* 送るフォーム */}
      <div className="glass flex flex-col gap-3 rounded-2xl p-4">
        <Skeleton className="h-5 w-24 rounded" />
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>
      {/* 一覧 */}
      <Skeleton className="h-4 w-28 rounded" />
      <Skeleton className="h-16 w-full rounded-2xl" />
      <Skeleton className="h-16 w-full rounded-2xl" />
    </div>
  )
}
