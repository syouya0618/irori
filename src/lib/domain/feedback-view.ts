/**
 * 要望の DB 行 → 画面の形。**中立モジュール**（Server Component が値で import する）。
 *
 * 日時の整形はここ（= サーバ）で確定させて文字列で渡す。クライアントのレンダー中に
 * 整形すると SSR とハイドレーションで食い違いうる。
 */

import type { Database } from "@/lib/types/database"
import {
  describeFeedbackPush,
  formatFeedbackDateTime,
  parseFeedbackEventKind,
  parseFeedbackStatus,
  releaseOf,
  type FeedbackEventKind,
  type FeedbackPushSummary,
  type FeedbackStatus,
} from "./feedback"

type ItemRow = Database["public"]["Tables"]["feedback_items"]["Row"]
type EventRow = Database["public"]["Tables"]["feedback_events"]["Row"]

/** 一覧に要る列（`select` に渡す。`select("*")` は使わぬ）。 */
export const FEEDBACK_LIST_COLUMNS =
  "id, title, status, created_at, updated_at, submitter_name, submitter_has_unseen, operator_seen_at, released_commit_sha, released_note, released_observed_deploy, released_verified_at"

/** 詳細に要る列。 */
export const FEEDBACK_DETAIL_COLUMNS =
  "id, submitter_id, submitter_name, title, body, status, version, created_at, updated_at, operator_seen_at, released_commit_sha, released_note, released_observed_deploy, released_verified_at"

/**
 * 履歴の列。⚠️ `actor_id` / `client_request_id` は authenticated の列 GRANT の外ゆえ
 * **書き足すな**（42501 で画面ごと落ちる）。
 */
export const FEEDBACK_EVENT_COLUMNS =
  "id, feedback_id, kind, actor_role, from_status, to_status, comment, merge_ref, release_commit_sha, release_note, release_observed_deploy, release_verified_at, created_at"

export type FeedbackListRow = Pick<
  ItemRow,
  | "id"
  | "title"
  | "status"
  | "created_at"
  | "updated_at"
  | "submitter_name"
  | "submitter_has_unseen"
  | "operator_seen_at"
  | "released_commit_sha"
  | "released_note"
  | "released_observed_deploy"
  | "released_verified_at"
>

export type FeedbackDetailRow = Pick<
  ItemRow,
  | "id"
  | "submitter_id"
  | "submitter_name"
  | "title"
  | "body"
  | "status"
  | "version"
  | "created_at"
  | "updated_at"
  | "operator_seen_at"
  | "released_commit_sha"
  | "released_note"
  | "released_observed_deploy"
  | "released_verified_at"
>

export type FeedbackEventRow = Pick<
  EventRow,
  | "id"
  | "feedback_id"
  | "kind"
  | "actor_role"
  | "from_status"
  | "to_status"
  | "comment"
  | "merge_ref"
  | "release_commit_sha"
  | "release_note"
  | "release_observed_deploy"
  | "release_verified_at"
  | "created_at"
>

export interface FeedbackListItem {
  id: string
  href: string
  title: string
  status: FeedbackStatus | null
  released: boolean
  metaLabel: string
  marker: string | null
  submitterName?: string
}

export interface FeedbackTimelineEntry {
  id: string
  kind: FeedbackEventKind
  toStatus: FeedbackStatus | null
  comment: string | null
  mergeRef: string | null
  release: { commitSha: string; note: string | null; verifiedLabel: string | null } | null
  atLabel: string | null
  pushLabel?: string
}

/** 受信箱の絞り込み。`?view=` の値。 */
export const INBOX_VIEWS = ["open", "unread", "done", "all"] as const
export type InboxView = (typeof INBOX_VIEWS)[number]

export const INBOX_VIEW_LABELS: Record<InboxView, string> = {
  open: "未対応",
  unread: "未読",
  done: "完了",
  all: "すべて",
}

/** 未知・配列・欠落は既定（未対応）へ退化させる。 */
export function parseInboxView(value: unknown): InboxView {
  return typeof value === "string" && (INBOX_VIEWS as readonly string[]).includes(value)
    ? (value as InboxView)
    : "open"
}

/** 受信箱の「完了」に当たる状態。それ以外（未知の状態を含む）は全て「未対応」。 */
export const INBOX_DONE_STATUSES = ["released", "declined"] as const

/** PostgREST の絞り込みのうち、受信箱が使う 3 つだけ（テストで差し替えられる形）。 */
export interface InboxFilterableQuery<Q> {
  not(column: string, operator: string, value: unknown): Q
  is(column: string, value: null): Q
  in(column: string, values: readonly string[]): Q
}

/**
 * 受信箱の絞り込みを**DB の問い合わせに**かける（件数も一覧も同じ述語で絞る）。
 *   open   = 終わっておらぬ（受付・検討中・対応中・**未知の状態**） ← denylist の向き
 *   unread = どの運用者もまだ開いておらぬ
 *   done   = 反映済み（DB の CHECK が本番確認の証拠を必ず伴わせる）・見送り
 * ⚠️ open を「受付・検討中・対応中」の allowlist で書くな。DB に状態が増えた瞬間、その要望が
 * 受信箱のどの棚からも無音で消える（CLAUDE.md の enum drift 防御）。
 */
export function applyInboxView<Q extends InboxFilterableQuery<Q>>(query: Q, view: InboxView): Q {
  if (view === "open") return query.not("status", "in", `(${INBOX_DONE_STATUSES.join(",")})`)
  if (view === "unread") return query.is("operator_seen_at", null)
  if (view === "done") return query.in("status", INBOX_DONE_STATUSES)
  return query
}

/** 投稿者の一覧の 1 行。目印は「運用者から更新あり（未読）」。 */
export function toSubmitterListItem(row: FeedbackListRow): FeedbackListItem {
  const release = releaseOf(row)
  const updated = formatFeedbackDateTime(row.updated_at)
  return {
    id: row.id,
    href: `/feedback/${row.id}`,
    title: row.title,
    status: parseFeedbackStatus(row.status),
    released: release !== null,
    metaLabel: updated ? `${updated} 更新` : "更新日時不明",
    marker: row.submitter_has_unseen ? "更新あり" : null,
  }
}

/** 受信箱の 1 行。目印は「未読」（どの運用者もまだ開いておらぬ）。 */
export function toInboxListItem(row: FeedbackListRow): FeedbackListItem {
  const release = releaseOf(row)
  const created = formatFeedbackDateTime(row.created_at)
  return {
    id: row.id,
    href: `/feedback/inbox/${row.id}`,
    title: row.title,
    status: parseFeedbackStatus(row.status),
    released: release !== null,
    metaLabel: created ? `${created} 受付` : "受付日時不明",
    marker: row.operator_seen_at === null ? "未読" : null,
    submitterName: row.submitter_name,
  }
}

/**
 * 履歴 → 画面の形。`pushSummaries` を渡すと（運用者の画面）知らせの状況の文を添える。
 * 渡さぬ（投稿者の画面）と添えぬ —— 投稿者に配信の内部を見せる必要は無い。
 */
export function toTimelineEntries(
  events: FeedbackEventRow[],
  pushSummaries?: Map<string, FeedbackPushSummary>,
): FeedbackTimelineEntry[] {
  return events.map((event) => {
    const kind = parseFeedbackEventKind(event.kind)
    const toStatus = parseFeedbackStatus(event.to_status)
    // 「反映」を名乗れるのは証拠付きの released への変更だけ（releaseOf と同じ規律）
    const release =
      kind === "status_changed" &&
      toStatus === "released" &&
      event.release_commit_sha &&
      event.release_verified_at
        ? {
            commitSha: event.release_commit_sha,
            note: event.release_note,
            verifiedLabel: formatFeedbackDateTime(event.release_verified_at),
          }
        : null
    const entry: FeedbackTimelineEntry = {
      id: event.id,
      kind,
      toStatus,
      comment: event.comment,
      mergeRef: event.merge_ref,
      release,
      atLabel: formatFeedbackDateTime(event.created_at),
    }
    if (pushSummaries) {
      entry.pushLabel = describeFeedbackPush(pushSummaries.get(event.id) ?? null)
    }
    return entry
  })
}
