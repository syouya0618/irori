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
    start_url: "/meals",
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
