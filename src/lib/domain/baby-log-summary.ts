import {
  getFeedingTypeLabel,
  formatDiaperSummary,
  formatBreastCounts,
  formatBreastSideBreakdown,
  formatBreastStartSide,
  formatDurationSec,
} from "@/lib/utils/baby-log-labels"
import type { BabyLogData } from "@/lib/types/baby"

/**
 * タイムライン 1 行の要約文（「母乳（左から） 左1回5分・右2回10分」等）。
 *
 * ⚠️ **境界指令を持たぬ中立モジュール**に置く。Client Component（baby-timeline-item）と
 * Server Component（baby-search-results）の両方が**値として** import するため、
 * use client 指令のファイルに置くと Server 側では client reference に差し替わり、呼んだ
 * 瞬間に throw する（tsc も next build も通ったまま実行時に落ちる — CLAUDE.md の罠。
 * 回帰の番人: src/app/__tests__/server-client-value-import.test.ts）。
 */
export function getLogSummary(log: BabyLogData): string {
  switch (log.log_type) {
    case "feeding": {
      if (!log.feeding_type) return "授乳"
      const label = getFeedingTypeLabel(log.feeding_type)
      // 母乳サイクル行は開始側を「母乳（左から）」と種別に添える（不明なら何も足さない
      // — 旧行は開始側を持たぬのが正常ゆえ、欠落を目立たせない）
      const parts = [
        log.feeding_type === "breast"
          ? `${label}${formatBreastStartSide(log.breast_start_side)}`
          : label,
      ]
      // 母乳サイクル（'breast'）で左右別時間（sides）を持つ行は
      // 「母乳 左2回7分30秒・右1回5分」と側ごとに表示し、合計は併記しない
      // （左右の和と自明・二重表示は密度を壊す）。sides を持たない行
      // （#165 期の旧サイクル行）は従来の「母乳 左2・右1 12分30秒」へフォールバック。
      if (log.feeding_type === "breast" && log.breast_left_sec != null) {
        const breakdown = formatBreastSideBreakdown(
          log.breast_left_count,
          log.breast_right_count,
          log.breast_left_sec,
          log.breast_right_sec,
        )
        if (breakdown) parts.push(breakdown)
        return parts.join(" ")
      }
      // formatBreastCounts は内訳なし（両側 0/null）で "" を返す契約ゆえ、空文字を
      // push すると join(" ") で「母乳  12分30秒」と二重空白の間延びした行になる。
      if (log.feeding_type === "breast") {
        const counts = formatBreastCounts(
          log.breast_left_count,
          log.breast_right_count,
        )
        if (counts) parts.push(counts)
      }
      if (log.amount_ml != null) parts.push(`${log.amount_ml}ml`)
      // 秒精度があれば「M分S秒」で表示、無ければ従来の分表示にフォールバック
      if (log.duration_sec != null) parts.push(formatDurationSec(log.duration_sec))
      else if (log.duration_min) parts.push(`${log.duration_min}分`)
      return parts.join(" ")
    }
    case "diaper":
      // 量を持つ行は「うんち（大量）」。量なし（旧行・指定なし）は従来どおり種別だけ
      return log.diaper_type
        ? formatDiaperSummary(log.diaper_type, log.poop_amount)
        : "おむつ"
    // 廃止済みの旧種別（logTypeConfig と同じ理由で退化形のみ残す）
    case "sleep":
      return "睡眠"
    case "temperature":
      return log.temperature != null ? `${log.temperature}℃` : "体温"
    case "growth": {
      const parts: string[] = []
      if (log.weight_g != null) parts.push(`${log.weight_g}g`)
      if (log.height_cm != null) parts.push(`${log.height_cm}cm`)
      return parts.length > 0 ? parts.join(" / ") : "成長記録"
    }
    case "memo":
      return log.memo ? log.memo.slice(0, 20) : "メモ"
  }
}
