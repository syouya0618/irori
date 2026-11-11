import { Skeleton } from "@/components/ui/skeleton"

/**
 * /chores/garbage の読み込み表示。外枠はページと同じクラス、中身は「戻る・見出し・収集日の行」の
 * 骨組み（育児や家事ハブの形を出さぬ）。
 */
export default function GarbageLoading() {
  return (
    <div
      role="status"
      aria-label="読み込み中"
      aria-busy="true"
      className="flex flex-col gap-6 px-4 pt-12 pb-8"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-11 w-16 rounded-lg" />
        <Skeleton className="h-7 w-16 rounded-md" />
        <Skeleton className="h-4 w-64 rounded-md" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24 rounded-md" />
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="glass flex items-start gap-3 rounded-2xl p-3 shadow-lg shadow-black/[0.04]"
          >
            <Skeleton className="size-9 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-5 w-24 rounded-md" />
              <Skeleton className="h-4 w-40 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
