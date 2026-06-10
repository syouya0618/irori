import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactCompiler: true,
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
