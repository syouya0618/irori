import { unstable_isUnrecognizedActionError } from "next/navigation"
import { clientBuildId, isComparableBuildId } from "@/lib/release/build-info"

/**
 * 端末の版とサーバの版を比べる（2026-10-27 大型更新 E1）。
 *
 * ## 何を比べ、何を言わぬか
 * - 端末: この bundle にビルド時に埋め込まれた短い SHA（`clientBuildId()`）
 * - サーバ: `GET /api/version` が返す、いま答えておるデプロイの短い SHA
 * - どちらかが `"dev"`・取得失敗・期限切れ・ログインの門（307/401）・JSON でない応答なら
 *   **「確認できなかった」**。「最新です」とは言わぬ（取得失敗を「新しい版は無い」と言い換えぬ）
 * - Service Worker の更新（`registration.update()`）はアプリ本体の更新の証拠ではない —
 *   `public/sw.js` は build ごとのバイトを持たぬゆえ、新しいデプロイでも SW は変わらぬことが多い。
 *   ホーム画面のアイコン・名前（manifest）は OS が独自の間隔で読み直す、別の保証じゃ
 *
 * ## 古い画面から新しいサーバへ（版の食い違い）
 * 新しいデプロイの後、開いたままの古い画面が Server Action を呼ぶと、サーバにその action が無く
 * `UnrecognizedActionError`（"Server Action ... was not found on the server"）で失敗する
 * （node_modules/next/dist/docs/01-app/02-guides/server-actions.md「Deployment considerations」）。
 * `noteServerActionFailure` はそれを見分け、更新の案内へ知らせる。呼び出し側は失敗の文言を
 * 「画面を読み直してから、もう一度」に替える（保存されなかったと断定はせぬ — action が見つからぬ
 * 時はサーバで何も実行されておらぬが、呼び出し側は失敗の種類をこの関数でだけ判じる）。
 */

export const VERSION_ENDPOINT = "/api/version"
/** 取得の期限。超えたら取り消して「確認できなかった」とする */
export const VERSION_FETCH_TIMEOUT_MS = 8_000
/** 画面復帰のたびに叩かぬための間隔（proxy の認可を毎回通るゆえ） */
export const VERSION_RECHECK_INTERVAL_MS = 10 * 60 * 1000

export type VersionCheckState = "same" | "different" | "unknown"

export type VersionUnknownReason =
  | "dev-build"
  | "timeout"
  | "network"
  | "gate"
  | "http"
  | "malformed"
  | "aborted"

export interface VersionCheckResult {
  state: VersionCheckState
  clientBuildId: string
  /** サーバが答えた版（取得できなかった時は null） */
  serverBuildId: string | null
  reason: VersionUnknownReason | null
}

/** 端末とサーバの版を比べる（純粋）。dev は比べぬ。 */
export function compareBuilds(
  client: string,
  server: string | null,
): { state: VersionCheckState; reason: VersionUnknownReason | null } {
  if (!isComparableBuildId(client) || !isComparableBuildId(server)) {
    return { state: "unknown", reason: "dev-build" }
  }
  return { state: client === server ? "same" : "different", reason: null }
}

function parseVersionBody(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null
  const buildId = (value as Record<string, unknown>).buildId
  return typeof buildId === "string" && /^(?:[0-9a-f]{7}|dev)$/.test(buildId) ? buildId : null
}

/**
 * サーバの版を引いて比べる。期限（8 秒）と取消し（`signal`）を持つ。例外は投げぬ
 * （更新の案内は補助の機能ゆえ、失敗は「確認できなかった」へ畳む）。
 */
export async function checkServerVersion(
  options: { signal?: AbortSignal; client?: string; timeoutMs?: number } = {},
): Promise<VersionCheckResult> {
  const client = options.client ?? clientBuildId()
  const unknown = (reason: VersionUnknownReason, serverBuildId: string | null = null) => ({
    state: "unknown" as const,
    clientBuildId: client,
    serverBuildId,
    reason,
  })
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? VERSION_FETCH_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener("abort", onOuterAbort, { once: true })
  }
  try {
    const res = await fetch(VERSION_ENDPOINT, {
      cache: "no-store",
      // ログインの門（307）を追わぬ: 追うと /login の HTML を 200 で受ける
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    if (
      res.type === "opaqueredirect" ||
      res.status === 0 ||
      res.status === 401 ||
      (res.status >= 300 && res.status < 400)
    ) {
      return unknown("gate")
    }
    if (!res.ok) return unknown("http")
    const contentType = res.headers.get("content-type") ?? ""
    if (!contentType.includes("application/json")) return unknown("malformed")
    const server = parseVersionBody(await res.json())
    if (server === null) return unknown("malformed")
    const compared = compareBuilds(client, server)
    return { ...compared, clientBuildId: client, serverBuildId: server }
  } catch (err) {
    if (timedOut) return unknown("timeout")
    if (controller.signal.aborted) return unknown("aborted")
    console.warn("[app-version] 版の確認に失敗", {
      message: err instanceof Error ? err.message : String(err),
    })
    return unknown("network")
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onOuterAbort)
  }
}

// ───────────── 古い画面から新しいサーバへ（action が見つからぬ）の知らせ ─────────────

let staleClientDetected = false
const listeners = new Set<() => void>()

export function subscribeStaleClient(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getStaleClientDetected(): boolean {
  return staleClientDetected
}

export function getStaleClientDetectedOnServer(): boolean {
  return false
}

/** 画面が古い版のまま新しいサーバへ action を送った時の文言（保存したとも、しなかったとも断定せぬ） */
export const STALE_CLIENT_ACTION_MESSAGE =
  "アプリが新しくなっています。画面を読み直してから、もう一度お試しください"

/**
 * Server Action の失敗が「版の食い違い（action が見つからぬ）」かを判じ、そうなら更新の案内へ
 * 知らせる。戻り値 true のとき、呼び出し側は STALE_CLIENT_ACTION_MESSAGE を出す。
 */
export function noteServerActionFailure(err: unknown): boolean {
  if (!unstable_isUnrecognizedActionError(err)) return false
  if (!staleClientDetected) {
    staleClientDetected = true
    for (const listener of listeners) listener()
  }
  return true
}

/** テスト用（モジュールの状態を戻す） */
export function resetStaleClientForTest(): void {
  staleClientDetected = false
  listeners.clear()
}
