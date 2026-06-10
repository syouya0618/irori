"use client"

import { Sun, Moon, Monitor } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useTheme } from "@/lib/hooks/use-theme"
import { segmentCn } from "@/lib/utils/segment-cn"

const THEME_OPTIONS = [
  { value: "light" as const, label: "ライト", icon: Sun },
  { value: "dark" as const, label: "ダーク", icon: Moon },
  { value: "system" as const, label: "システム", icon: Monitor },
]

export function ThemeCard() {
  const { theme, setTheme } = useTheme()

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sun size={18} />
          テーマ
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-1 rounded-xl bg-muted/50 p-1">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setTheme(opt.value)}
              className={segmentCn(theme === opt.value)}
            >
              <opt.icon size={14} className="mr-1 inline-block" />
              {opt.label}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
