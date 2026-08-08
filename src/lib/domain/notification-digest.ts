/**
 * 毎朝ダイジェスト（B-5）の**語彙**。時刻の表現と、その正規化だけを置く。
 *
 * **なぜ中立モジュールか**: この定数は設定カード（`"use client"`）・Server Action
 * （`"use server"`）・配信ジョブ（cron）の三方から使う。`"use client"` を持つ
 * ファイルに置いて Server 側から**値として** import すると Next.js が client
 * reference へ差し替え、`tsc --noEmit` も `next build` も緑のまま実行時に壊れる
 * （`event-reminder.ts` / `calendar-event-columns.ts` と同じ理由）。
 *
 * ============================================================
 * ⚠️【この機能の生死を分ける契約】digest_time は TZ を持たぬ TIME じゃ
 * ============================================================
 * `notification_preferences.digest_time` は `TIME`（TZ 無し）で、**JST
 * (Asia/Tokyo) の壁時計時刻として解釈する**のが契約じゃ。DB 側の正本は
 * `20260808100002_event_reminders.sql` の列 COMMENT にある。ここはその写しであり、
 * **コードから読む者のための正本**でもある。
 *
 * 破ると何が起きるか: Vercel の実行環境も Supabase の cron も TZ=UTC で回る。
 * `07:00` を素の UTC として扱えば **JST 16:00 に鳴る**（9 時間ずれ）。しかも
 * 「鳴らぬ」のではなく「違う時刻に鳴る」ゆえ、気付くまでに何日もかかる。
 * → 時刻から瞬間を起こすときは必ず `jstWallClockToIso()` を通すこと
 *   （`digest-rules.ts` の `digestScheduledAtForDay()` が唯一の実装じゃ）。
 * ============================================================
 */

/** Select の「送らない」を表す値。DB では `digest_time IS NULL` に対応する。 */
export const DIGEST_TIME_NONE = "none"

/** 選択肢の刻み（分）。30 分あれば毎朝のまとめには足りる。 */
const DIGEST_SLOT_MINUTES = 30

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** "00:00" 〜 "23:30" の 30 分刻み（48 個）。**画面と Server Action の共通の正本**。 */
export const DIGEST_TIME_SLOTS: readonly string[] = Array.from(
  { length: (24 * 60) / DIGEST_SLOT_MINUTES },
  (_, i) => `${pad2(Math.floor((i * DIGEST_SLOT_MINUTES) / 60))}:${pad2((i * DIGEST_SLOT_MINUTES) % 60)}`,
)

/** Select の選択肢（base-ui Select の `items` = ラベル解決に使う）。 */
export const DIGEST_TIME_OPTIONS: { value: string; label: string }[] = [
  { value: DIGEST_TIME_NONE, label: "送らない" },
  ...DIGEST_TIME_SLOTS.map((hm) => ({ value: hm, label: hm })),
]

/** Server Action の入力検証はこれを通す（画面が出す集合と**同じ配列**を見る）。 */
export function isDigestTimeSlot(value: unknown): value is string {
  return typeof value === "string" && DIGEST_TIME_SLOTS.includes(value)
}

/**
 * DB の `TIME` 値（`"07:00:00"`）を画面と配信が使う `"HH:MM"` へ正規化する。
 *
 * ⚠️ **これを省くと設定が画面から消える。** Postgres の TIME は秒まで付けて
 * 返す（`07:00:00`）が、Select の選択肢は `07:00` じゃ。素で渡すと base-ui の
 * Select は**どの item にも一致せぬ値**を受け取り、主が保存した設定が空欄に
 * 見える —— そして「保存できておらぬ」と誤解して設定し直す。tsc も build も
 * vitest も緑のまま通る類の壊れ方ゆえ、読む側で必ず正規化する。
 *
 * 刻み（30 分）には**縛らぬ**: DB の TIME は任意の時刻を許すゆえ、SQL から
 * 直接入った `07:13` を「不正」として捨てると、配信は 07:13 に鳴るのに画面は
 * 「送らない」と表示する ＝ 画面が嘘をつく。形式が妥当なら受け入れ、
 * 選択肢に無い値は呼び出し側（カード）が選択肢へ足して見せる。
 *
 * @returns "HH:MM"（00:00〜23:59）。読めねば null。
 */
export function parseDigestTimeHm(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return `${pad2(hour)}:${pad2(minute)}`
}
