/**
 * 起動時の突き合わせ（B-4）の**配線**を縛る。
 *
 * 純ロジック（`reconcilePushSubscription`）は注入版で既に検査しておる。
 * ここで見るのは、その注入版へ**何を渡しておるか** —— つまり本番でしか壊れぬ側じゃ:
 *
 *   1. `navigator.serviceWorker.getRegistration()` を使う（`ready` ではない）。
 *      `ready` は SW が 1 つも登録されておらぬ環境（`next dev` は
 *      `ServiceWorkerManager` が unregister する）で**永久に解決せぬ**。
 *      `ready` へ戻す事故はここでしか止まらぬ。
 *   2. `fetch` に `redirect: "manual"` が渡っておる。無ければ承認ゲートの 307 を
 *      追って **HTML の 200** を掴み、`isResubscribeAccepted` は飾りになる。
 *   3. 印は sessionStorage へ **`${userId}:${endpoint}`** の形で書く（利用者交代で
 *      必ずもう一度走る）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import { PushSubscriptionReconciler } from "../push-subscription-reconciler"
import {
  PUSH_RECONCILE_MARKER_KEY,
  buildReconcileMarker,
} from "@/lib/pwa/push-reconcile"

const USER_ID = "11111111-1111-4111-8111-111111111111"
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/token-1"

interface FetchCall {
  url: string
  init: RequestInit
}

function stubBrowser(options: {
  registration?: unknown
  subscriptionJson?: unknown
}) {
  const calls: FetchCall[] = []
  const fetchMock = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve({
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    })
  })
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("PushManager", class {})
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh) Chrome/140.0",
    serviceWorker: {
      getRegistration: () =>
        Promise.resolve(
          "registration" in options
            ? options.registration
            : {
                pushManager: {
                  getSubscription: () =>
                    Promise.resolve(
                      options.subscriptionJson
                        ? { toJSON: () => options.subscriptionJson }
                        : null,
                    ),
                },
              },
        ),
      // ⚠️ **永久に解決せぬ** promise を返す。`ready` へ戻した実装は、この
      // スタブの下で「fetch が来ぬ」形で赤くなる（`ready` は SW 未登録の環境で
      // 解決せぬという実挙動そのものじゃ）。
      ready: new Promise<never>(() => {}),
    },
  })
  return { calls }
}

beforeEach(() => {
  sessionStorage.clear()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe("PushSubscriptionReconciler の配線", () => {
  it("購読が在れば再登録を叩き、印を 利用者:endpoint で残す", async () => {
    const { calls } = stubBrowser({
      subscriptionJson: { endpoint: ENDPOINT, keys: { p256dh: "k", auth: "a" } },
    })

    render(<PushSubscriptionReconciler userId={USER_ID} />)

    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].url).toBe("/api/push/resubscribe")
    expect(calls[0].init.method).toBe("POST")
    // 承認ゲートの 307 を追わせぬ。追えば HTML の 200 を成功と誤読する。
    expect(calls[0].init.redirect).toBe("manual")
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      endpoint: ENDPOINT,
      p256dh: "k",
      auth: "a",
    })
    await waitFor(() =>
      expect(sessionStorage.getItem(PUSH_RECONCILE_MARKER_KEY)).toBe(
        buildReconcileMarker(USER_ID, ENDPOINT),
      ),
    )
  })

  it("SW が未登録（getRegistration が undefined）なら何もせぬ", async () => {
    const { calls } = stubBrowser({ registration: undefined })

    render(<PushSubscriptionReconciler userId={USER_ID} />)

    // 「起きぬこと」の assert ゆえ、待たずに見ると常に通る。1 tick 回してから見る。
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([])
    expect(sessionStorage.getItem(PUSH_RECONCILE_MARKER_KEY)).toBeNull()
  })

  it("同じ利用者・同じ endpoint の印が在れば叩かぬ（failure_count を畳まぬ）", async () => {
    sessionStorage.setItem(
      PUSH_RECONCILE_MARKER_KEY,
      buildReconcileMarker(USER_ID, ENDPOINT),
    )
    const { calls } = stubBrowser({
      subscriptionJson: { endpoint: ENDPOINT, keys: { p256dh: "k", auth: "a" } },
    })

    render(<PushSubscriptionReconciler userId={USER_ID} />)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([])
  })
})
