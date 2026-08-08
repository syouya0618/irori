/**
 * 毎朝ダイジェスト（B-5）の**判断規則**。副作用を持たぬ純関数だけを置く。
 *
 * `delivery-rules.ts`（予定通知の規則）と同じ思想じゃ。分けてあるのは、
 * ダイジェストの判断材料が予定通知とまるで別物ゆえ:
 *   * 予定通知は「1 件の予定 × 1 件の通知設定」を突き合わせる
 *   * ダイジェストは「その日の予定の**集合**」と「利用者の digest_time」を見る
 * 一方で grace / dedupe_day / 決定の型（{@link PendingDecision}）は**共有する** —
 * 分けたのは材料であって、キューの規律ではない。
 *
 * ⚠️ このファイルは Server Component / Server Action / cron のいずれからも
 * import されうる**中立モジュール**じゃ。`"use client"` も `"use server"` も
 * 持たせてはならぬ。
 */

import { formatJstTimeInput, jstWallClockToIso } from "@/lib/utils/date-jst"
import { parseDigestTimeHm } from "@/lib/domain/notification-digest"
import {
  DELIVERY_GRACE_MS,
  type NotificationPayload,
  type PendingDecision,
  type PendingDelivery,
} from "./delivery-rules"

/** 本文に名前を出す上限。超えた分は「ほか N 件」へ畳む。 */
export const DIGEST_MAX_ITEMS = 3

/**
 * 1 件あたりの題名の上限。
 *
 * push のペイロードには実装依存の上限（おおむね 4KB）が在り、超えれば
 * **その 1 通が丸ごと落ちる**。題名は利用者が自由に書ける値ゆえ、長い題名が
 * 1 つ混ざっただけでその日のダイジェストが消えるのは割に合わぬ。
 */
const DIGEST_TITLE_MAX = 40

/**
 * ダイジェストが読む予定の姿。
 *
 * ⚠️ **`memo` は無い。故意じゃ。** ロック画面は施錠されたままでも中身を映すゆえ、
 * メモ（通院先・金額・私事）を載せると通知そのものが漏洩経路になる。
 * 「載せぬ」を注記だけで守るのは弱い —— 配信ジョブの `select` からも外し、
 * 型にも入れぬことで**構造的に**載らぬようにしてある。
 */
export interface DigestEventSnapshot {
  title: string
  is_all_day: boolean
  /** JST 暦日（開始）。当日より前に始まった予定を「継続」と見分けるのに使う。 */
  start_date: string
  start_at: string | null
}

/**
 * その JST 暦日のダイジェストが鳴るべき瞬間。
 *
 * ⚠️ **ここが JST 契約の唯一の実装じゃ**（`notification-digest.ts` の冒頭を見よ）。
 * `digest_time` は TZ を持たぬ TIME ゆえ、素で `new Date()` に食わせれば
 * 実行環境の TZ（Vercel も Supabase も UTC）で解釈され **9 時間ずれる**。
 *
 * @param day  JST 暦日 "YYYY-MM-DD"（＝ dedupe_day）
 * @param time DB の digest_time（"07:00" でも "07:00:00" でも可）
 * @returns ISO 8601（UTC 表記）。時刻が読めねば null。
 */
export function digestScheduledAtForDay(day: string, time: string): string | null {
  const hm = parseDigestTimeHm(time)
  if (hm === null) return null
  return jstWallClockToIso(day, hm)
}

/** 表示順: 終日・継続を先に、次に開始時刻の早い順、同時刻なら題名順。 */
function compareForDigest(
  a: DigestEventSnapshot,
  b: DigestEventSnapshot,
  day: string,
): number {
  const at = timedStartMs(a, day)
  const bt = timedStartMs(b, day)
  if (at === null && bt === null) return a.title.localeCompare(b.title, "ja")
  if (at === null) return -1
  if (bt === null) return 1
  if (at !== bt) return at - bt
  return a.title.localeCompare(b.title, "ja")
}

/**
 * その日の「時刻付き開始」の epoch。終日・前日から継続中・壊れた値は null。
 *
 * ⚠️ **`start_date !== day` を null に倒すのが要点じゃ。** 3 日にまたがる予定を
 * 2 日目のダイジェストに出すとき、`start_at`（初日の時刻）をそのまま書けば
 * 「今日 10:00 開始」という**在りもせぬ予定**を報せることになる。
 */
function timedStartMs(event: DigestEventSnapshot, day: string): number | null {
  if (event.is_all_day || event.start_at === null) return null
  if (event.start_date !== day) return null
  const t = Date.parse(event.start_at)
  return Number.isNaN(t) ? null : t
}

function clampTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) return "（無題）"
  return trimmed.length <= DIGEST_TITLE_MAX
    ? trimmed
    : `${trimmed.slice(0, DIGEST_TITLE_MAX)}…`
}

/**
 * ダイジェストの本文を組み立てる。**0 件なら null（＝送らぬ）。**
 *
 * 「予定が無い」ことを毎朝報せる価値は無く、それどころか害が在る:
 * 中身の無い通知が続けば主は通知そのものを切る（Safari は可視通知の連打に
 * 特に厳しく、権限ごと失う）。→ 0 件の日は**行すら作らぬ**のが本筋で、
 * ここは「作った後に予定が消えた」場合の最後の砦じゃ。
 *
 * @param day JST 暦日（dedupe_day）
 */
export function buildDigestNotification(
  day: string,
  events: DigestEventSnapshot[],
): NotificationPayload | null {
  if (events.length === 0) return null

  const sorted = [...events].sort((a, b) => compareForDigest(a, b, day))
  const shown = sorted.slice(0, DIGEST_MAX_ITEMS).map((event) => {
    const startMs = timedStartMs(event, day)
    const when =
      startMs === null ? "終日" : formatJstTimeInput(event.start_at as string)
    return `${clampTitle(event.title)} ${when}`
  })
  const rest = events.length - shown.length

  return {
    title: `今日の予定 ${events.length}件`,
    body: rest > 0 ? `${shown.join(" / ")} ほか${rest}件` : shown.join(" / "),
    url: "/calendar",
    // 同じ日のダイジェストが万一 2 通届いても、端末側で 1 つに畳ませる
    // （本命は DB の UNIQUE と claim。これは最後の受け皿じゃ）。
    tag: `digest:${day}`,
  }
}

/**
 * 作り置きのダイジェスト行を、**今の DB の姿**と突き合わせて裁定する。
 *
 * 予定通知（`classifyPendingDelivery`）と同じ形をとる。キューは「作った時点の
 * 意図」を持つが、送る時点の真実は別じゃ —— 主は毎朝の時刻を変えられるし、
 * まとめを切ることもできるし、予定は消えうる。
 *
 * 判断順（先に来たものが勝つ）:
 *   1. grace 切れ        → expired（遅れて鳴るダイジェストは害にしかならぬ）
 *   2. 設定が消えた      → rescheduled（主が「送らない」に戻した）
 *   3. 時刻が動いた      → reaim（**同じ JST 日の中でしか動けぬ**ゆえ常に再照準）
 *   4. 時刻がまだ来ておらぬ → wait
 *   5. 予定が 0 件       → wait（畳まず据え置く。下の注記を見よ）
 *   6. それ以外          → send
 *
 * ⚠️ **5 を skip にせぬ理由。** 「作った後に全部消えた」は、当日中に予定が
 * 入り直せば送るべき状態へ戻る。ここで畳むと `skipped_at` が立ち、同じ冪等キーの
 * 行はもう作れぬゆえ **その日のダイジェストが永久に失われる**（予定通知で
 * `reaim` を用意したのと同じ筋の穴じゃ）。据え置けば、grace を過ぎた時点で
 * 既存の期限切れ掃除が `expired` として畳む —— 新しい skip 理由も、
 * それを許す migration も要らぬ。
 */
export function classifyPendingDigest(input: {
  delivery: PendingDelivery
  /** 今の `notification_preferences.digest_time`（無効なら null）。 */
  digestTime: string | null
  /** その日の予定の件数（本文と同じ集合から数えること）。 */
  eventCount: number
  now: Date
}): PendingDecision {
  const { delivery, digestTime, eventCount, now } = input

  const scheduledMs = Date.parse(delivery.scheduled_at)
  // 壊れた値は送らぬ（fail-closed）。allowlist に無い理由は作れぬゆえ expired を使う。
  if (Number.isNaN(scheduledMs)) return { action: "skip", reason: "expired" }
  if (scheduledMs <= now.getTime() - DELIVERY_GRACE_MS) {
    return { action: "skip", reason: "expired" }
  }

  if (digestTime === null) return { action: "skip", reason: "rescheduled" }

  const expected = digestScheduledAtForDay(delivery.dedupe_day, digestTime)
  if (expected === null) return { action: "skip", reason: "rescheduled" }

  // ⚠️ **文字列比較で済ませるな。** DB が返す timestamptz の表記
  // （"2026-08-15T00:50:00+00:00"）と我々が書いた ISO（"...Z"）は同じ瞬間でも
  // 別の文字列じゃ（`classifyPendingDelivery` と同じ罠）。
  const expectedMs = Date.parse(expected)
  if (Number.isNaN(expectedMs)) return { action: "skip", reason: "rescheduled" }
  if (expectedMs !== scheduledMs) {
    // TIME の変更は**同じ JST 日の中でしか動けぬ**（dedupe_day = その日そのもの）
    // ゆえ、予定通知に在った「日を跨いだら rescheduled」の枝はここには無い。
    return { action: "reaim", scheduledAt: expected }
  }

  if (scheduledMs > now.getTime()) return { action: "wait" }
  if (eventCount === 0) return { action: "wait" }

  return { action: "send" }
}
