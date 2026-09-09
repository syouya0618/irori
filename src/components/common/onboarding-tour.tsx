"use client"

import { useState } from "react"
import {
  Baby,
  CalendarDays,
  Settings,
  Hand,
  type LucideIcon,
} from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { useOnboardingTour } from "@/lib/hooks/use-onboarding-tour"

export { reopenOnboardingTour } from "@/lib/hooks/use-onboarding-tour"

interface TourStep {
  icon: LucideIcon
  title: string
  body: string
}

// 説明対象は BottomNav の 3 タブと対応（bottom-nav.tsx）。
const STEPS: TourStep[] = [
  {
    icon: Hand,
    title: "irori へようこそ",
    body: "育児記録と予定を夫婦で共有するアプリです。片手でも、すき間時間でも使えます。",
  },
  {
    icon: Baby,
    title: "育児",
    body: "授乳・おむつをワンタップで記録します。夜間や抱っこ中でもすぐ残せます。",
  },
  {
    icon: CalendarDays,
    title: "予定",
    body: "健診や予防接種などの予定をふたりで共有します。Google カレンダーと連携すれば、ふだんの予定もここに並びます。",
  },
  {
    icon: Settings,
    title: "設定",
    body: "テーマや世帯の設定はこちら。この使い方ツアーはいつでも設定から見返せます。",
  },
]

export function OnboardingTour() {
  const { open, dismiss } = useOnboardingTour()
  const [step, setStep] = useState(0)

  // 閉じる時に step を先頭へ戻す。次に開いた時（初回・設定からの再表示とも）
  // 常に最初のステップから始まる。effect ではなくイベントでリセットする。
  const handleClose = () => {
    dismiss()
    setStep(0)
  }

  const current = STEPS[step]
  const isFirst = step === 0
  const isLast = step === STEPS.length - 1
  const Icon = current.icon

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // X・背景タップ・スワイプで閉じても既読にする（毎回出さない）
        if (!next) handleClose()
      }}
    >
      <SheetContent
        side="bottom"
        className="rounded-t-2xl safe-bottom"
        aria-label="使い方ツアー"
      >
        <SheetHeader className="items-center pb-2 text-center">
          <span className="mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Icon className="size-6 text-primary" aria-hidden="true" />
          </span>
          <SheetTitle>{current.title}</SheetTitle>
          <SheetDescription className="text-balance">
            {current.body}
          </SheetDescription>
        </SheetHeader>

        {/* ステップインジケータ */}
        <div
          className="flex items-center justify-center gap-1.5 py-2"
          aria-hidden="true"
        >
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={
                "h-1.5 rounded-full transition-colors duration-200 " +
                (i === step ? "w-4 bg-primary" : "w-1.5 bg-muted-foreground/30")
              }
            />
          ))}
        </div>

        <SheetFooter className="flex-row gap-3">
          {isFirst ? (
            <Button
              variant="ghost"
              onClick={handleClose}
              className="flex-1 cursor-pointer"
            >
              スキップ
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              className="flex-1 cursor-pointer"
            >
              戻る
            </Button>
          )}

          {isLast ? (
            <Button
              onClick={handleClose}
              className="flex-1 cursor-pointer"
            >
              はじめる
            </Button>
          ) : (
            <Button
              onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              className="flex-1 cursor-pointer"
            >
              次へ
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
