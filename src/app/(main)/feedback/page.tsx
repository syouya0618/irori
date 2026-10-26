import Link from "next/link"
import { ChevronLeft, ChevronRight, Inbox, MessageSquareText } from "lucide-react"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { countUnreadInbox } from "@/lib/supabase/feedback-badges"
import {
  FEEDBACK_LIST_COLUMNS,
  toSubmitterListItem,
  type FeedbackListItem,
} from "@/lib/domain/feedback-view"
import { FeedbackForm } from "@/components/feedback/feedback-form"
import { FeedbackList } from "@/components/feedback/feedback-list"
import { FeedbackRefreshOnVisible } from "@/components/feedback/feedback-refresh-on-visible"

/** 一覧に出す件数の上限（家族の要望ゆえ十分。超えたら古いものから見えなくなる）。 */
const LIST_LIMIT = 100

function FeedbackSection({
  id,
  title,
  description,
  items,
}: {
  id: string
  title: string
  description: string
  items: FeedbackListItem[]
}) {
  if (items.length === 0) return null
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5 px-1">
        <h2 id={`${id}-heading`} className="text-sm font-semibold text-muted-foreground">
          {title}（{items.length}）
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <FeedbackList items={items} label={title} />
    </section>
  )
}

/**
 * 要望・改善提案（利用者）。送るフォームと、**自分が送った要望**の一覧。
 *
 * ⚠️ `.eq("submitter_id", userId)` を外すな。運用者には RLS が全件を見せるゆえ、外すと
 * 運用者の「自分の要望」一覧に他人の要望が混ざる（運用者の受信箱は /feedback/inbox）。
 */
export default async function FeedbackPage() {
  const { context } = await getAuthContext()
  // 未認証・未承認・世帯なしは (main)/layout が遷移させる。
  if (!context) return null
  const { supabase, userId } = context

  const [{ data, error }, { data: operatorFlag, error: operatorError }] = await Promise.all([
    supabase
      .from("feedback_items")
      .select(FEEDBACK_LIST_COLUMNS)
      .eq("submitter_id", userId)
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT),
    supabase.rpc("is_app_operator"),
  ])

  if (error) {
    logSupabaseError("feedback", "feedback list lookup failed", error, { userId })
    // 「まだ送っておらぬ」と偽らず error boundary へ（再試行できる）。
    throw new Error("要望の一覧を取得できませんでした")
  }
  if (operatorError) {
    // 判定に失敗したら閉じる（受信箱への導線を出さぬ）。ログには残す。
    logSupabaseError("feedback", "is_app_operator lookup failed", operatorError, { userId })
  }
  const isOperator = operatorFlag === true
  const inboxUnread = isOperator ? await countUnreadInbox(supabase) : null

  const items = (data ?? []).map(toSubmitterListItem)
  const released = items.filter((item) => item.released)
  const declined = items.filter((item) => !item.released && item.status === "declined")
  const open = items.filter((item) => !item.released && item.status !== "declined")

  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <FeedbackRefreshOnVisible />
      <div className="flex flex-col gap-2">
        <Link
          href="/settings"
          className="touch-target -ml-2 inline-flex w-fit items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronLeft size={18} aria-hidden="true" />
          設定
        </Link>
        <h1 className="text-xl font-bold">要望・改善提案</h1>
        <p className="text-sm text-muted-foreground">
          使っていて困ったこと、こうしてほしいことを送ってください。運用者が確認し、
          対応の状況をこの画面でお知らせします。
        </p>
      </div>

      {isOperator && (
        <Link
          href="/feedback/inbox"
          className="glass flex min-h-11 items-center gap-3 rounded-2xl px-4 py-3 shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Inbox size={20} aria-hidden="true" className="shrink-0" />
          <span className="flex-1 text-base font-medium">運用者の受信箱</span>
          {inboxUnread !== null && inboxUnread > 0 && (
            <span className="rounded-full bg-primary px-2.5 py-0.5 text-sm font-semibold text-primary-foreground">
              未読 {inboxUnread}
            </span>
          )}
          <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        </Link>
      )}

      <FeedbackForm userId={userId} />

      {items.length === 0 ? (
        <div className="glass flex flex-col items-center gap-2 rounded-2xl px-4 py-8 text-center shadow-lg shadow-black/[0.04]">
          <MessageSquareText size={28} aria-hidden="true" className="text-muted-foreground" />
          <p className="text-base font-medium">まだ要望は送られていません</p>
          <p className="text-sm text-muted-foreground">
            送った要望と、その対応状況がここに並びます。
          </p>
        </div>
      ) : (
        <>
          <FeedbackSection
            id="feedback-open"
            title="対応待ち・対応中"
            description="運用者が確認・対応している要望です"
            items={open}
          />
          <FeedbackSection
            id="feedback-released"
            title="反映済み"
            description="本番の irori に反映されたことを運用者が確かめた要望です"
            items={released}
          />
          <FeedbackSection
            id="feedback-declined"
            title="見送り"
            description="今回は対応を見送った要望です"
            items={declined}
          />
        </>
      )}
    </div>
  )
}
