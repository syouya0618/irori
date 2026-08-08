import { describe, expect, it, vi, afterEach } from "vitest"
import { unsubscribePushForSignOut } from "../push-unsubscribe"

/**
 * サインアウト時の購読解除。**順序（サーバ → ブラウザ）が load-bearing** ゆえ、
 * 「両方呼ばれた」ではなく「どちらが先か」を固定する。逆順にすると endpoint を
 * 失った後にサーバへ渡す値が無くなり、DB に旧ユーザーの行が残り続ける。
 */

const originalNavigator = globalThis.navigator
const originalPushManager = (globalThis as { PushManager?: unknown }).PushManager

function stubBrowser(options: {
  registration?: {
    pushManager: { getSubscription: () => Promise<unknown> }
  } | null
}) {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      serviceWorker: {
        getRegistration: () => Promise.resolve(options.registration ?? null),
      },
    },
    configurable: true,
    writable: true,
  })
  ;(globalThis as { PushManager?: unknown }).PushManager = class {}
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    configurable: true,
    writable: true,
  })
  ;(globalThis as { PushManager?: unknown }).PushManager = originalPushManager
  vi.restoreAllMocks()
})

describe("unsubscribePushForSignOut", () => {
  it("サーバの解除を先に、ブラウザの unsubscribe を後に呼ぶ（順序を固定）", async () => {
    const order: string[] = []
    const unsubscribe = vi.fn(async () => {
      order.push("browser")
      return true
    })
    stubBrowser({
      registration: {
        pushManager: {
          getSubscription: async () => ({
            endpoint: "https://fcm.googleapis.com/fcm/send/abc",
            unsubscribe,
          }),
        },
      },
    })

    const onServer = vi.fn(async (endpoint: string) => {
      order.push(`server:${endpoint}`)
    })

    await unsubscribePushForSignOut(onServer)

    expect(order).toEqual([
      "server:https://fcm.googleapis.com/fcm/send/abc",
      "browser",
    ])
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("購読が無ければサーバも呼ばぬ（無駄な往復をせぬ）", async () => {
    stubBrowser({
      registration: { pushManager: { getSubscription: async () => null } },
    })
    const onServer = vi.fn()
    await unsubscribePushForSignOut(onServer)
    expect(onServer).not.toHaveBeenCalled()
  })

  it("Service Worker が未登録でも落ちぬ", async () => {
    stubBrowser({ registration: null })
    const onServer = vi.fn()
    await expect(unsubscribePushForSignOut(onServer)).resolves.toBeUndefined()
    expect(onServer).not.toHaveBeenCalled()
  })

  it("Push 非対応の端末では何もせぬ（iOS の Safari タブ等）", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    })
    delete (globalThis as { PushManager?: unknown }).PushManager
    const onServer = vi.fn()
    await expect(unsubscribePushForSignOut(onServer)).resolves.toBeUndefined()
    expect(onServer).not.toHaveBeenCalled()
  })

  it("サーバ側が失敗してもサインアウトを止めぬ（例外を漏らさぬ）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const unsubscribe = vi.fn(async () => true)
    stubBrowser({
      registration: {
        pushManager: {
          getSubscription: async () => ({
            endpoint: "https://fcm.googleapis.com/fcm/send/abc",
            unsubscribe,
          }),
        },
      },
    })

    const onServer = vi.fn(async () => {
      throw new Error("offline")
    })

    await expect(unsubscribePushForSignOut(onServer)).resolves.toBeUndefined()
    // 握り潰しではなく理由は残す（CLAUDE.md: catch 内でログ必須）
    expect(warn).toHaveBeenCalled()
  })

  it("ブラウザ側の unsubscribe が失敗してもサインアウトを止めぬ", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    stubBrowser({
      registration: {
        pushManager: {
          getSubscription: async () => ({
            endpoint: "https://fcm.googleapis.com/fcm/send/abc",
            unsubscribe: async () => {
              throw new Error("boom")
            },
          }),
        },
      },
    })
    const onServer = vi.fn(async () => {})
    await expect(unsubscribePushForSignOut(onServer)).resolves.toBeUndefined()
    // サーバ側は先に済んでおる（順序の副次的な確認）
    expect(onServer).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })
})
