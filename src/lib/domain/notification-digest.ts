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

/**
 * 提示する帯（JST の壁時計・両端を含む）。
 *
 * ⚠️ **機能の名は「毎朝のまとめ」じゃ。** 一日 48 通りから選ばせると、選択肢は
 * 長くなるばかりで「この機能が何をするものか」を画面から奪う（22:30 のまとめは
 * 「今日の予定」を今日が終わってから報せる代物じゃ）。朝の帯へ絞ることそのものが
 * 説明になっておる。
 *
 * ⚠️ **帯を狭めると「保存済みの値が選択肢の外」になる利用者が生まれる**
 * （既に 12:00 を選んでおった人・SQL から 07:13 が入った人）。その値を選択肢へ
 * 足して**一覧から消さぬ**ための配慮が `notification-card.tsx` の
 * `digestItemsFor` じゃ（トリガの表示は生の値が出るゆえ変わらぬ。失われるのは
 * 「開いた時に一覧に在ること」の方 —— あちらの docstring に実測を書いた）。
 * **帯を触るなら、あちらのテスト（開いて option を数える）も必ず読め。**
 */
const DIGEST_SLOT_START_MINUTES = 5 * 60
const DIGEST_SLOT_END_MINUTES = 10 * 60

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/**
 * "05:00" 〜 "10:00" の 30 分刻み（11 個）。**画面と Server Action の共通の正本**。
 *
 * ⚠️ **この 1 本から画面の選択肢（{@link DIGEST_TIME_OPTIONS}）と Server Action の
 * allowlist（{@link isDigestTimeSlot}）の両方を導いておる。** 別々に書けば必ず
 * ずれ、「画面が出した値を保存できぬ」または「保存できる値を画面が出せぬ」という
 * 最も気付きにくい壊れ方をする。
 */
export const DIGEST_TIME_SLOTS: readonly string[] = Array.from(
  {
    length:
      (DIGEST_SLOT_END_MINUTES - DIGEST_SLOT_START_MINUTES) / DIGEST_SLOT_MINUTES + 1,
  },
  (_, i) => {
    const minutes = DIGEST_SLOT_START_MINUTES + i * DIGEST_SLOT_MINUTES
    return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`
  },
)

/**
 * 未設定の主へ差し出す既定の時刻。**この値は必ず {@link DIGEST_TIME_SLOTS} の中に在る。**
 *
 * ⚠️ **これを「初期選択」にするな。** DB が NULL のときに Select が 07:00 を
 * 選んで見えれば、**設定しておらぬのに設定済みに見える** ＝ 画面が嘘をつく
 * （毎朝待っても来ぬ）。使い道は「07:00 で始める」の 1 タップ導線ただ 1 つで、
 * 押されて初めて保存される（`notification-card.tsx`）。
 */
export const DIGEST_TIME_DEFAULT = "07:00"

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
 * ⚠️ **これを省くと画面に「07:00:00」がそのまま出る。** Postgres の TIME は秒まで
 * 付けて返すが、Select の選択肢は `07:00` じゃ。素で渡すと base-ui の Select は
 * どの item にも一致せぬ値を受け取り、**その生の値をそのまま描く**
 * （このリポジトリの版で計測。空欄にはならぬ）。主は見慣れぬ表記を「壊れておる」
 * と読み、設定し直す。しかもその値は Server Action の allowlist の外ゆえ、
 * 「画面に出ておるのに保存できぬ」値が 1 つ画面に居座る。
 *
 * tsc も build も通る類の壊れ方ゆえ、読む側で必ず正規化する。検出器は
 * `notification-card-digest.test.tsx` の**完全一致**の assert じゃ
 * （`toHaveTextContent("07:00")` は "07:00:00" にも当たって緑になる）。
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
