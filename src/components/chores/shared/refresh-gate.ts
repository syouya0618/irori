/**
 * 家事の画面が `router.refresh()` を呼んでよいかの門（ブラウザ専用の純粋な部品。React を持たぬ）。
 *
 * ## なぜ要るか
 * Next 16 の `router.refresh()` は、RSC の取得が reject する・5xx を返すと SPA の更新を諦めて
 * **同じ URL へのハードナビゲーション**へ倒す（`node_modules/next/dist/client/components/
 * router-reducer/fetch-server-response.js` の "Falling back to browser navigation"。
 * `experimental.useOffline` は next.config.ts が意図して入れておらぬ）。`/chores/*` は Service Worker
 * の保存対象外ゆえ、圏外ではそのまま `/offline` に置き換わり、画面と未保存の入力が消える。
 * ゆえに家事の画面は `router.refresh()` を直に呼ばず、`useChoresRefresh` 経由でここを通す。
 *
 * ## 門の順序
 * 1. 端末が圏外（`navigator.onLine === false`）なら呼ばぬ
 * 2. 自動の再取得（復帰時・定期）は、保存の送信中・端末に残せておらぬ控えが在る間・入力の途中・
 *    シートが開いている間は見送る（`automaticRefreshHold`）。利用者が押した更新は止めぬ
 * 3. サーバーへ届くことを直近（`REACHABLE_FRESH_MS`）に確かめておらねば、軽い GET
 *    （`/api/version`。Service Worker は `/api/` に関与せぬ）で先に確かめる。届かねば呼ばぬ
 *
 * 確かめた直後に回線が落ちる競合は残る（門は確率を下げるだけ）。その時に失うものを減らすのが 2。
 */

/** サーバーへ届いたと見なす証拠の鮮度（ms）。この間は確かめ直さずに `router.refresh()` を呼ぶ。 */
export const REACHABLE_FRESH_MS = 5_000
/** 確かめの GET の期限（ms）。応答の無い回線を待ち続けぬ。 */
export const REFRESH_PROBE_TIMEOUT_MS = 4_000
export const REFRESH_PROBE_URL = "/api/version"

// ── サーバーへ届いた証拠 ───────────────────────────────────────────

let lastReachableAt: number | null = null

/**
 * サーバーから応答を受けた（画面の mount = RSC が届いた・Server Action が分類つきの応答を返した・
 * 確かめの GET が通った）ことを記録する。
 */
export function noteServerReachable(nowMs: number = Date.now()): void {
  lastReachableAt = nowMs
}

/** 直近にサーバーへ届いておるか。時計が巻き戻っておれば（負の経過）届いておらぬ扱い。 */
export function isServerReachabilityFresh(nowMs: number = Date.now()): boolean {
  if (lastReachableAt === null) return false
  const elapsed = nowMs - lastReachableAt
  return elapsed >= 0 && elapsed < REACHABLE_FRESH_MS
}

/** 端末が圏外と申告しておるか（true は確実に圏外。false は「届く」ことを意味せぬ）。 */
export function isDeviceOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}

/**
 * サーバーへ届くかを軽い GET で確かめる。**throw せぬ**（届かぬ・期限切れ・中断・5xx は false）。
 * 未ログインの 307（承認ゲート）は「届いた」に数える — その後の `router.refresh()` が /login へ
 * 正しく送る。redirect を追わぬのは、/login の HTML を 200 として読まぬため。
 */
export async function probeServer(signal?: AbortSignal): Promise<boolean> {
  // `AbortSignal.any` / `timeout` は古い iOS に無い。無い端末で「常に届かぬ」へ倒れぬよう手で組む
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, REFRESH_PROBE_TIMEOUT_MS)
  signal?.addEventListener("abort", abort, { once: true })
  try {
    if (signal?.aborted) return false
    const res = await fetch(REFRESH_PROBE_URL, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "manual",
      signal: controller.signal,
    })
    return res.ok || res.type === "opaqueredirect"
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

// ── 保存の送信中・端末に残せておらぬ控え ─────────────────────────────

const busySaves = new Set<object>()

/**
 * `useChoreSave` が「今ハードナビゲーションが起きると失うものが在る」間だけ立てる旗
 * （送信中 = 応答を失う。端末に残せておらぬ控え = 控えごと失う）。`token` は hook の実体ごと。
 */
export function setChoreSaveBusy(token: object, busy: boolean): void {
  if (busy) busySaves.add(token)
  else busySaves.delete(token)
}

// ── 入力の途中 ─────────────────────────────────────────────────────

const touched = new Set<Element>()
let watchers = 0

function onInput(event: Event): void {
  if (event.target instanceof Element) touched.add(event.target)
}

/**
 * 利用者が触れた入力欄を覚える（document の `input` を聞く。重ねて呼んでもリスナは 1 本）。
 * 戻り値で解除する。
 */
export function watchUnsavedInput(): () => void {
  if (typeof document === "undefined") return () => {}
  if (watchers === 0) document.addEventListener("input", onInput, true)
  watchers += 1
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    watchers -= 1
    if (watchers === 0) {
      document.removeEventListener("input", onInput, true)
      touched.clear()
    }
  }
}

/** 保存が確定した（入力は Server に在る）。触れた欄の記憶を捨てる。 */
export function clearUnsavedInput(): void {
  touched.clear()
}

function holdsValue(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    // 文字の欄は空なら入力なし。チェック・ラジオ等は触れた時点で入力あり
    const textLike = !["checkbox", "radio", "range", "color", "file", "button", "submit", "reset"].includes(element.type)
    return textLike ? element.value !== "" : true
  }
  if (element instanceof HTMLTextAreaElement) return element.value !== ""
  return true
}

/** 触れたまま画面に残っておる入力欄が在るか（閉じて消えた欄・空に戻した欄は数えぬ）。 */
export function hasUnsavedInput(): boolean {
  for (const element of touched) {
    if (!element.isConnected) {
      touched.delete(element)
      continue
    }
    if (holdsValue(element)) return true
  }
  return false
}

/** シート・ダイアログが開いておるか（中の入力は React の state にしか無い）。 */
export function hasOpenDialog(): boolean {
  if (typeof document === "undefined") return false
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
}

export type RefreshHold = "saving" | "editing"

/**
 * 自動の再取得を見送る理由（無ければ null）。利用者が押した更新には使わぬ。
 * 結果不明の控えが端末に残せておる間は見送らぬ — 再取得した画面の内容が「保存されたか」を
 * 確かめる手がかりになり、ハードナビゲーションが起きても控えは端末に残る。
 */
export function automaticRefreshHold(): RefreshHold | null {
  if (busySaves.size > 0) return "saving"
  if (hasOpenDialog() || hasUnsavedInput()) return "editing"
  return null
}

/** テスト用: module の状態を初期化する。 */
export function resetRefreshGateForTest(): void {
  lastReachableAt = null
  busySaves.clear()
  touched.clear()
}
