import { Skeleton } from "@/components/ui/skeleton"

/**
 * ごはんの下位 page の読み込み表示。見出しと切替は layout が出し続けるので、ここは本文の骨組みだけ。
 * 特定の画面の形（献立の 7 日・買い物の売場）を真似ない（下位 5 画面で共用する）。
 */
export default function MealsLoading() {
  return (
    <div
      role="status"
      aria-label="ごはんを読み込み中"
      aria-busy="true"
      data-skeleton="meals"
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-5 w-32 rounded-md" />
      {[1, 2, 3].map((i) => (
        <div key={i} className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
          <Skeleton className="h-4 w-24 rounded-md" />
          <Skeleton className="h-6 w-48 rounded-md" />
          <Skeleton className="h-6 w-28 rounded-full" />
        </div>
      ))}
    </div>
  )
}
