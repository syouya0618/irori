import {
  CircleCheck,
  GitMerge,
  MessageSquareReply,
  RefreshCw,
  Send,
  type LucideIcon,
} from "lucide-react"
import { FEEDBACK_STATUS_LABELS } from "@/lib/domain/feedback"
import type { FeedbackTimelineEntry } from "@/lib/domain/feedback-view"

function headlineOf(entry: FeedbackTimelineEntry): { icon: LucideIcon; text: string } {
  if (entry.kind === "submitted") return { icon: Send, text: "要望を受け付けました" }
  if (entry.kind === "commented") return { icon: MessageSquareReply, text: "運用者から返信がありました" }
  if (entry.kind === "status_changed") {
    // 「反映」を名乗るのは証拠付きの released だけ（推測で反映を告げぬ）
    if (entry.release) return { icon: CircleCheck, text: "本番への反映を確かめました" }
    if (entry.toStatus && entry.toStatus !== "released") {
      return {
        icon: RefreshCw,
        text: `状態が「${FEEDBACK_STATUS_LABELS[entry.toStatus]}」になりました`,
      }
    }
  }
  return { icon: RefreshCw, text: "状態が更新されました" }
}

/**
 * 要望の履歴（古い順）。投稿者の詳細と運用者の詳細の共用。
 *
 * ⚠️ 「取り込み済み（マージ）」は**本番反映ではない**と画面でも言い切る。マージの記録を
 * 反映と読ませる文言・色を足すな（反映は運用者が本番で確かめてから released で確定する）。
 */
export function FeedbackTimeline({ entries }: { entries: FeedbackTimelineEntry[] }) {
  return (
    <ol aria-label="対応の履歴" className="flex flex-col gap-3">
      {entries.map((entry) => {
        const { icon: Icon, text } = headlineOf(entry)
        return (
          <li
            key={entry.id}
            className="glass flex gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
            >
              <Icon size={16} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="text-sm font-semibold">{text}</p>
              {entry.atLabel && (
                <p className="text-sm text-muted-foreground">{entry.atLabel}</p>
              )}
              {entry.release && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  {entry.release.verifiedLabel && (
                    <>
                      <dt className="text-muted-foreground">確認した日時</dt>
                      <dd>{entry.release.verifiedLabel}</dd>
                    </>
                  )}
                  {entry.release.note && (
                    <>
                      <dt className="text-muted-foreground">リリース</dt>
                      <dd className="break-words">{entry.release.note}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">コミット</dt>
                  <dd className="font-mono">{entry.release.commitSha.slice(0, 12)}</dd>
                </dl>
              )}
              {entry.mergeRef && (
                <p className="flex items-start gap-1.5 text-sm">
                  <GitMerge size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                  <span className="break-words">
                    変更を取り込みました（本番への反映はまだです）: {entry.mergeRef}
                  </span>
                </p>
              )}
              {entry.comment && (
                <p className="rounded-xl bg-muted px-3 py-2 text-base whitespace-pre-wrap break-words">
                  {entry.comment}
                </p>
              )}
              {entry.pushLabel && (
                <p className="text-sm text-muted-foreground">{entry.pushLabel}</p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
