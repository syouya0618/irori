"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { UtensilsCrossed, ShoppingCart, Package, Settings } from "lucide-react"
import { cn } from "@/lib/utils"

const tabs = [
  { href: "/meals", label: "献立", icon: UtensilsCrossed },
  { href: "/shopping", label: "買い物", icon: ShoppingCart },
  { href: "/stock", label: "在庫", icon: Package },
  { href: "/settings", label: "設定", icon: Settings },
] as const

export function BottomNav() {
  const pathname = usePathname()

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 glass-nav safe-bottom"
      role="navigation"
      aria-label="メインナビゲーション"
    >
      <div className="mx-auto flex max-w-lg items-center justify-around">
        {tabs.map(({ href, label, icon: Icon }) => {
          const isActive =
            pathname === href || pathname.startsWith(`${href}/`)

          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex min-h-11 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 py-2 transition-colors duration-200",
                isActive
                  ? "text-primary font-semibold"
                  : "text-muted-foreground"
              )}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
              <span className="text-xs">{label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
