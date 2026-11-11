import { Skeleton } from "@/components/ui/skeleton"

/**
 * 家事（/chores とその下位）の汎用の骨組み。見出し + 行カード 3 枚。
 *
 * 下位ページ（ごみ・掃除・ごはん）は中身が違うゆえ、特定の画面の形を真似ぬ。育児の骨組み
 * （日付ナビ・クイック記録）を家事の画面で出さぬことが目的じゃ。外枠はページと同じクラスにする。
 */
export default function ChoresLoading() {
  return (
    <div data-skeleton="chores" className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-20 rounded-md" />
        <Skeleton className="h-4 w-56 rounded-md" />
      </div>
      <div className="flex flex-col gap-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="glass flex items-center gap-3 rounded-2xl px-4 py-4 shadow-lg shadow-black/[0.04]"
          >
            <Skeleton className="size-11 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-5 w-20 rounded-md" />
              <Skeleton className="h-4 w-40 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
