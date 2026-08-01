import { Skeleton } from "@/components/ui/skeleton"

export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <Skeleton className="h-7 w-16 rounded-md" />

      {/* 設定カード群（プロフィール・世帯・デフォルトページ・在庫自動追加・レシート方式・
          赤ちゃん情報・エクスポート・テーマ・使い方・招待 等） */}
      {Array.from({ length: 8 }, (_, i) => (
        <div
          key={i}
          className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
        >
          <div className="flex items-center gap-2">
            <Skeleton className="size-[18px] rounded-sm" />
            <Skeleton className="h-4 w-24 rounded-md" />
          </div>
          <Skeleton className="h-4 w-full rounded-md" />
          <Skeleton className="h-4 w-2/3 rounded-md" />
        </div>
      ))}

      {/* ログアウト */}
      <Skeleton className="h-px w-full" />
      <Skeleton className="h-11 w-full rounded-lg" />
    </div>
  )
}
