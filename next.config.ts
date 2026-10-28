import type { NextConfig } from "next"

/**
 * 端末が読んでおる build の識別子（2026-10-27 大型更新 E1）。Vercel の system env
 * `VERCEL_GIT_COMMIT_SHA` の先頭 7 桁。未設定・空（e2e-env.sh は空文字を置く）・16 進でない値は "dev"。
 * 規則は src/lib/release/build-info.ts の shortBuildId と同じ（build-info.test.ts が一致を確かめる）。
 * branch 名（VERCEL_GIT_COMMIT_REF）や環境名は埋め込まぬ。
 *
 * `deploymentId` は設定せぬ: 版の食い違いを検知すると Next が**自動で全画面再読込**する
 * （deploymentId.md「it triggers a hard navigation」）。書きかけ・計測・結果不明の保存がある間に
 * 勝手に読み直さぬ方針（設定画面の更新案内で利用者に選ばせる）と衝突する。
 * `experimental.useOffline` も入れぬ: 復帰時に Server Action を無人で再送する（outbox 相当）。
 */
const rawCommitSha = (process.env.VERCEL_GIT_COMMIT_SHA || "").trim().toLowerCase()
const IRORI_BUILD_SHA = /^[0-9a-f]{7,40}$/.test(rawCommitSha) ? rawCommitSha.slice(0, 7) : "dev"

const nextConfig: NextConfig = {
  reactCompiler: true,
  env: {
    IRORI_BUILD_SHA,
  },
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
    //   baby/calendar の Server Action は revalidatePath
    //   を呼んでおり、公式 doc (revalidatePath.md) が
    //   「Server Functions: Updates the UI immediately (if viewing the
    //   affected path)」と明記している。settings は router.refresh() を使い、
    //   use-router.md が「refresh() clears the Client Cache for the current
    //   route」と明記している。いずれもこの staleTimes キャッシュを迂回する。
    // - 配偶者側の変更は最大 10 秒古い payload で描かれうる。戻る/進むはさらに
    //   古さを問わず payload を再利用する（router の bfcache）。いずれも
    //   baby_logs は baby-dashboard.tsx の resyncLogs が**マウント時**と
    //   visible / focus、channel の SUBSCRIBED（初回と再接続）で取り直すため、
    //   取り直しに成功する限り、古いのは再マウント直後の 1 往復の間だけに留まる
    //   （圏外・session 失効中は反映を見送り、次の契機まで古い表示が残る）。
    //   back/forward の再利用は staleTimes.md「This doesn't change back/forward
    //   caching behavior」と 04-glossary.md の Client Cache の項を参照。その他（日記・予定等）は
    //   visibilitychange / focus 復帰時 refetch（use-visibility-refetch.ts）が
    //   可視化のたびに揃える — 遷移で戻っただけでは発火しないため、次の可視化
    //   までは古い表示が残りうる（日記の上書きはサーバの版ガードが防ぐ）。
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
