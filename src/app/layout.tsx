import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Toaster } from "@/components/ui/sonner"
import { ServiceWorkerManager } from "@/components/common/service-worker-manager"
import { OfflineBanner } from "@/components/common/offline-banner"
import "./globals.css"
// 拡大まわりの守り（viewport の解除と対）。globals.css の @layer の外に置く必要があるため別ファイル
import "./touch-zoom.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "うちのログ",
  description: "夫婦の育児記録と予定をひとつに",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "うちログ",
  },
  formatDetection: {
    telephone: false,
  },
}

/**
 * ピンチ拡大は禁じない（WCAG 2.2 SC 1.4.4 / Apple HIG）。
 *
 * 以前は `maximumScale: 1, userScalable: false` で封じておった。目的は iPhone Safari が
 * 16px 未満の入力欄にフォーカスした時の勝手な拡大を避けることと、ダブルタップ拡大の
 * 誤爆を防ぐことじゃったが、代償として夜中に小さな数字を読めぬ人が拡大できなんだ
 * （Android は user-scalable=no を尊重する）。どちらの原因も `./touch-zoom.css` で消す:
 *   - `html { touch-action: manipulation }` がダブルタップ拡大を切る
 *   - `@media (pointer: coarse)` で入力欄の文字を 16px 以上にし、自動拡大の条件を消す
 * この解除と touch-zoom.css・zoom-policy-contract.test.ts は 1 つの関心事（1 commit）。
 * iOS 実機での確認は未実施ゆえ、問題が出たら一式で戻す。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ja" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Theme FOUC prevention - static inline script with no user input, XSS-safe */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches))document.documentElement.classList.add("dark")}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-dvh bg-background font-sans antialiased">
        {children}
        {/* 位置・退避量・テーマは ui/sonner.tsx が持つ（ナビの寸法と同じ変数を見る） */}
        <Toaster />
        <ServiceWorkerManager />
        <OfflineBanner />
      </body>
    </html>
  )
}
