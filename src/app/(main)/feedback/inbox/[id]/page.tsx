import Link from "next/link"
import { notFound } from "next/navigation"
import { ChevronLeft, TriangleAlert } from "lucide-react"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { isClientId } from "@/lib/utils/client-id"
import {
  formatFeedbackDateTime,
  isNonProductionDeploy,
  observedDeployFromEnv,
  parseFeedbackStatus,
  releaseOf,
  type FeedbackPushSummary,
} from "@/lib/domain/feedback"
import {
  FEEDBACK_DETAIL_COLUMNS,
  FEEDBACK_EVENT_COLUMNS,
  toTimelineEntries,
} from "@/lib/domain/feedback-view"
import { FeedbackStatusBadge } from "@/components/feedback/feedback-status-badge"
import { FeedbackTimeline } from "@/components/feedback/feedback-timeline"
import { FeedbackSeenMarker } from "@/components/feedback/feedback-seen-marker"
import { FeedbackOperatorPanel } from "@/components/feedback/feedback-operator-panel"

/**
 * 受信箱の詳細（運用者）。運用者への Push の着地先（`/feedback/inbox/<id>`）でもある。
 *
 * 知らせの状況は `get_feedback_push_summary` の**数だけ**を見る（端末の識別子は返らぬ）。
 * 読めなかった時は「積まれていない」と偽らず、読めなかったと書く。
 */
export default async function FeedbackInboxDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  if (!isClientId(id)) notFound()

  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId } = context

  const { data: operatorFlag, error: operatorError } = await supabase.rpc("is_app_operator")
  if (operatorError) {
    logSupabaseError("feedback-inbox", "is_app_operator lookup failed", operatorError, { userId })
    throw new Error("運用者の確認に失敗しました")
  }
  if (operatorFlag !== true) notFound()

  const [
    { data: item, error },
    { data: events, error: eventsError },
    { data: pushRows, error: pushError },
  ] = await Promise.all([
    supabase.from("feedback_items").select(FEEDBACK_DETAIL_COLUMNS).eq("id", id).maybeSingle(),
    supabase
      .from("feedback_events")
      .select(FEEDBACK_EVENT_COLUMNS)
      .eq("feedback_id", id)
      .order("created_at"),
    supabase.rpc("get_feedback_push_summary", { p_feedback_id: id }),
  ])

  if (error) {
    logSupabaseError("feedback-inbox", "feedback detail lookup failed", error, { userId, id })
    throw new Error("要望を取得できませんでした")
  }
  if (!item) notFound()
  if (eventsError) {
    logSupabaseError("feedback-inbox", "feedback events lookup failed", eventsError, { userId, id })
  }
  if (pushError) {
    logSupabaseError("feedback-inbox", "push summary lookup failed", pushError, { userId, id })
  }

  const status = parseFeedbackStatus(item.status)
  const release = releaseOf(item)
  const pushSummaries = pushError
    ? undefined
    : new Map<string, FeedbackPushSummary>(
        (pushRows ?? []).map((row) => [row.event_id, row]),
      )
  const timeline = toTimelineEntries(events ?? [], pushSummaries)

  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <FeedbackSeenMarker feedbackId={item.id} />
      <Link
        href="/feedback/inbox"
        className="touch-target -ml-2 inline-flex w-fit items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronLeft size={18} aria-hidden="true" />
        受信箱
      </Link>

      <article className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
        <div className="flex flex-wrap items-center gap-2">
          <FeedbackStatusBadge status={status} released={release !== null} />
          <span className="text-sm text-muted-foreground">
            {item.submitter_name} ・ {formatFeedbackDateTime(item.created_at) ?? "日時不明"} 受付
          </span>
        </div>
        <h1 className="text-lg font-bold break-words">{item.title}</h1>
        {item.body ? (
          <p className="text-base whitespace-pre-wrap break-words">{item.body}</p>
        ) : (
          <p className="text-sm text-muted-foreground">（詳しい内容はありません）</p>
        )}
      </article>

      <FeedbackOperatorPanel
        feedbackId={item.id}
        version={item.version}
        status={status}
        released={release !== null}
        runningDeploy={observedDeployFromEnv(process.env)}
        nonProductionDeploy={isNonProductionDeploy(process.env)}
      />

      <section aria-labelledby="inbox-history-heading" className="flex flex-col gap-3">
        <h2 id="inbox-history-heading" className="px-1 text-sm font-semibold text-muted-foreground">
          対応の履歴と知らせの状況
        </h2>
        {pushError && (
          <p role="alert" className="flex items-start gap-2 text-sm text-muted-foreground">
            <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-destructive" />
            知らせの配信状況を取得できませんでした（届いたかどうかは分かりません）
          </p>
        )}
        {eventsError ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-muted-foreground">
            <TriangleAlert size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-destructive" />
            履歴を取得できませんでした。少し待ってから開き直してください
          </p>
        ) : (
          <FeedbackTimeline entries={timeline} />
        )}
        <p className="px-1 text-sm text-muted-foreground">
          知らせは 5 分ごとの配信でまとめて送ります。「Push サービスが受理」は端末に表示されたことまでは
          意味しません。投稿者には、アプリの画面で必ず最新の状態が表示されます。
        </p>
      </section>
    </div>
  )
}
