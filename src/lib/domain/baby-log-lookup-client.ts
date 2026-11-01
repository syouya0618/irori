import type { BabyLogData } from "@/lib/types/baby"

/**
 * 応答不明の保存の照合（クライアント側）。GET /api/baby-logs/lookup を期限・取消しつきで引く。
 *
 * 結果は「見つかった / まだ見つからぬ / 確かめられぬ」を分ける。見つからぬことは保存されなかった
 * 断定ではない（応答の失われた要求がまだ処理中でありうる）。取消し（cancelled）と期限切れ
 * （timeout）と失敗（error）・ログイン切れ（auth）も区別する — 画面はそれぞれ次の一手が違う。
 *
 * 認証の redirect（proxy の 307 → /login）を「見つからぬ」と読み違えぬよう redirect: "manual"。
 */
export type LookupOutcome =
  | { status: "found"; logs: BabyLogData[] }
  | { status: "notFound" }
  | { status: "auth" }
  | { status: "timeout" }
  | { status: "cancelled" }
  | { status: "error" }

export const LOOKUP_TIMEOUT_MS = 8_000

function isLogRow(value: unknown): value is BabyLogData {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === "string" && typeof v.logged_at === "string" && typeof v.log_type === "string"
}

export async function lookupBabyLogs(
  ids: string[],
  opts: { childId?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<LookupOutcome> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, opts.timeoutMs ?? LOOKUP_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener("abort", onAbort, { once: true })
  }
  try {
    const query = (opts.childId ? `child=${encodeURIComponent(opts.childId)}&` : "") + ids.map((id) => `id=${encodeURIComponent(id)}`).join("&")
    const res = await fetch(`/api/baby-logs/lookup?${query}`, {
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    })
    if (res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400)) {
      return { status: "auth" }
    }
    if (res.status === 401) return { status: "auth" }
    if (!res.ok) return { status: "error" }
    if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
      return { status: "error" }
    }
    const body: unknown = await res.json()
    const logs = (body as { logs?: unknown } | null)?.logs
    if (!Array.isArray(logs) || !logs.every(isLogRow)) return { status: "error" }
    const wanted = new Set(ids)
    const matched = logs.filter((l) => wanted.has(l.id))
    return matched.length > 0 ? { status: "found", logs: matched } : { status: "notFound" }
  } catch (err) {
    if (controller.signal.aborted) return { status: timedOut ? "timeout" : "cancelled" }
    console.warn("[baby-log-lookup] 照合の取得に失敗", {
      message: err instanceof Error ? err.message : String(err),
    })
    return { status: "error" }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", onAbort)
  }
}
