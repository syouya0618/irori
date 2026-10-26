import Link from "next/link"
import { notFound } from "next/navigation"
import { ChevronLeft, Inbox } from "lucide-react"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { segmentCn } from "@/lib/utils/segment-cn"
import {
  FEEDBACK_LIST_COLUMNS,
  INBOX_VIEWS,
  INBOX_VIEW_LABELS,
  applyInboxView,
  parseInboxView,
  toInboxListItem,
  type InboxView,
} from "@/lib/domain/feedback-view"
import { FeedbackList } from "@/components/feedback/feedback-list"
import { FeedbackRefreshOnVisible } from "@/components/feedback/feedback-refresh-on-visible"

const INBOX_LIMIT = 200

/**
 * 運用者の受信箱。**インスタンス運用者（app_operators）だけ**が開ける。
 *
 * - 判定は `is_app_operator()`。世帯 owner であることは根拠にせぬ（20261002100002）
 * - 運用者でなければ 404（受信箱の存在も見せぬ）。真の門は RLS で、ここは画面の作法じゃ
 *   —— 運用者でない者がここを素通りしても、RLS が自分の要望しか見せぬ
 * - 判定そのものに失敗したら error boundary へ（「運用者でない」と断定せぬ）
 */
export default async function FeedbackInboxPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId } = context

  const { data: operatorFlag, error: operatorError } = await supabase.rpc("is_app_operator")
  if (operatorError) {
    logSupabaseError("feedback-inbox", "is_app_operator lookup failed", operatorError, { userId })
    throw new Error("運用者の確認に失敗しました")
  }
  if (operatorFlag !== true) notFound()

  const view = parseInboxView((await searchParams).view)

  // 絞り込みと件数は **DB で**数える（`applyInboxView`）。読み込んだ新しい順 200 件の上で
  // 数えると、古い未対応・未読が件数からも一覧からも落ち、設定画面の未読の件数と食い違う。
  const countOf = async (v: InboxView): Promise<number | null> => {
    const { count, error: countError } = await applyInboxView(
      supabase.from("feedback_items").select("id", { count: "exact", head: true }),
      v,
    )
    if (countError) {
      logSupabaseError("feedback-inbox", "inbox count failed", countError, { userId, view: v })
      return null
    }
    return typeof count === "number" ? count : null
  }

  const [{ data, error }, ...countList] = await Promise.all([
    applyInboxView(
      supabase
        .from("feedback_items")
        .select(FEEDBACK_LIST_COLUMNS)
        .order("updated_at", { ascending: false })
        .limit(INBOX_LIMIT),
      view,
    ),
    ...INBOX_VIEWS.map((v) => countOf(v)),
  ])
  if (error) {
    logSupabaseError("feedback-inbox", "inbox lookup failed", error, { userId })
    throw new Error("受信箱を取得できませんでした")
  }

  const rows = data ?? []
  const counts = Object.fromEntries(
    INBOX_VIEWS.map((v, index) => [v, countList[index]]),
  ) as Record<InboxView, number | null>
  const visible = rows.map((row) => toInboxListItem(row))

  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <FeedbackRefreshOnVisible />
      <div className="flex flex-col gap-2">
        <Link
          href="/feedback"
          className="touch-target -ml-2 inline-flex w-fit items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronLeft size={18} aria-hidden="true" />
          要望・改善提案
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-bold">
          <Inbox size={22} aria-hidden="true" />
          運用者の受信箱
        </h1>
        <p className="text-sm text-muted-foreground">
          全世帯から届いた要望です。投稿者には、ここで変えた状態と返信がアプリ内で表示されます。
        </p>
      </div>

      <nav aria-label="受信箱の絞り込み" className="grid grid-cols-4 gap-2">
        {INBOX_VIEWS.map((v) => (
          <Link
            key={v}
            href={v === "open" ? "/feedback/inbox" : `/feedback/inbox?view=${v}`}
            aria-current={v === view ? "page" : undefined}
            className={`${segmentCn(v === view)} flex flex-col items-center justify-center focus-visible:outline-2 focus-visible:outline-ring`}
          >
            <span>{INBOX_VIEW_LABELS[v]}</span>
            {/* 数えられなかった件数は「0」と偽らず「—」 */}
            <span className="text-sm tabular-nums">{counts[v] ?? "—"}</span>
          </Link>
        ))}
      </nav>

      {visible.length === 0 ? (
        <div className="glass flex flex-col items-center gap-2 rounded-2xl px-4 py-8 text-center shadow-lg shadow-black/[0.04]">
          <Inbox size={28} aria-hidden="true" className="text-muted-foreground" />
          <p className="text-base font-medium">
            {INBOX_VIEW_LABELS[view]}の要望はありません
          </p>
        </div>
      ) : (
        <FeedbackList items={visible} label={`${INBOX_VIEW_LABELS[view]}の要望`} />
      )}
      {rows.length >= INBOX_LIMIT && (
        <p className="px-1 text-sm text-muted-foreground">
          新しい順に {INBOX_LIMIT} 件まで表示しています
        </p>
      )}
    </div>
  )
}
