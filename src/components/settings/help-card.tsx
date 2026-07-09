"use client"

import { HelpCircle } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { reopenOnboardingTour } from "@/lib/hooks/use-onboarding-tour"

/**
 * 使い方ツアーを再表示する設定カード。
 * OnboardingTour は (main)/layout にマウントされており、settings も同 layout 配下ゆえ
 * このボタンのイベントで同ページ上にツアーが開く。
 */
export function HelpCard() {
  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HelpCircle size={18} />
          使い方
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Button
          type="button"
          variant="outline"
          onClick={() => reopenOnboardingTour()}
          className="min-h-11 w-full cursor-pointer"
        >
          使い方ツアーをもう一度見る
        </Button>
      </CardContent>
    </Card>
  )
}
