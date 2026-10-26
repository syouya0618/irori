"use client"

import Link from "next/link"
import { ChevronRight, HelpCircle, Inbox, MessageSquarePlus } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { reopenOnboardingTour } from "@/lib/hooks/use-onboarding-tour"

/** 要望・改善提案への導線に添える件数（読めなかった時は null ＝ 件数を出さぬ）。 */
export interface HelpCardFeedback {
  /** 自分の要望のうち、運用者の更新をまだ見ておらぬ件数 */
  unseenUpdates: number | null
  /** 運用者だけ: 受信箱の未読。運用者でなければ導線ごと出さぬ */
  isAppOperator: boolean
  inboxUnread: number | null
}

const LINK_CLASS =
  "flex min-h-11 w-full items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring dark:border-input dark:bg-input/30 dark:hover:bg-input/50"

/** 件数の帯。色だけに頼らず文字（「更新 N」「未読 N」）で示す。 */
function CountPill({ label, count }: { label: string; count: number | null }) {
  if (count === null || count <= 0) return null
  return (
    <span className="rounded-full bg-primary px-2.5 py-0.5 text-sm font-semibold text-primary-foreground">
      {label} {count}
    </span>
  )
}

/**
 * 使い方ツアーの再表示と、要望・改善提案への導線。
 * OnboardingTour は (main)/layout にマウントされており、settings も同 layout 配下ゆえ
 * このボタンのイベントで同ページ上にツアーが開く。
 *
 * 受信箱の導線は**インスタンス運用者だけ**に出す（`is_app_operator()`。世帯 owner は根拠にせぬ）。
 * 出さぬのは画面の作法で、真の門は RLS と受信箱ページの 404 じゃ。
 */
export function HelpCard({ feedback }: { feedback?: HelpCardFeedback }) {
  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HelpCircle size={18} />
          使い方と要望
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => reopenOnboardingTour()}
          className="min-h-11 w-full cursor-pointer"
        >
          使い方ツアーをもう一度見る
        </Button>
        <Link href="/feedback" className={LINK_CLASS}>
          <MessageSquarePlus size={16} aria-hidden="true" className="shrink-0" />
          <span className="flex-1">要望・改善提案を送る</span>
          <CountPill label="更新" count={feedback?.unseenUpdates ?? null} />
          <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        </Link>
        {feedback?.isAppOperator && (
          <Link href="/feedback/inbox" className={LINK_CLASS}>
            <Inbox size={16} aria-hidden="true" className="shrink-0" />
            <span className="flex-1">要望の受信箱（運用者）</span>
            <CountPill label="未読" count={feedback.inboxUnread} />
            <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted-foreground" />
          </Link>
        )}
      </CardContent>
    </Card>
  )
}
