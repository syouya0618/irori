import Link from "next/link"
import { notFound } from "next/navigation"
import { ChevronLeft, CircleCheck, Eye, TriangleAlert } from "lucide-react"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { isClientId } from "@/lib/utils/client-id"
import {
  FEEDBACK_STATUS_DESCRIPTIONS,
  formatFeedbackDateTime,
  parseFeedbackStatus,
  releaseOf,
} from "@/lib/domain/feedback"
import {
  FEEDBACK_DETAIL_COLUMNS,
  FEEDBACK_EVENT_COLUMNS,
  toTimelineEntries,
} from "@/lib/domain/feedback-view"
import { FeedbackStatusBadge } from "@/components/feedback/feedback-status-badge"
import { FeedbackTimeline } from "@/components/feedback/feedback-timeline"
import { FeedbackSeenMarker } from "@/components/feedback/feedback-seen-marker"

/**
 * 自分の要望の詳細（投稿者）。Push の着地先（`/feedback/<id>`）でもある。
 *
 * - 見えるのは**自分の要望だけ**（`.eq("submitter_id", userId)`）。他人の id・存在せぬ id は
 *   同じ 404 にする（有無を漏らさぬ）。運用者は受信箱の詳細（/feedback/inbox/<id>）を使う
 * - 「反映済み」は証拠付きの released の時だけ描く（`releaseOf`）
 * - Next.js 16 の `params` は Promise（await 必須。同梱 docs の page.md）
 */
export default async function FeedbackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!isClientId(id)) notFound()

  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId } = context

  const [{ data: item, error }, { data: events, error: eventsError }] = await Promise.all([
    supabase
      .from("feedback_items")
      .select(FEEDBACK_DETAIL_COLUMNS)
      .eq("id", id)
      .eq("submitter_id", userId)
      .maybeSingle(),
    supabase
      .from("feedback_events")
      .select(FEEDBACK_EVENT_COLUMNS)
      .eq("feedback_id", id)
      .order("created_at"),
  ])

  if (error) {
    logSupabaseError("feedback", "feedback detail lookup failed", error, { userId, id })
    throw new Error("要望を取得できませんでした")
  }
  if (!item) notFound()
  if (eventsError) {
    logSupabaseError("feedback", "feedback events lookup failed", eventsError, { userId, id })
  }

  const status = parseFeedbackStatus(item.status)
  const release = releaseOf(item)
  // 証拠の欠けた released は「反映済み」の説明を出さぬ（中立に倒す）。
  const description =
    status && (status !== "released" || release) ? FEEDBACK_STATUS_DESCRIPTIONS[status] : null
  const operatorSeenLabel = formatFeedbackDateTime(item.operator_seen_at)
  const timeline = toTimelineEntries(events ?? [])

  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <FeedbackSeenMarker feedbackId={item.id} />
      <Link
        href="/feedback"
        className="touch-target -ml-2 inline-flex w-fit items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronLeft size={18} aria-hidden="true" />
        要望の一覧
      </Link>

      <article className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
        <div className="flex flex-wrap items-center gap-2">
          <FeedbackStatusBadge status={status} released={release !== null} />
          <span className="text-sm text-muted-foreground">
            {formatFeedbackDateTime(item.created_at) ?? "日時不明"} に送信
          </span>
        </div>
        <h1 className="text-lg font-bold break-words">{item.title}</h1>
        {item.body && (
          <p className="text-base whitespace-pre-wrap break-words">{item.body}</p>
        )}
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        {release && (
          <p className="flex items-start gap-2 rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground">
            <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>
              {formatFeedbackDateTime(release.verifiedAt) ?? "日時不明"} に本番での反映を確かめました
              {release.note ? `（${release.note}）` : ""}
            </span>
          </p>
        )}
        {operatorSeenLabel && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Eye size={16} aria-hidden="true" />
            運用者が内容を確認しました（{operatorSeenLabel}）
          </p>
        )}
      </article>

      <section aria-labelledby="feedback-history-heading" className="flex flex-col gap-3">
        <h2 id="feedback-history-heading" className="px-1 text-sm font-semibold text-muted-foreground">
          対応の履歴
        </h2>
        {eventsError ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-muted-foreground">
            <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-destructive" />
            履歴を取得できませんでした。少し待ってから開き直してください
          </p>
        ) : (
          <FeedbackTimeline entries={timeline} />
        )}
        <p className="px-1 text-sm text-muted-foreground">
          状態が変わると、通知を許可した端末にもお知らせします。通知は届かないことがあるため、
          最新の状態はこの画面でご確認ください。
        </p>
      </section>
    </div>
  )
}
