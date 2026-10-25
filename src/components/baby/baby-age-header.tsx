import Link from "next/link"
import { Baby, CalendarPlus } from "lucide-react"
import { getBabyAge } from "@/lib/domain/baby-log-aggregation"

interface BabyAgeHeaderProps {
  babyName: string | null
  /** "YYYY-MM-DD" or null */
  babyBirthDate: string | null
  /** 基準日 "YYYY-MM-DD"（JST の今日） */
  referenceDate: string
  /**
   * 日付見出しの下に添える 1 行の形（育児画面）。カード 1 枚ぶん（約 70px）の縦を
   * クイック記録へ譲り、最重要の操作を親指の届く高さへ上げる。中身（月齢・通算日数・
   * 未登録時の導線）は同じ。
   */
  compact?: boolean
}

/**
 * 赤ちゃんの月齢・日齢を常時表示するヘッダ。
 *
 * 暦上の月齢（生後1ヶ月27日）と通算日数（生後58日）を**同じ行に並べて**両方
 * 見せる。健診や予防接種の案内は「○ヶ月」で、育児書やアプリは「○日目」で書かれる
 * ことが多く、片方だけでは毎回換算が要るため。主役は月齢（primary 色・大きめ）、
 * 通算日数は添え物（muted・小さめ）にして情報量を増やしても密度を壊さない。
 * 1 ヶ月未満は月齢表記そのものが「生後○日」ゆえ、同じ数字を二度出さない。
 *
 * 生年月日が未設定・不正な場合は設定画面への登録導線を出す。
 */
export function BabyAgeHeader({
  babyName,
  babyBirthDate,
  referenceDate,
  compact = false,
}: BabyAgeHeaderProps) {
  const age = babyBirthDate ? getBabyAge(babyBirthDate, referenceDate) : null

  if (compact) {
    if (!age) {
      return (
        <Link
          href="/settings"
          className="flex min-h-11 items-center gap-1.5 self-start px-1 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
        >
          <CalendarPlus size={16} className="shrink-0 text-primary" aria-hidden="true" />
          <span>誕生日を登録すると月齢が表示されます</span>
        </Link>
      )
    }
    const showDays = age.years >= 1 || age.months >= 1
    return (
      <p className="flex flex-wrap items-baseline gap-x-2 px-1 text-sm text-muted-foreground">
        <Baby size={16} className="shrink-0 self-center text-primary" aria-hidden="true" />
        {babyName ? <span className="font-medium text-foreground">{babyName}</span> : null}
        <span className="font-semibold tabular-nums text-foreground">{age.label}</span>
        {showDays && <span className="tabular-nums">{age.totalDaysLabel}</span>}
      </p>
    )
  }

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

  // 1 ヶ月未満は label が既に「生後N日」ゆえ通算日数を重ねて出さない
  const showTotalDays = age.years >= 1 || age.months >= 1

  return (
    <div className="glass flex items-center gap-3 rounded-2xl px-4 py-3 shadow-lg shadow-black/[0.04]">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Baby size={18} className="text-primary" />
      </div>
      <div className="flex min-w-0 flex-col">
        {babyName ? (
          <span className="truncate text-sm font-semibold">{babyName}</span>
        ) : null}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-base font-semibold tabular-nums text-primary">
            {age.label}
          </span>
          {showTotalDays && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {age.totalDaysLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
