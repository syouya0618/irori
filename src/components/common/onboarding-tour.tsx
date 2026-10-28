"use client"

import { useEffect, useState } from "react"
import {
  Baby,
  CalendarDays,
  Settings,
  Hand,
  Smartphone,
  UserPlus,
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

/**
 * 手順（2026-10-27 D）。設定がすべて済んでおらずとも記録は始められる、を最初に言い、
 * 最初の記録・家族の招待・ホーム画面からの開き方を順に案内する。説明の画面名は BottomNav の
 * 3 タブ（bottom-nav.tsx）と同じ言葉を使う。ホーム画面の手順は、いま開いておる形
 * （ホーム画面から / ブラウザから）で言い分ける。
 */
function buildSteps(standalone: boolean): TourStep[] {
  return [
    {
      icon: Hand,
      title: "irori へようこそ",
      body: "育児記録と予定を夫婦で共有するアプリです。設定がすべて済んでいなくても、すぐに記録を始められます。",
    },
    {
      icon: Baby,
      title: "最初の記録",
      body: "「育児」の「授乳」「おむつ」ボタンを押すと、その時刻で記録されます。記録はタイムラインに並び、あとから直せます。",
    },
    {
      icon: UserPlus,
      title: "家族を招待",
      body: "「設定」の「家族・世帯」から招待リンクを作れます。招待はあとからでも構いません。招待の前から記録できます。",
    },
    {
      icon: Smartphone,
      title: "ホーム画面から開く",
      body: standalone
        ? "いまはホーム画面から開いています。次からも irori のアイコンから開けます。"
        : "ブラウザの共有メニューから「ホーム画面に追加」すると、次からアイコンで開けます。追加しなくても、このままブラウザで使えます。",
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
}

/** ホーム画面（standalone）から開いておるか。判らぬ環境では false（ブラウザ向けの案内） */
function isStandaloneDisplay(): boolean {
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true
    return (navigator as Navigator & { standalone?: boolean }).standalone === true
  } catch {
    return false
  }
}

export function OnboardingTour() {
  const { open, dismiss } = useOnboardingTour()
  const [step, setStep] = useState(0)
  // 表示の形は描画の後にだけ読む（SSR と食い違わせぬ）
  const [standalone, setStandalone] = useState(false)
  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 表示の形（ブラウザの外部状態）は描画の後にだけ読む
    setStandalone(isStandaloneDisplay())
  }, [open])
  const STEPS = buildSteps(standalone)

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
