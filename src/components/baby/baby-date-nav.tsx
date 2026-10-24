"use client"

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { daysBetweenYmd, isValidYmd, shiftYmd } from "@/lib/utils/date-jst"
import { openNativePickerOnTap } from "@/lib/utils/native-picker"

interface BabyDateNavProps {
  selectedDate: string
  /**
   * JST の今日（YYYY-MM-DD）。親（BabyDashboard）が時計から導いて渡す。ここで
   * 描画中に todayJstString() を引数なしで呼ぶと、React Compiler がマウント時の値で
   * 凍結し、日を跨いでも見出しが「今日」のまま・「次の日」も押せぬままになる。
   */
  today: string
  onDateChange: (date: string) => void
}

function formatDateLabel(ymd: string, today: string): string {
  const diff = daysBetweenYmd(today, ymd)
  if (diff === 0) return "今日"
  if (diff === -1) return "昨日"

  const [y, m, d] = ymd.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][dt.getUTCDay()]
  return `${m}/${d}（${weekday}）`
}

export function BabyDateNav({
  selectedDate,
  today,
  onDateChange,
}: BabyDateNavProps) {
  const isToday = selectedDate === today

  return (
    <div className="flex items-center justify-between">
      <h1 className="text-xl font-bold">{formatDateLabel(selectedDate, today)}</h1>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11"
          onClick={() => onDateChange(shiftYmd(selectedDate, -1))}
          aria-label="前の日"
        >
          <ChevronLeft size={18} />
        </Button>
        {/* 日付へ直接移動（機能 B）。ネイティブの日付ピッカーを 44px のアイコンに重ねる。
            未来は max で選べぬ（「次の日」が今日で止まるのと同じ契約）。キーボードでは
            input 自体にフォーカスが当たり、Enter / Space でピッカーが開く */}
        <label
          className="relative flex size-11 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 hover:bg-muted hover:text-foreground focus-within:ring-3 focus-within:ring-ring/50"
          title="日付を選んで移動"
        >
          <CalendarDays size={18} aria-hidden="true" />
          <input
            type="date"
            aria-label="日付を選んで移動"
            value={selectedDate}
            max={today}
            onClick={(event) => openNativePickerOnTap(event.currentTarget)}
            onChange={(event) => {
              const next = event.target.value
              // 空（クリア）・不正・未来は無視する（表示は選択日のまま）
              if (!isValidYmd(next) || next > today) return
              onDateChange(next)
            }}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
        </label>
        {!isToday && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDateChange(today)}
            className="text-xs"
          >
            今日
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-11"
          onClick={() => onDateChange(shiftYmd(selectedDate, 1))}
          disabled={isToday}
          aria-label="次の日"
        >
          <ChevronRight size={18} />
        </Button>
      </div>
    </div>
  )
}
