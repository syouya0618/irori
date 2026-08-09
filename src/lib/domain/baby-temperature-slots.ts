import { toJstDateString, formatJstTimeInput } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"

/**
 * 朝/夜スロットの境界時刻（JST の「時」）。
 * 朝 = 00:00〜11:59 / 夜 = 12:00〜23:59。
 *
 * **DB に列は足さない。** 朝/夜は `logged_at` から表示側で導出する契約ゆえ、
 * 境界を変えたくなればこの定数 1 つで変えられる（列にすると過去の全行が NULL に
 * なり、境界を後から動かせなくなる）。
 */
export const TEMPERATURE_SLOT_BOUNDARY_HOUR = 12

/** 発熱とみなす体温（℃）。この値**以上**を発熱域として扱う。 */
export const FEVER_THRESHOLD_C = 37.5

export type TemperatureSlot = "morning" | "night"

/** スロットの主表示に選ばれた 1 件。`id` は編集シートを開くために要る。 */
export interface TemperatureSlotEntry {
  id: string
  temperature: number
  /** ISO 8601（サーバ行は "+00:00"、楽観 append 行は "Z" 終端で混在しうる） */
  loggedAt: string
}

export interface DailyTemperature {
  morning: TemperatureSlotEntry | null
  night: TemperatureSlotEntry | null
  /** 朝枠の追加件数（主表示の 1 件を除いた数）。発熱時に何度も測る運用を殺さないため。 */
  morningExtra: number
  /** 夜枠の追加件数（同上） */
  nightExtra: number
}

/**
 * ISO 8601 タイムスタンプが JST で朝枠・夜枠のどちらに属するかを返す。
 *
 * ⚠️ **時刻の取り出しに `formatTimeJst` を使ってはならぬ。** あちらは `ja-JP` で
 * `hourCycle` を指定しておらず、ICU 既定によって**深夜 0 時を "24:00" と出しうる**
 * （`date-jst.ts:197-200` が同じ理由で `<input type="time">` 用に h23 を別途固定して
 * おる）。"24" を取ると `24 >= 12` で **00:xx JST が夜へ落ちる** — 朝いちの検温が
 * 静かに夜枠へ化ける経路じゃ。ゆえに h23 を明示した `formatJstTimeInput` から取る。
 *
 * 不正な ISO（Invalid Date）は Intl が `RangeError` を投げるため、その手前で
 * `morning` へ倒す（カード全体を落とさぬ。`buildDailyTemperature` は呼ぶ前に
 * NaN 行を落とすため、この経路は直接呼び出し用の防御）。
 */
export function assignTemperatureSlot(loggedAtIso: string): TemperatureSlot {
  if (Number.isNaN(new Date(loggedAtIso).getTime())) return "morning"
  const hour = Number(formatJstTimeInput(loggedAtIso).slice(0, 2))
  return hour < TEMPERATURE_SLOT_BOUNDARY_HOUR ? "morning" : "night"
}

/**
 * ログ列から指定日（JST の "YYYY-MM-DD"）の朝/夜の体温を組む純関数。
 *
 * - `log_type !== "temperature"` と `temperature == null` の行は無視する
 * - 各枠の主表示は**その枠の最新** 1 件。残りは `*Extra` に件数だけ数える
 *
 * ⚠️ 最新の比較は**必ず epoch**（`new Date(iso).getTime()`）で行う。文字列比較は
 * 楽観 append 行（`toISOString()` の "Z" 終端）とサーバ行（"+00:00"）で表記が
 * 混在し、**辞書順が時刻順と食い違う**ため使えぬ（`findLastNursing` と同じ理由。
 * 例: "…T09:00:00+09:00"(09:00 JST) と "…T01:00:00.000Z"(10:00 JST) は
 * 辞書順では前者が後、しかし実時刻では後者が後）。
 *
 * `extractTemperatures`（`baby-log-aggregation.ts`）は**流用できぬ** — 返り値が
 * `id` を持たず（編集シートを開けぬ）、`time` が "HH:MM" 文字列ゆえ epoch 比較も
 * できぬ。あれは PDF レポート専用の形と割り切り、ここは `BabyLogData` から組む。
 */
export function buildDailyTemperature(
  logs: BabyLogData[],
  ymd: string,
): DailyTemperature {
  let morning: TemperatureSlotEntry | null = null
  let night: TemperatureSlotEntry | null = null
  let morningEpoch = Number.NEGATIVE_INFINITY
  let nightEpoch = Number.NEGATIVE_INFINITY
  let morningCount = 0
  let nightCount = 0

  for (const log of logs) {
    if (log.log_type !== "temperature") continue
    if (log.temperature == null) continue

    // NaN の判定は toJstDateString より**先**に置く（順序は load-bearing）:
    // Invalid Date を Intl.format へ渡すと RangeError を投げ、カードごと倒れる。
    const epoch = new Date(log.logged_at).getTime()
    if (Number.isNaN(epoch)) continue
    if (toJstDateString(log.logged_at) !== ymd) continue

    const entry: TemperatureSlotEntry = {
      id: log.id,
      temperature: log.temperature,
      loggedAt: log.logged_at,
    }

    if (assignTemperatureSlot(log.logged_at) === "morning") {
      morningCount++
      if (epoch > morningEpoch) {
        morning = entry
        morningEpoch = epoch
      }
    } else {
      nightCount++
      if (epoch > nightEpoch) {
        night = entry
        nightEpoch = epoch
      }
    }
  }

  return {
    morning,
    night,
    morningExtra: Math.max(0, morningCount - 1),
    nightExtra: Math.max(0, nightCount - 1),
  }
}

/** 発熱域（`FEVER_THRESHOLD_C` 以上）かを返す。境界値そのものは発熱に**含む**。 */
export function isFeverTemperature(temperature: number): boolean {
  return temperature >= FEVER_THRESHOLD_C
}
