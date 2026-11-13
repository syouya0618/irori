import ChoresLoading from "@/components/common/loading/chores-loading"

/**
 * /chores とその下位（自前の loading.tsx を持たぬ route）の読み込み表示。
 * 骨組みは (main) layout の `MainLoading` と同じ部品を使う（コールドロードと遷移で形を揃える）。
 */
export default function Loading() {
  return (
    <div role="status" aria-label="読み込み中" aria-busy="true">
      <ChoresLoading />
    </div>
  )
}
