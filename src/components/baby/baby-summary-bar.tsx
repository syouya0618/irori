"use client"

import { Milk, Droplets, Timer } from "lucide-react"
import { formatElapsedMinutes, minutesBetween } from "@/lib/utils/baby-log-labels"
import { todayJstString, formatTimeJst } from "@/lib/utils/date-jst"
import { computeNextFeeding } from "@/lib/domain/baby-feeding-interval"
import { getLogSummary } from "@/lib/domain/baby-log-summary"
import type { TodayCounts } from "@/lib/domain/baby-log-aggregation"
import type { BabyLogData } from "@/lib/types/baby"

/**
 * 授乳チップの値を種別内訳（母乳8・ミルク2・搾乳1・離乳食1）へ整形する。
 *
 * **なぜ合算「N回」をやめたか**: 母乳サイクル数を bottle/pumped/solid と混ぜて
 * 「授乳 N 回」と見せると、「母乳を何回あげたか」が読めない（混合数に化ける）。
 * おむつチップの「おしっこ2・うんち1」と同じ流儀で非ゼロのみを「・」で連結する。
 *
 * 全ゼロのときは `feedingCount` へ退避する: 記録のない日は 0 なので「0回」になり、
 * feeding 行はあるのに内訳が立たない日（`feeding_type` が未知 enum 値で null 退化
 * した #159 の経路）にだけ合算回数が出る — 行があるのに「0回」と嘘をつかないため。
 */
function formatFeedingBreakdown(counts: TodayCounts): string {
  const parts: string[] = []
  if (counts.breastCycleCount > 0) parts.push(`母乳${counts.breastCycleCount}`)
  if (counts.bottleCount > 0) parts.push(`ミルク${counts.bottleCount}`)
  if (counts.pumpedCount > 0) parts.push(`搾乳${counts.pumpedCount}`)
  if (counts.solidCount > 0) parts.push(`離乳食${counts.solidCount}`)
  if (parts.length > 0) return parts.join("・")
  return `${counts.feedingCount}回`
}

interface BabySummaryBarProps {
  /**
   * 最後の授乳行（log_type='feeding'・**搾乳を含む**）。「最終授乳」表示に使う。
   * 目安の起点とは別物ゆえ混同しないこと（`lastNursing` の注記を参照）。
   */
  lastFeeding: BabyLogData | null
  /**
   * 最後に赤子へ与えた授乳（母乳/ミルク/離乳食。**搾乳は除く**）。
   * 次の授乳の目安の起点に使う。搾乳は赤子に与えていないため目安をリセットしない。
   */
  lastNursing: BabyLogData | null
  /** 授乳間隔（分・設定値）。最後の授乳の開始＋この間隔で次の目安を出す */
  feedingIntervalMin: number
  now: Date
  todayCounts: TodayCounts
  /** 表示中の日付（YYYY-MM-DD、JST）。今日か過去日かでラベル・経過表示を切り替える */
  date: string
  /**
   * 選択日の記録の取得状態（P2-10）。ready 以外は数字を出さず「—」にする —
   * 取得中・失敗中の空配列を「0回」「---」と真値のように見せぬ（レビュー P3-5）
   */
  status?: "ready" | "loading" | "error"
  /**
   * 「今」カードとまとめの間に差し込む面（ダッシュボードのクイック記録）。最終授乳を
   * 見た直後に記録釦へ手が届く並びにするため。省略時はカードとまとめが続く。
   */
  children?: React.ReactNode
}

const PENDING_MARK = "—"

/**
 * 育児画面の最上部に置く「今の状態」と「その日のまとめ」。
 *
 * 夜間に抱っこしたまま一瞥で読むための面ゆえ、今日は**最終授乳からの経過を最も大きく**
 * 出し、次の授乳の目安を同じカードに並べる（以前は 12px の小カード 2 枚と別カードに散り、
 * おむつの内訳は 2 か所に重複していた）。過去日は「経過」ではなく、その日の最後の授乳の
 * 時刻を出す（別日の経過は意味を持たぬ）。
 *
 * 授乳の `logged_at` は**開始時刻**（CLAUDE.md の契約）ゆえ、経過は「授乳の開始から」と
 * 読める文言にする。このカードは読み取り専用で button にはせぬ — タイムライン行
 * （/母乳/・/うんち（大量）/ で掴まれる）と accessible name を奪い合わぬため。
 */
export function BabySummaryBar({
  lastFeeding,
  lastNursing,
  feedingIntervalMin,
  now,
  todayCounts,
  date,
  status = "ready",
  children,
}: BabySummaryBarProps) {
  // isToday は now 引数由来で判定する（実行環境の実時計は見ない）。
  // テストで now を固定した際に実日付とズレて誤判定しないため。
  const isToday = date === todayJstString(now)
  const pending = status !== "ready"
  const [, monthStr, dayStr] = date.split("-")
  const dateLabel = isToday
    ? "今日のまとめ"
    : `${Number(monthStr)}/${Number(dayStr)} のまとめ`

  const feedingElapsed =
    isToday && lastFeeding
      ? minutesBetween(lastFeeding.logged_at, now.toISOString())
      : null

  // 次の授乳の目安: 今日の表示 + 最後の授乳がある時のみ（最後の授乳の開始＋設定間隔）。
  // 起点は搾乳を除いた授乳（lastNursing）。深夜跨ぎで前日行になった授乳も
  // dashboard 側の fallback を通じてここへ届く。
  const nextFeeding =
    isToday && lastNursing && !pending
      ? computeNextFeeding(lastNursing.logged_at, feedingIntervalMin, now)
      : null
  const overdue = nextFeeding !== null && nextFeeding.minutesUntil <= 0

  // 最終授乳の主値。今日は経過（開始から）、過去日はその日の最後の授乳の時刻
  const lastFeedingValue = pending
    ? PENDING_MARK
    : isToday
      ? feedingElapsed !== null
        ? formatElapsedMinutes(feedingElapsed) + "前"
        : "---"
      : // 過去日: lastFeeding はその日の logs 由来なので絶対時刻は正確
        lastFeeding
        ? formatTimeJst(lastFeeding.logged_at)
        : "---"
  // 何をいつ始めたか（「20:10 開始・母乳（左から） 左2回10分・右1回7分」）。開始側は
  // 記録に在る時だけ要約が添える（推奨の「次は右から」は出さぬ — 記録に無い推測ゆえ）
  const lastFeedingDetail =
    !pending && lastFeeding
      ? isToday
        ? `${formatTimeJst(lastFeeding.logged_at)} 開始・${getLogSummary(lastFeeding)}`
        : getLogSummary(lastFeeding)
      : null

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label={isToday ? "今の授乳の状況" : "この日の最後の授乳"}
        className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"
      >
        <div className="flex items-start gap-3">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40"
            aria-hidden="true"
          >
            <Milk size={20} className="text-amber-700 dark:text-amber-300" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-muted-foreground">
              {isToday ? "最終授乳（開始から）" : "最終授乳"}
            </span>
            <span className="text-3xl font-bold leading-tight tabular-nums">
              {lastFeedingValue}
            </span>
            {lastFeedingDetail && (
              <span className="truncate text-sm text-muted-foreground">
                {lastFeedingDetail}
              </span>
            )}
          </div>
        </div>

        {/* 次の授乳の目安（最後の授乳の開始＋設定間隔）。授乳記録がある今日だけ表示 */}
        {nextFeeding && (
          <div
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${
              overdue
                ? "bg-amber-100 dark:bg-amber-900/40"
                : "bg-muted/60 dark:bg-muted/40"
            }`}
          >
            <Timer
              size={18}
              className="shrink-0 text-amber-700 dark:text-amber-300"
              aria-hidden="true"
            />
            <span className="text-sm text-muted-foreground">次の授乳の目安</span>
            <span className="ml-auto flex items-baseline gap-2">
              <span className="font-mono text-xl font-semibold tabular-nums">
                {formatTimeJst(nextFeeding.targetIso)}
              </span>
              <span
                className={`text-sm ${
                  overdue
                    ? "font-semibold text-amber-800 dark:text-amber-200"
                    : "text-muted-foreground"
                }`}
              >
                {/* 目安を過ぎたら「そろそろです」で張り付かせず、超過した経過時間を出す
                    （どれだけ過ぎたかが読めないと次の判断ができないため） */}
                {nextFeeding.minutesUntil > 0
                  ? `あと${formatElapsedMinutes(nextFeeding.minutesUntil)}`
                  : `${formatElapsedMinutes(-nextFeeding.minutesUntil)} 経過`}
              </span>
            </span>
          </div>
        )}
      </section>

      {children}

      {/* その日のまとめ（ひと目化）。e2e が group 名「今日のまとめ」と文言の形
          （0回 / 母乳1 / おしっこ1・うんち0）で掴むゆえ、名前と書式は変えぬ */}
      <div
        role="group"
        aria-label={dateLabel}
        aria-busy={pending || undefined}
        className="glass grid grid-cols-2 divide-x divide-border/60 rounded-2xl py-3 shadow-lg shadow-black/[0.04]"
      >
        <TodayStat
          icon={<Milk size={16} className="text-amber-600 dark:text-amber-400" />}
          label={isToday ? "今日の授乳" : "授乳"}
          value={pending ? PENDING_MARK : formatFeedingBreakdown(todayCounts)}
        />
        <TodayStat
          icon={<Droplets size={16} className="text-sky-600 dark:text-sky-400" />}
          label={isToday ? "今日のおむつ" : "おむつ"}
          value={
            pending
              ? PENDING_MARK
              : `おしっこ${todayCounts.peeCount}・うんち${todayCounts.poopCount}`
          }
        />
      </div>
    </div>
  )
}

function TodayStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    // 授乳・おむつの値は複合表示（母乳8・ミルク2 / おしっこ2・うんち1）ゆえ、
    // min-w-0 を置いて flex アイテムが縮める（= 溢れた最悪ケースは
    // カードを横に破らず 2 行へ折り返す）ようにする。whitespace-nowrap は付けない。
    <div className="flex min-w-0 flex-col items-center gap-1 px-2 text-center">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span aria-hidden="true">{icon}</span>
        <span>{label}</span>
      </div>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  )
}
