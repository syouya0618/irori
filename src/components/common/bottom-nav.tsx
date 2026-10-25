"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Baby, CalendarDays, Settings } from "lucide-react"
import { cn } from "@/lib/utils"

const tabs = [
  { href: "/baby", label: "育児", icon: Baby },
  { href: "/calendar", label: "予定", icon: CalendarDays },
  { href: "/settings", label: "設定", icon: Settings },
] as const

/**
 * ボトムナビ（3 タブ）。
 *
 * - 高さは `--bottom-nav-h`（globals.css）に固定し、(main) layout の `pb-nav` と同じ値を見る。
 *   以前は中身の高さ任せ（約 55px）で、layout 側の `pb-20` と独立に決まっておった
 * - 現在地は色（primary）・線と文字の太さ・アイコン裏の帯の 3 つで示す。帯は薄い塗り
 *   （輝度差は小さい）ゆえ、色を抜いた時に残る手掛かりは太さの差じゃ
 * - アイコンは DESIGN_SYSTEM.md「Lucide アイコン（24px）」に合わせる（以前は 20px）
 * - タブ全体が押下領域（高さ 64px・幅は 1/3）。44px 契約は余裕で満たす
 * - キーボードの輪郭: `outline-none` を**付けぬ**こと。Tailwind v4 の outline-none は
 *   `--tw-outline-style: none` を立て、`focus-visible:outline-2` はその変数を読むゆえ、
 *   同居させると focus 中も輪郭が none に解決する（独立レビューで見つかった退行）
 */
export function BottomNav() {
  const pathname = usePathname()

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 glass-nav safe-bottom"
      aria-label="メインナビゲーション"
    >
      <div className="mx-auto flex h-(--bottom-nav-h) max-w-lg items-stretch justify-around">
        {tabs.map(({ href, label, icon: Icon }) => {
          const isActive =
            pathname === href || pathname.startsWith(`${href}/`)

          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg transition-colors duration-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-current={isActive ? "page" : undefined}
            >
              <span
                className={cn(
                  "flex h-8 w-16 items-center justify-center rounded-full transition-colors duration-200",
                  isActive && "bg-primary/15"
                )}
              >
                <Icon
                  size={24}
                  strokeWidth={isActive ? 2.5 : 2}
                  aria-hidden="true"
                />
              </span>
              <span
                className={cn(
                  "text-xs leading-4",
                  isActive ? "font-semibold" : "font-medium"
                )}
              >
                {label}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
