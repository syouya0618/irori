"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { daysBetweenYmd, todayJstString, shiftYmd } from "@/lib/utils/date-jst"

interface BabyDateNavProps {
  selectedDate: string
  onDateChange: (date: string) => void
}

function formatDateLabel(ymd: string): string {
  const today = todayJstString()
  const diff = daysBetweenYmd(today, ymd)
  if (diff === 0) return "今日"
  if (diff === -1) return "昨日"

  const [y, m, d] = ymd.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][dt.getUTCDay()]
  return `${m}/${d}（${weekday}）`
}

export function BabyDateNav({ selectedDate, onDateChange }: BabyDateNavProps) {
  const today = todayJstString()
  const isToday = selectedDate === today

  return (
    <div className="flex items-center justify-between">
      <h1 className="text-xl font-bold">{formatDateLabel(selectedDate)}</h1>
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
