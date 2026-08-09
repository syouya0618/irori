import type { MetadataRoute } from "next"

/**
 * PWA マニフェスト設定
 *
 * NOTE: 本番環境では /icons/icon-192.png と /icons/icon-512.png を
 * 適切なPNGアセットに差し替えてください。
 * 現在は SVG アイコンをフォールバックとして使用しています。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "うちのログ",
    short_name: "うちログ",
    description: "夫婦の献立・買い物・暮らしをひとつに",
    /**
     * ホーム画面から起動したときに開く URL。
     *
     * ⚠️ **ここを具体的なページ（`/meals` 等）にしてはならぬ。** manifest は
     * 静的生成ゆえ利用者ごとに変えられず、直書きすると設定画面の
     * 「起動時のページ」（`profiles.default_page`）が**何を選んでも効かぬ**
     * ——「起動したら必ず献立が出る」という形で表面化する（実際に起きた）。
     *
     * `/`（`src/app/page.tsx`）は `default_page` を読んで `/${page}` へ
     * redirect する。起動をここへ通すことで、設定が初めて意味を持つ。
     *
     * 代償: `/` は毎回 redirect ゆえキャッシュしても意味を成さず、`sw.js` の
     * `classifyRequest` は `nav-passthrough`（キャッシュ禁止）に分類する。
     * よって**圏外で起動すると `/offline` が出る**（従来は献立のキャッシュが出た）。
     * 「設定が効かぬ」は機能の破損、「圏外起動が劣化する」は degradation ゆえ、
     * 前者を直す方を採った。
     */
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#f97316",
    icons: [
      {
        src: "/icons/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  }
}
