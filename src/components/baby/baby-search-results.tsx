import Link from "next/link"
import { BookOpen, ChevronRight, SearchX } from "lucide-react"
import { babyDateHref } from "@/lib/domain/baby-link"
import { formatDiaryDateHeadingFromYmd } from "@/lib/domain/baby-diary"
import {
  SEARCH_KIND_LABELS,
  SEARCH_PAGE_SIZE,
  excerptAround,
  searchHref,
  type BabySearchQuery,
  type SearchCursor,
} from "@/lib/domain/baby-search"
import { formatTimeJst, toJstDateString } from "@/lib/utils/date-jst"
// ⚠️ Server Component ゆえ、use client 指令のファイルから値を import してはならぬ
// （client reference に化けて実行時に throw する）。要約は中立モジュールから取る
import { getLogSummary } from "@/lib/domain/baby-log-summary"
import type { BabyDiaryData, BabyLogData } from "@/lib/types/baby"

export interface BabySearchResultsProps {
  query: BabySearchQuery
  /** 新しい順。SEARCH_PAGE_SIZE 件まで（超えた分は次のページ） */
  logs: BabyLogData[]
  /** 条件に合う記録の総数（世帯の境界の中）。読めなかった時は null */
  logsTotal: number | null
  /** 次のページがあれば、その cursor */
  nextLogsCursor: SearchCursor | null
  diaries: BabyDiaryData[]
  diariesTotal: number | null
  nextDiaryDate: string | null
  /** 記録者の表示名（二人以上の世帯でだけ親が渡す） */
  recorderLabelFor: ((loggedBy: string) => string) | null
  /** 取得に失敗した側。失敗を空と偽らぬ */
  failed: { logs: boolean; diaries: boolean }
}

function describeScope(query: BabySearchQuery): string {
  const parts: string[] = []
  if (query.from && query.to) parts.push(`${query.from} 〜 ${query.to}`)
  else if (query.from) parts.push(`${query.from} 以降`)
  else if (query.to) parts.push(`${query.to} まで`)
  else parts.push("全期間")
  parts.push(SEARCH_KIND_LABELS[query.kind])
  if (query.q) parts.push(`「${query.q}」`)
  return parts.join("・")
}

function groupByDate(logs: BabyLogData[]): { date: string; logs: BabyLogData[] }[] {
  const groups: { date: string; logs: BabyLogData[] }[] = []
  for (const log of logs) {
    const date = toJstDateString(log.logged_at)
    const last = groups.at(-1)
    if (last && last.date === date) last.logs.push(log)
    else groups.push({ date, logs: [log] })
  }
  return groups
}

/**
 * 検索結果（機能 B）。日付ごとにまとめ、各日からその日の画面（/baby?date=）へ飛べる。
 * 件数と範囲を示し、「全履歴を探した」と言える形にする。ページ送りは URL の cursor。
 */
export function BabySearchResults({
  query,
  logs,
  logsTotal,
  nextLogsCursor,
  diaries,
  diariesTotal,
  nextDiaryDate,
  recorderLabelFor,
  failed,
}: BabySearchResultsProps) {
  const showLogs = query.kind !== "diary"
  const showDiaries = query.kind === "all" || query.kind === "diary"
  const empty =
    (!showLogs || (logs.length === 0 && !failed.logs)) &&
    (!showDiaries || (diaries.length === 0 && !failed.diaries))

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-xs text-muted-foreground" aria-live="polite">
        {describeScope(query)}
        {showLogs && (
          <>
            ・記録{" "}
            {failed.logs ? "読み込めませんでした" : logsTotal !== null ? `${logsTotal} 件` : "件数不明"}
          </>
        )}
        {showDiaries && (
          <>
            ・日記{" "}
            {failed.diaries
              ? "読み込めませんでした"
              : diariesTotal !== null
                ? `${diariesTotal} 件`
                : "件数不明"}
          </>
        )}
      </p>

      {(failed.logs || failed.diaries) && (
        <div role="alert" className="glass rounded-2xl px-4 py-3 text-sm text-destructive shadow-lg shadow-black/[0.04]">
          一部の結果を読み込めませんでした。時間をおいてもう一度お試しください
        </div>
      )}

      {empty && (
        <div className="flex flex-col items-center justify-center gap-3 py-12">
          <SearchX size={48} className="text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">見つかりませんでした</p>
        </div>
      )}

      {showLogs && logs.length > 0 && (
        <section aria-label="記録の検索結果" className="flex flex-col gap-3">
          {groupByDate(logs).map((group) => (
            <div key={group.date} className="flex flex-col gap-1">
              <Link
                href={babyDateHref(group.date)}
                className="flex min-h-11 items-center justify-between px-1 text-sm font-semibold text-muted-foreground transition-colors duration-200 hover:text-foreground"
              >
                {formatDiaryDateHeadingFromYmd(group.date)}
                <span className="flex items-center gap-0.5 text-xs font-normal">
                  この日を開く
                  <ChevronRight size={13} />
                </span>
              </Link>
              <ul className="glass divide-y divide-border/30 rounded-2xl shadow-lg shadow-black/[0.04]">
                {group.logs.map((log) => (
                  <li key={log.id} className="flex items-start gap-3 p-3">
                    <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">
                      {formatTimeJst(log.logged_at)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium">{getLogSummary(log)}</span>
                      {log.memo && log.log_type !== "memo" && (
                        <span className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                          {excerptAround(log.memo, query.q)}
                        </span>
                      )}
                    </span>
                    {recorderLabelFor && (
                      <span className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                        {recorderLabelFor(log.logged_by)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {nextLogsCursor && (
            <Link
              href={searchHref(query, { before: nextLogsCursor, beforeDate: query.beforeDate })}
              className="glass flex min-h-11 items-center justify-center rounded-2xl px-4 text-sm font-medium text-muted-foreground shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:text-foreground"
            >
              さらに古い記録を表示（{SEARCH_PAGE_SIZE} 件ずつ）
            </Link>
          )}
        </section>
      )}

      {showDiaries && diaries.length > 0 && (
        <section aria-label="日記の検索結果" className="flex flex-col gap-2">
          <h2 className="flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            <BookOpen size={13} />
            日記
          </h2>
          {diaries.map((diary) => (
            <Link
              key={diary.id}
              href={babyDateHref(diary.diary_date)}
              className="glass flex min-h-11 flex-col gap-1 rounded-2xl p-4 shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:bg-accent/30"
            >
              <span className="text-xs font-semibold text-muted-foreground">
                {formatDiaryDateHeadingFromYmd(diary.diary_date)}
              </span>
              <span className="text-sm leading-relaxed break-words whitespace-pre-wrap">
                {excerptAround(diary.content, query.q, 60)}
              </span>
            </Link>
          ))}
          {nextDiaryDate && (
            <Link
              href={searchHref(query, { before: query.before, beforeDate: nextDiaryDate })}
              className="glass flex min-h-11 items-center justify-center rounded-2xl px-4 text-sm font-medium text-muted-foreground shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:text-foreground"
            >
              さらに古い日記を表示
            </Link>
          )}
        </section>
      )}
    </div>
  )
}
