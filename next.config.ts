import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental: {
    // Dynamic Route の Client Cache TTL（既定 0 秒 = 無効。experimental API、
    // node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/staleTimes.md）。
    // 10 秒は「配偶者の変更が最大 N 秒見えなくなる」という夫婦間トレードオフの
    // 値であり、AI が独断で決めてよい定数ではないため主に確認済み（変更禁止）。
    //
    // 効く範囲（staleTimes.md より）: <Link> 等の通常のクライアントサイド
    // 遷移で、直近 `dynamic` 秒以内に取得済みの RSC payload を再利用する。
    // 同 doc は「back/forward キャッシュの挙動は変えない」と明記しており、
    // 戻る/進むはこの設定と無関係（別経路）。
    //
    // 代償と、なぜ許容できるか:
    // - 自分の書き込みが即時反映されるのは、この設定とは別の既存経路による:
    //   meals/shopping/stock/baby/calendar の Server Action は revalidatePath
    //   を呼んでおり、公式 doc (revalidatePath.md) が
    //   「Server Functions: Updates the UI immediately (if viewing the
    //   affected path)」と明記している。settings は router.refresh() を使い、
    //   use-router.md が「refresh() clears the Client Cache for the current
    //   route」と明記している。いずれもこの staleTimes キャッシュを迂回する。
    // - 配偶者側の変更は最大 10 秒古い可能性があるが、既存の visibilitychange
    //   / focus 復帰時 refetch（use-visibility-refetch.ts）が可視化のたびに
    //   実データへ揃えるため、古さは短時間の一過性に留まる。
    // - `static`（既定 5 分）はここでは変更しない。
    staleTimes: {
      dynamic: 10,
    },
  },
  async headers() {
    return [
      {
        // Service Worker は常に最新を取得させる (Next.js PWA ガイド推奨)。
        // ブラウザ/中間キャッシュに古い sw.js が残ると更新が永久に届かなくなる。
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
    ]
  },
}

export default nextConfig
