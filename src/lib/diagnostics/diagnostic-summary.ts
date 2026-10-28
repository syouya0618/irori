/**
 * 要望に任意で添える診断要約（2026-10-27 大型更新 E4）。
 *
 * ## 入れるもの（これだけ）
 * - リリース名・短い build 識別子
 * - 端末の**種類**（OS とブラウザの大まかな名前だけ。UA の版番号・機種名は出さぬ）
 * - ホーム画面から開いたか（standalone）
 * - 直近の失敗の分類（操作の種類・失敗の種類・経過秒・時刻は分まで）。下の allowlist の値だけ
 * - 匿名の追跡 id（添える時にその場で作る乱数。利用者・端末と結び付く値ではない）
 *
 * ## 入れぬもの
 * 日記本文・子の名前・メール・授乳の内容（量・時刻）・token・URL の詳細・利用者 id・世帯 id。
 * 失敗の記録は**列挙した値しか保存も復元もせぬ**（自由文・エラーメッセージ・URL は受け付けぬ）ゆえ、
 * どこかの呼び出しが誤って本文を渡しても、ここを通る時点で落ちる。
 *
 * 送信は既存の要望の本文へ追記するだけ（新しい分析サービス・セッションの録画は入れぬ）。
 * 利用者は添える前に全文を見られ、既定はオフ。
 */

export const DIAGNOSTIC_OPERATIONS = [
  "export",
  "sign-out",
  "feedback",
  "login",
  "save",
  "version-check",
] as const
export type DiagnosticOperation = (typeof DIAGNOSTIC_OPERATIONS)[number]

export const DIAGNOSTIC_FAILURE_KINDS = [
  "network",
  "timeout",
  "auth",
  "http-4xx",
  "http-5xx",
  "malformed",
  "stale-client",
  "result-unknown",
  "rejected",
] as const
export type DiagnosticFailureKind = (typeof DIAGNOSTIC_FAILURE_KINDS)[number]

const OPERATION_LABELS: Record<DiagnosticOperation, string> = {
  export: "書き出し",
  "sign-out": "ログアウト",
  feedback: "要望の送信",
  login: "ログインメールの送信",
  save: "記録の保存",
  "version-check": "版の確認",
}

const FAILURE_LABELS: Record<DiagnosticFailureKind, string> = {
  network: "通信できなかった",
  timeout: "時間切れ",
  auth: "ログイン状態",
  "http-4xx": "受け付けられなかった",
  "http-5xx": "サーバの障害",
  malformed: "応答の形が違った",
  "stale-client": "画面の版が古かった",
  "result-unknown": "結果が分からなかった",
  rejected: "拒否された",
}

export interface RecentFailure {
  op: DiagnosticOperation
  kind: DiagnosticFailureKind
  /** 経過（秒・整数）。不明は null */
  elapsedSec: number | null
  /** 起きた時刻（UTC ISO を分で切ったもの） */
  at: string
}

export const RECENT_FAILURES_KEY = "irori:diag-recent:v1"
const MAX_RECENT = 5

function isOperation(v: unknown): v is DiagnosticOperation {
  return typeof v === "string" && (DIAGNOSTIC_OPERATIONS as readonly string[]).includes(v)
}
function isFailureKind(v: unknown): v is DiagnosticFailureKind {
  return typeof v === "string" && (DIAGNOSTIC_FAILURE_KINDS as readonly string[]).includes(v)
}
const MINUTE_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/

function toMinuteIso(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16)}Z`
}

function parseRecent(raw: string | null): RecentFailure[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: RecentFailure[] = []
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue
      const { op, kind, elapsedSec, at } = item as Record<string, unknown>
      if (!isOperation(op) || !isFailureKind(kind)) continue
      if (typeof at !== "string" || !MINUTE_ISO_RE.test(at)) continue
      const sec =
        typeof elapsedSec === "number" && Number.isInteger(elapsedSec) && elapsedSec >= 0 && elapsedSec < 86_400
          ? elapsedSec
          : null
      out.push({ op, kind, elapsedSec: sec, at })
    }
    return out.slice(-MAX_RECENT)
  } catch {
    return []
  }
}

/** 直近の失敗（この端末・このタブの sessionStorage。読めねば空） */
export function readRecentFailures(): RecentFailure[] {
  try {
    return parseRecent(sessionStorage.getItem(RECENT_FAILURES_KEY))
  } catch {
    return []
  }
}

/**
 * 失敗を 1 件記録する（列挙した値だけ。自由文は受け付けぬ）。sessionStorage ゆえタブを閉じれば消え、
 * 自動でどこかへ送ることもない（利用者が要望に添えた時だけ本文に載る）。
 */
export function recordClientFailure(input: {
  op: DiagnosticOperation
  kind: DiagnosticFailureKind
  elapsedMs?: number | null
  nowMs?: number
}): void {
  if (!isOperation(input.op) || !isFailureKind(input.kind)) return
  const elapsedSec =
    typeof input.elapsedMs === "number" && Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0
      ? Math.min(86_399, Math.round(input.elapsedMs / 1000))
      : null
  const entry: RecentFailure = {
    op: input.op,
    kind: input.kind,
    elapsedSec,
    at: toMinuteIso(input.nowMs ?? Date.now()),
  }
  try {
    const next = [...readRecentFailures(), entry].slice(-MAX_RECENT)
    sessionStorage.setItem(RECENT_FAILURES_KEY, JSON.stringify(next))
  } catch {
    // 保存できぬ端末では記録せぬ（診断は補助。本来の操作を止めぬ）
  }
}

// ───────────── 端末の種類（大まかな名前だけ） ─────────────

export interface DeviceKind {
  os: string
  browser: string
}

/** UA から OS とブラウザの**名前だけ**を引く。版番号・機種名は返さぬ。 */
export function coarseDeviceKind(ua: string, maxTouchPoints = 0): DeviceKind {
  let os = "不明"
  if (/iPhone|iPod/.test(ua)) os = "iPhone"
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) os = "iPad"
  else if (/Android/.test(ua)) os = "Android"
  else if (/CrOS/.test(ua)) os = "ChromeOS"
  else if (/Macintosh|Mac OS X/.test(ua)) os = "Mac"
  else if (/Windows/.test(ua)) os = "Windows"
  else if (/Linux/.test(ua)) os = "Linux"

  let browser = "不明"
  if (/EdgiOS|EdgA|Edg\//.test(ua)) browser = "Edge"
  else if (/SamsungBrowser/.test(ua)) browser = "Samsung Internet"
  else if (/FxiOS|Firefox\//.test(ua)) browser = "Firefox"
  else if (/CriOS|Chrome\//.test(ua)) browser = "Chrome"
  else if (/Safari\//.test(ua)) browser = "Safari"
  return { os, browser }
}

/** ホーム画面から開いたか（判定できぬ環境は null） */
export function detectStandalone(): boolean | null {
  try {
    const nav = navigator as Navigator & { standalone?: boolean }
    if (nav.standalone === true) return true
    if (typeof window.matchMedia === "function") {
      return window.matchMedia("(display-mode: standalone)").matches
    }
    return null
  } catch {
    return null
  }
}

/** その場で作る匿名の追跡 id（12 桁の 16 進）。利用者・端末とは結び付かぬ */
export function newTraceId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

const JST_MINUTE = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

export const DIAGNOSTIC_HEADER = "--- 診断情報（任意で添付） ---"

/**
 * 本文の末尾に付ける文面を組む（純粋）。ここで作った文字列を**そのまま**利用者に見せ、そのまま送る。
 */
export function buildDiagnosticSummary(input: {
  releaseName: string
  buildId: string
  device: DeviceKind
  standalone: boolean | null
  failures: readonly RecentFailure[]
  traceId: string
}): string {
  const launch =
    input.standalone === true
      ? "ホーム画面から起動"
      : input.standalone === false
        ? "ブラウザで表示"
        : "起動方法は不明"
  const failures =
    input.failures.length === 0
      ? ["直近の失敗: なし（この画面を開いているタブで記録されたもの）"]
      : [
          "直近の失敗:",
          ...input.failures.map((f) => {
            const elapsed = f.elapsedSec === null ? "" : `・${f.elapsedSec}秒`
            const when = JST_MINUTE.format(new Date(f.at))
            return `- ${OPERATION_LABELS[f.op]}・${FAILURE_LABELS[f.kind]}${elapsed}（${when}）`
          }),
        ]
  return [
    DIAGNOSTIC_HEADER,
    `版: ${input.releaseName} / ${input.buildId}`,
    `端末: ${input.device.os}・${input.device.browser}（${launch}）`,
    ...failures,
    `追跡ID: ${input.traceId}`,
  ].join("\n")
}

/** 端末から集めて組む（ブラウザでだけ呼ぶ） */
export function collectDiagnosticSummary(input: {
  releaseName: string
  buildId: string
}): string {
  return buildDiagnosticSummary({
    releaseName: input.releaseName,
    buildId: input.buildId,
    device: coarseDeviceKind(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    standalone: detectStandalone(),
    failures: readRecentFailures(),
    traceId: newTraceId(),
  })
}

/** 要望の本文に診断を付けた送信用の本文（区切りは空行 1 つ） */
export function appendDiagnostic(body: string, diagnostic: string | null): string {
  if (!diagnostic) return body
  return body.length === 0 ? diagnostic : `${body}\n\n${diagnostic}`
}
