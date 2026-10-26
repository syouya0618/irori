/**
 * 要望・改善提案（feedback）の**中立モジュール**。
 *
 * Server Component・Server Action・Client Component・cron のいずれからも import される。
 * ⚠️ `"use client"` も `"use server"` も持たせてはならぬ（定数を値で import した Server
 * Component が client reference を掴んで実行時に壊れる / `"use server"` は非 async の
 * export でビルドが落ちる。~/.claude/rules/nextjs-supabase.md の既知の罠）。
 *
 * DB 側の正本は `supabase/migrations/20261025200001_feedback.sql` じゃ。ここの定数・述語は
 * その**写し**で、ずれると「画面では送れるのに保存できぬ」が最も気付きにくい形で起きる。
 * 対の検査は `__tests__/feedback.test.ts`（境界値）と pgTAP `feedback_lifecycle.sql`。
 */

/** 状態。DB の `chk_feedback_items_status` と対で維持すること。 */
export const FEEDBACK_STATUSES = [
  "received",
  "considering",
  "in_progress",
  "released",
  "declined",
] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  received: "受付",
  considering: "検討中",
  in_progress: "対応中",
  released: "反映済み",
  declined: "見送り",
}

/**
 * 状態の説明（投稿者向け）。
 *
 * ⚠️ 「対応中」に「まもなく反映」等の約束を書くな。反映は本番で確かめてから運用者が
 * 確定する（released）。それより前に反映を匂わせる文言は、未確認の段階で
 * 「反映された」と読ませるのと同じじゃ。
 */
export const FEEDBACK_STATUS_DESCRIPTIONS: Record<FeedbackStatus, string> = {
  received: "受け付けました。運用者が内容を確認します",
  considering: "対応するかどうかを検討しています",
  in_progress: "対応を進めています。本番へ反映して確かめたら「反映済み」になります",
  released: "本番の irori に反映されたことを運用者が確かめました",
  declined: "今回は見送りになりました。理由は返信をご覧ください",
}

/** 未知の値は null（enum drift 防御。投げて画面ごと倒さぬ）。 */
export function parseFeedbackStatus(value: unknown): FeedbackStatus | null {
  return typeof value === "string" &&
    (FEEDBACK_STATUSES as readonly string[]).includes(value)
    ? (value as FeedbackStatus)
    : null
}

/**
 * 運用者が**通常の状態変更**で選べる状態。released は含めぬ —— 証拠（本番確認の宣言と
 * コミット SHA）を伴う確定フォーム（`operator_release_feedback`）でしか立てられぬ。
 */
export const OPERATOR_SETTABLE_STATUSES = [
  "received",
  "considering",
  "in_progress",
  "declined",
] as const satisfies readonly FeedbackStatus[]
export type OperatorSettableStatus = (typeof OPERATOR_SETTABLE_STATUSES)[number]

export function isOperatorSettableStatus(value: unknown): value is OperatorSettableStatus {
  return (
    typeof value === "string" &&
    (OPERATOR_SETTABLE_STATUSES as readonly string[]).includes(value)
  )
}

/** 受信箱の「対応待ち・対応中」（終わっておらぬもの）。 */
export function isOpenFeedbackStatus(status: FeedbackStatus | null): boolean {
  // ⚠️ denylist の向きで書く（終わった 2 つだけを名指しする）。未知の状態（null）は
  // 「まだ終わっておらぬ」側に倒す —— 受信箱から無音で消えるより、残って目に付く方が安全じゃ。
  return status !== "released" && status !== "declined"
}

// ── 文字列の形（DB の feedback_text_ok の写し）──────────────────────────

export const FEEDBACK_TITLE_MAX = 100
export const FEEDBACK_BODY_MAX = 2000
export const FEEDBACK_COMMENT_MAX = 2000
export const FEEDBACK_MERGE_REF_MAX = 100
export const FEEDBACK_RELEASE_NOTE_MAX = 200

/** 長さは**コードポイント**で数える（DB の char_length と揃える。絵文字 1 つ = 1）。 */
export function countCodePoints(text: string): number {
  return Array.from(text).length
}

/**
 * 前後から落とす空白のコードポイント: 空白・タブ・改行・復帰・全角空白（U+3000）。
 * DB の `feedback_trim_chars()`（`' ' || chr(9) || chr(10) || chr(13) || chr(12288)`）と
 * **同じ集合**じゃ。⚠️ 文字そのものをソースへ書かぬ（全角空白は目に見えぬ）。
 */
const TRIM_CODE_POINTS: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d, 0x3000])

/**
 * 改行を LF に揃え、前後の空白を落とす。
 *
 * `String.prototype.trim()` は使わぬ —— あちらは NBSP 等も落とすゆえ、DB と集合がずれると
 * 「画面では通ったのに DB が拒む」（逆向きなら無害）を生む。
 */
export function normalizeFeedbackText(raw: string): string {
  const chars = Array.from(raw.replace(/\r\n?/g, "\n"))
  let start = 0
  let end = chars.length
  while (start < end && TRIM_CODE_POINTS.has(chars[start].codePointAt(0) ?? 0)) start += 1
  while (end > start && TRIM_CODE_POINTS.has(chars[end - 1].codePointAt(0) ?? 0)) end -= 1
  return chars.slice(start, end).join("")
}

/**
 * 拒む文字か。C0 / C1 制御文字（複数行の欄では改行とタブを除く）と、表示の向きを
 * 入れ替える双方向制御文字（U+202A–U+202E / U+2066–U+2069）。
 *
 * 正規表現の文字クラスではなくコードポイントで判じる（制御文字を正規表現に書くと
 * lint の no-control-regex と読み手の両方を惑わせる）。
 */
function isForbiddenCodePoint(cp: number, multiline: boolean): boolean {
  if (multiline && (cp === 0x09 || cp === 0x0a)) return false
  if (cp <= 0x1f) return true
  if (cp >= 0x7f && cp <= 0x9f) return true
  if (cp >= 0x202a && cp <= 0x202e) return true
  if (cp >= 0x2066 && cp <= 0x2069) return true
  return false
}

export type FeedbackTextError = "required" | "too_long" | "invalid_chars"

/**
 * 正規化**済み**の文字列を検査する。`required=false` の欄は空を許す。
 * 返り値 null = 通る。
 */
export function checkFeedbackText(
  text: string,
  options: { max: number; multiline: boolean; required: boolean },
): FeedbackTextError | null {
  if (text.length === 0) return options.required ? "required" : null
  if (countCodePoints(text) > options.max) return "too_long"
  for (const ch of text) {
    if (isForbiddenCodePoint(ch.codePointAt(0) ?? 0, options.multiline)) {
      return "invalid_chars"
    }
  }
  return null
}

export function feedbackTextErrorMessage(
  error: FeedbackTextError,
  field: { label: string; max: number },
): string {
  if (error === "required") return `${field.label}を入力してください`
  if (error === "too_long") return `${field.label}は${field.max}文字以内で入力してください`
  return `${field.label}に使えない文字が含まれています`
}

// ── 「反映済み」の証拠 ─────────────────────────────────────────

/** 7〜40 桁の 16 進（短縮 SHA も可）。DB と同じ形。前後空白と大文字は正規化してから当てる。 */
export const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/

export function normalizeCommitSha(raw: string): string {
  return raw.trim().toLowerCase()
}

/** 確定を処理したサーバが観測したデプロイ（"production:<sha>" 等）。DB と同じ形。 */
export const OBSERVED_DEPLOY_RE = /^(production|preview|development):[0-9a-f]{7,40}$/

/**
 * Vercel のシステム環境変数から、今このサーバが動いておるデプロイを組む。
 * 取れねば null（ローカル・e2e では無いのが正常）。形が違えば null（DB が拒むゆえ、
 * 怪しい値を送って確定ごと失敗させぬ）。
 *
 * 引数で env を受けるのはテストのため。呼び出しはサーバ側（Server Component / Action）だけ。
 */
export function observedDeployFromEnv(
  env: Record<string, string | undefined>,
): string | null {
  const stage = env.VERCEL_ENV?.trim()
  const sha = env.VERCEL_GIT_COMMIT_SHA?.trim().toLowerCase()
  if (!stage || !sha) return null
  const value = `${stage}:${sha}`
  return OBSERVED_DEPLOY_RE.test(value) ? value : null
}

/**
 * 入力した SHA と稼働中のデプロイの SHA が同じコミットを指すか（短縮形どうしの前方一致）。
 * 一致しなくても「反映されておらぬ」とは言えぬ（稼働中のデプロイは入力したコミットを
 * 祖先に含みうる）。画面の手掛かりにだけ使う。
 */
export function commitShaMatches(a: string, b: string): boolean {
  if (!COMMIT_SHA_RE.test(a) || !COMMIT_SHA_RE.test(b)) return false
  return a.startsWith(b) || b.startsWith(a)
}

// ── DB のエラーコード（migration 冒頭の表の写し）────────────────────────

export const FEEDBACK_DB_ERROR = {
  unauthenticated: "28000",
  forbidden: "42501",
  invalid: "22023",
  notFound: "P0002",
  requestConflict: "IRF01",
  rateLimited: "IRF02",
  versionConflict: "IRF03",
} as const

// ── Server Action の戻り値（`"use server"` のファイルは型以外の非 async を export できぬ
//    ゆえ、形はここに置く）──────────────────────────────────────

export type SubmitFeedbackResult =
  /** 新しく受け付けた */
  | { status: "created"; feedbackId: string }
  /** 同じ鍵・同じ内容の要望が既に在った（応答だけが失われた再送） */
  | { status: "duplicate"; feedbackId: string }
  /**
   * 同じ鍵で別の内容が既に送られておった（直した文面を黙って捨てぬ）。
   * 画面は鍵を作り直し、前の送信（`feedbackId`。引けなければ null）へ辿れるようにする。
   */
  | { status: "conflict"; feedbackId: string | null }
  | { status: "error"; error: string; field?: "title" | "body" }

export type OperatorFeedbackResult =
  /** duplicate = 同じ操作が既に記録されておった（応答だけが失われた再送） */
  | { status: "ok"; version: number; duplicate: boolean }
  /** 開いた後に誰か（自分の別端末を含む）が先に更新した。読み直してから操作する */
  | { status: "conflict" }
  | { status: "error"; error: string }

// ── 表示用の形 ─────────────────────────────────────────────

export interface FeedbackReleaseView {
  commitSha: string
  note: string | null
  observedDeploy: string | null
  verifiedAt: string
}

/**
 * 「反映済み」と描いてよいか。**状態の完全一致と証拠の両方**を要する。
 *
 * ⚠️ ここは CLAUDE.md の「未知の値は denylist で扱え」の**例外**じゃ。誤って
 * 「反映済み」と出すことこそ禁じられた向き（未確認の段階で妻に反映を告げる）ゆえ、
 * allowlist（released と完全一致）かつ証拠が揃った時だけ真にする。
 */
export function releaseOf(row: {
  status: string
  released_commit_sha: string | null
  released_note: string | null
  released_observed_deploy: string | null
  released_verified_at: string | null
}): FeedbackReleaseView | null {
  if (row.status !== "released") return null
  if (!row.released_commit_sha || !row.released_verified_at) return null
  return {
    commitSha: row.released_commit_sha,
    note: row.released_note,
    observedDeploy: row.released_observed_deploy,
    verifiedAt: row.released_verified_at,
  }
}

export type FeedbackEventKind = "submitted" | "status_changed" | "commented" | "other"

export function parseFeedbackEventKind(value: unknown): FeedbackEventKind {
  return value === "submitted" || value === "status_changed" || value === "commented"
    ? value
    : "other"
}

/** 状態ラベル。未知の状態は中立の文言へ退化させる（「反映済み」等を推測で出さぬ）。 */
export function feedbackStatusLabel(status: FeedbackStatus | null): string {
  return status ? FEEDBACK_STATUS_LABELS[status] : "状態を確認中"
}

/** `get_feedback_push_summary` の 1 行（履歴 1 件ぶんの知らせの数）。 */
export interface FeedbackPushSummary {
  queued: number
  accepted: number
  unconfirmed: number
  gone: number
  expired: number
  revoked: number
  /** 送る前に状態がさらに変わったゆえ送らなんだ（差し戻し後の古い知らせ等） */
  superseded: number
}

/**
 * 運用者の画面に出す「知らせの状況」の文。
 *
 * ⚠️ **「届いた」と書くな。** 分かるのは push サービスが受け取ったか（accepted）までで、
 * 端末に表示されたかは誰にも分からぬ。sent_at だけが立った行（unconfirmed）は結果不明じゃ。
 * 行が 1 つも無いのは「購読端末が無かった・積めなかった」で、アプリ内の表示が唯一の知らせになる。
 */
export function describeFeedbackPush(summary: FeedbackPushSummary | null): string {
  if (!summary) {
    return "Push の宛先なし（アプリ内の表示だけで知らせます）"
  }
  const parts: string[] = []
  if (summary.accepted > 0) {
    parts.push(`Push サービスが受理 ${summary.accepted} 台（端末での表示は確認できません）`)
  }
  if (summary.queued > 0) parts.push(`送信待ち ${summary.queued} 台`)
  if (summary.unconfirmed > 0) parts.push(`結果不明 ${summary.unconfirmed} 台`)
  if (summary.gone > 0) parts.push(`端末の登録切れ ${summary.gone} 台`)
  if (summary.expired > 0) parts.push(`期限切れで未送信 ${summary.expired} 台`)
  if (summary.revoked > 0) parts.push(`宛先の資格なしで未送信 ${summary.revoked} 台`)
  if (summary.superseded > 0) {
    parts.push(`状態が変わったため未送信 ${summary.superseded} 台`)
  }
  return parts.length > 0
    ? parts.join("・")
    : "Push の宛先なし（アプリ内の表示だけで知らせます）"
}

const JST_DATETIME_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/**
 * timestamptz → "10/25 21:03"（JST・h23 固定）。サーバで確定させて渡す
 * （クライアントのレンダー中に整形すると SSR とハイドレーションで食い違いうる）。
 * パースできぬ値は null。
 */
export function formatFeedbackDateTime(iso: string | null): string | null {
  if (!iso) return null
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return null
  return JST_DATETIME_FORMATTER.format(time)
}
