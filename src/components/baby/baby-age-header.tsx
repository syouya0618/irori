import Link from "next/link"
import { Baby, CalendarPlus } from "lucide-react"
import { getBabyAge } from "@/lib/domain/baby-log-aggregation"

interface BabyAgeHeaderProps {
  babyName: string | null
  /** "YYYY-MM-DD" or null */
  babyBirthDate: string | null
  /** 基準日 "YYYY-MM-DD"（JST の今日） */
  referenceDate: string
}

/**
 * 赤ちゃんの月齢・日齢を常時表示するヘッダ。
 * 生年月日が未設定・不正な場合は設定画面への登録導線を出す。
 */
export function BabyAgeHeader({
  babyName,
  babyBirthDate,
  referenceDate,
}: BabyAgeHeaderProps) {
  const age = babyBirthDate ? getBabyAge(babyBirthDate, referenceDate) : null

  if (!age) {
    return (
      <Link
        href="/settings"
        className="glass flex min-h-11 items-center gap-2 rounded-2xl px-4 py-2.5 text-sm text-muted-foreground shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:text-foreground"
      >
        <CalendarPlus size={16} className="shrink-0 text-primary" />
        <span>誕生日を登録すると月齢が表示されます</span>
      </Link>
    )
  }

  return (
    <div className="glass flex items-center gap-3 rounded-2xl px-4 py-3 shadow-lg shadow-black/[0.04]">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Baby size={18} className="text-primary" />
      </div>
      <div className="flex min-w-0 flex-col">
        {babyName ? (
          <span className="truncate text-sm font-semibold">{babyName}</span>
        ) : null}
        <span className="text-base font-semibold tabular-nums text-primary">
          {age.label}
        </span>
      </div>
    </div>
  )
}
