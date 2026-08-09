/**
 * 通知パイプラインの健康診断（B-4）。
 *
 * ## なぜ 2 つの時刻を並べるのか
 * `MAX(sent_at)`（最終配信）だけでは **「壊れておる」と「送るものが無かった」が
 * 区別できぬ**。予定を 1 件も登録しなかった週も最終配信は進まぬゆえ、主には
 * 「通知が止まった」と「今週は静かだった」が同じ画面に見える。
 * `notification_heartbeat.ran_at`（最終実行）は cron が回った事実そのもの——
 * 配信ジョブは `finally` で必ず書く（`deliver.ts`）。この 2 つが揃って初めて
 * 「パイプライン停止」と「平穏」が分かれる。
 *
 * ## 読み方は runbook の表と同じにする
 * `docs/runbooks/notify-cron.md` の一次監視:
 *   | ran_at | failed_count | 意味 |
 *   | 新しい | 0 | 平穏 |
 *   | 新しい | 1 以上 | 走ってはおるが壊れておる |
 *   | 10 分以上前 | — | 起動しておらぬ |
 * ここに 4 つ目 —— **行そのものが無い**（migration が初期行を置かぬ設計ゆえ、
 * pg_cron を登録する前は必ずこれじゃ）—— を足す。古い相対時刻として描くと
 * 「止まった」と誤読させるゆえ、別の状態として扱う。
 *
 * そして 5 つ目 —— **診断そのものが読めなかった**（migration 未適用の 42P01・
 * RLS 拒否・一過性の DB エラー）。これを 4 つ目に畳むと、画面は「まだ一度も
 * 実行されていません」と**断言**する。主は pg_cron を疑って調べ始め、真因
 * （読めなかっただけ）へは辿り着かぬ。しかも動いておる基盤を止めに行く誤操作を
 * 誘発する。この機能が在る理由は「故障」と「無風」の弁別ゆえ、その弁別を
 * 自分で潰しては本末転倒じゃ。
 */

/**
 * 心拍が古いと見なす閾値。**runbook の 10 分と揃える**（片方だけ動かすと、
 * 画面と手順書が違うことを言い出す）。cron は 5 分ごとゆえ 1 回の取りこぼしは
 * 許し、2 回続けて落ちたら知らせる幅じゃ。
 */
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000

export type NotificationRunState =
  /** **診断そのものが読めなかった**（migration 未適用・RLS 拒否・一過性エラー） */
  | "unknown"
  /** 心拍の行が無い ＝ まだ一度も走っておらぬ（pg_cron 未登録） */
  | "never"
  /** ran_at が古い ＝ 起動しておらぬ */
  | "stale"
  /** 走ってはおるが、直近の実行に失敗が在る */
  | "failing"
  /** 平穏 */
  | "healthy"

export type NotificationDeliveryState = "unknown" | "never" | "sent"

export interface NotificationHealthInput {
  /** `notification_heartbeat.ran_at`。行が無ければ null。 */
  ranAt: string | null
  /** `notification_heartbeat.failed_count`。行が無ければ null。 */
  failedCount: number | null
  /** 世帯の `MAX(sent_at)`。1 件も送っておらねば null。 */
  lastSentAt: string | null
  /**
   * 心拍の**取得自体に失敗した**か（呼び出し側の `error` の有無）。
   *
   * ⚠️ **これを渡さねば「読めなかった」が「まだ一度も走っておらぬ」に化ける。**
   * 両者は正反対の対処を要する（前者は表示の故障、後者は pg_cron 未登録）。
   * B-3 の migration が「しかも『まだ走っておらぬ』と区別がつかぬ ＝ 最悪の壊れ方」
   * と名指しして RLS 層で防いだ取り違えを、アプリ層で再導入せぬための入力じゃ。
   */
  ranAtUnknown?: boolean
  /** 最終配信の取得自体に失敗したか。同上。 */
  lastSentUnknown?: boolean
  now: Date
}

/**
 * 画面へ渡す形。**相対表記はここで確定させる**（サーバで組んでクライアントへ
 * 渡す）。クライアントのレンダー中に `Date.now()` を読むと、SSR とハイドレーション
 * で違う文字列になり得る。
 */
export interface NotificationHealthView {
  runState: NotificationRunState
  /** 「3分前」等。心拍が無ければ null。 */
  ranAtLabel: string | null
  failedCount: number
  deliveryState: NotificationDeliveryState
  /** 「1時間前」等。1 件も送っておらねば null。 */
  lastSentLabel: string | null
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * 「たった今 / N分前 / N時間前 / N日前」。
 *
 * - `Intl.RelativeTimeFormat` を使わぬのは、ICU の版で語形が動くのを避けるため
 *   （このリポは `formatTimeJst` が既定で "24:00" を出す件で一度踏んでおる）。
 * - **未来の時刻は「たった今」へ丸める**。端末とサーバの時計はずれるゆえ、
 *   「-3分前」のような表記を出さぬ。
 * - パースできぬ値は null（呼び出し側が「不明」へ退化させる）。
 *   ⚠️ `new Date()` に渡すのは**時刻を含む ISO 文字列**じゃ。`YYYY-MM-DD` を
 *   渡すと UTC 解釈される（CLAUDE.md の既知の罠）が、ここに来るのは
 *   `timestamptz` の値ゆえ該当せぬ。
 */
export function formatRelativeJa(iso: string | null, now: Date): string | null {
  if (!iso) return null
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return null
  const diff = now.getTime() - time
  if (diff < MINUTE_MS) return "たった今"
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}分前`
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}時間前`
  return `${Math.floor(diff / DAY_MS)}日前`
}

export function summarizeNotificationHealth(
  input: NotificationHealthInput,
): NotificationHealthView {
  const { ranAt, failedCount, lastSentAt, ranAtUnknown, lastSentUnknown, now } =
    input
  const ranAtTime = ranAt ? new Date(ranAt).getTime() : NaN
  const failed = failedCount ?? 0

  // 判定の順は load-bearing じゃ。
  // 「読めなかった」→「行が無い」→「古い」→「失敗が在る」の順に強く、最後に
  // 平穏へ落ちる。**「読めなかった」を先頭に置くのが要**: 読み取りに失敗した時も
  // `ranAt` は null で来るゆえ、後ろに置けば never に食われて「まだ一度も走って
  // おらぬ」と断言してしまう。逆順にすると、止まっておる cron の古い failed_count を
  // 「壊れておる」と読んでしまい、**本当の症状（起動しておらぬ）が隠れる**。
  let runState: NotificationRunState
  if (ranAtUnknown) {
    runState = "unknown"
  } else if (!ranAt || Number.isNaN(ranAtTime)) {
    runState = "never"
  } else if (now.getTime() - ranAtTime >= HEARTBEAT_STALE_MS) {
    runState = "stale"
  } else if (failed > 0) {
    runState = "failing"
  } else {
    runState = "healthy"
  }

  // 最終配信も同じ理由で 3 値じゃ（読めなかった ≠ 1 件も送っておらぬ）。
  const deliveryState: NotificationDeliveryState = lastSentUnknown
    ? "unknown"
    : lastSentAt
      ? "sent"
      : "never"

  return {
    runState,
    ranAtLabel:
      runState === "never" || runState === "unknown"
        ? null
        : formatRelativeJa(ranAt, now),
    failedCount: failed,
    deliveryState,
    lastSentLabel: deliveryState === "unknown" ? null : formatRelativeJa(lastSentAt, now),
  }
}
