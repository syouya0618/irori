/**
 * 世帯キャッシュの破棄（P2-24）。
 *
 * ## 固定する契約
 * `purgeHouseholdCaches()` は**破棄を確かめられた時だけ true** を返し、決して reject せぬ。
 * 呼び出し側（ログアウト・CacheUserGuard）は true の時だけ LAST_USER_ID を消す／書き換える。
 * かつては controller 無し・ack の中身・タイムアウトのいずれでも無言で resolve しておったため、
 * 破棄が走らなんだのに鍵だけが消え、次の利用者の CacheUserGuard まで黙らせておった。
 *
 * ## 二経路
 * 1. ページから Cache API を直に叩く（CacheStorage は SW と同じ origin の保存領域）
 * 2. SW へ PURGE を送り、`{ ok: true }` の ack を待つ（補助）
 * どちらかが確かめられれば true。両方とも確かめられねば false。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  purgeHouseholdCaches,
  isHouseholdCacheName,
  SW_MESSAGE_PURGE_HOUSEHOLD_CACHES,
} from "../sw-messages"

/** 同期的に相手へ届ける最小の MessageChannel（実物は配達が非決定的ゆえ） */
class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  other: FakePort | null = null
  closed = false
  postMessage(data: unknown) {
    const target = this.other
    queueMicrotask(() => target?.onmessage?.({ data }))
  }
  close() {
    this.closed = true
  }
}
class FakeChannel {
  port1 = new FakePort()
  port2 = new FakePort()
  constructor() {
    this.port1.other = this.port2
    this.port2.other = this.port1
  }
}

/** caches.keys() が names を返し、delete を記録する CacheStorage */
function makeCaches(
  names: string[],
  opts: { deleteRejects?: boolean; keysRejects?: boolean } = {},
) {
  const deleted: string[] = []
  return {
    caches: {
      keys: vi.fn(() =>
        opts.keysRejects
          ? Promise.reject(new Error("SecurityError"))
          : Promise.resolve(names),
      ),
      delete: vi.fn((name: string) => {
        if (opts.deleteRejects) return Promise.reject(new Error("quota"))
        deleted.push(name)
        return Promise.resolve(true)
      }),
    },
    deleted,
  }
}

/** SW controller を立てる。reply が undefined なら ack を返さぬ（固まった SW） */
function stubController(reply?: unknown) {
  const posted: unknown[] = []
  const controller = {
    postMessage: vi.fn((message: unknown, transfer: FakePort[]) => {
      posted.push(message)
      if (reply !== undefined) transfer[0].postMessage(reply)
    }),
  }
  vi.stubGlobal("navigator", { serviceWorker: { controller } })
  return { controller, posted }
}

function stubNoController() {
  vi.stubGlobal("navigator", { serviceWorker: { controller: null } })
}

const ALL_NAMES = [
  "irori-v1-precache",
  "irori-v1-documents",
  "irori-v1-rsc",
  "irori-v1-static",
  "irori-v1-images",
  "someone-elses-cache",
]

beforeEach(() => {
  vi.stubGlobal("MessageChannel", FakeChannel)
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("isHouseholdCacheName（sw.js の CACHE_NAMES と同じ形）", () => {
  it("documents / rsc だけを世帯データとみなす（版は問わぬ）", () => {
    expect(isHouseholdCacheName("irori-v1-documents")).toBe(true)
    expect(isHouseholdCacheName("irori-v1-rsc")).toBe(true)
    expect(isHouseholdCacheName("irori-v2-documents")).toBe(true)
  })

  it("個人データを持たぬキャッシュと他アプリのキャッシュには触れぬ（対照）", () => {
    for (const name of [
      "irori-v1-precache",
      "irori-v1-static",
      "irori-v1-images",
      "someone-elses-cache",
      "other-v1-documents",
      "irori-v1-documents-extra",
    ]) {
      expect(isHouseholdCacheName(name), name).toBe(false)
    }
  })
})

describe("purgeHouseholdCaches — ページから直に破棄する", () => {
  it("SW が未制御でも window の caches から documents / rsc を消し、true を返す", async () => {
    stubNoController()
    const { caches, deleted } = makeCaches(ALL_NAMES)
    vi.stubGlobal("caches", caches)

    await expect(purgeHouseholdCaches()).resolves.toBe(true)
    expect(deleted.sort()).toEqual(["irori-v1-documents", "irori-v1-rsc"])
  })

  it("Cache API が投げ、SW も居らぬなら false（確かめられぬ）", async () => {
    stubNoController()
    vi.stubGlobal("caches", makeCaches(ALL_NAMES, { deleteRejects: true }).caches)

    await expect(purgeHouseholdCaches()).resolves.toBe(false)
  })

  it("caches.keys() が投げても reject せず false", async () => {
    stubNoController()
    vi.stubGlobal("caches", makeCaches(ALL_NAMES, { keysRejects: true }).caches)

    await expect(purgeHouseholdCaches()).resolves.toBe(false)
  })

  it("Cache API も SW も無い環境は false（「消した」と偽らぬ）", async () => {
    vi.stubGlobal("navigator", {})
    vi.stubGlobal("caches", undefined)

    await expect(purgeHouseholdCaches()).resolves.toBe(false)
  })
})

describe("purgeHouseholdCaches — SW の ack（補助経路）", () => {
  it("ページ側が失敗しても SW が { ok: true } を返せば true", async () => {
    const { posted } = stubController({ ok: true })
    vi.stubGlobal("caches", makeCaches(ALL_NAMES, { deleteRejects: true }).caches)

    await expect(purgeHouseholdCaches()).resolves.toBe(true)
    expect(posted).toEqual([{ type: SW_MESSAGE_PURGE_HOUSEHOLD_CACHES }])
  })

  it("SW の ack が { ok: false } なら確認とみなさぬ（中身を読む）", async () => {
    stubController({ ok: false })
    vi.stubGlobal("caches", undefined)

    await expect(purgeHouseholdCaches()).resolves.toBe(false)
  })

  it("SW が ack を返さねばタイムアウトで false（ログアウトを止めぬ）", async () => {
    vi.useFakeTimers()
    stubController(undefined)
    vi.stubGlobal("caches", undefined)

    const result = purgeHouseholdCaches()
    await vi.advanceTimersByTimeAsync(1500)
    await expect(result).resolves.toBe(false)
  })

  it("postMessage が投げても reject せず false", async () => {
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: {
          postMessage: () => {
            throw new Error("DataCloneError")
          },
        },
      },
    })
    vi.stubGlobal("caches", undefined)

    await expect(purgeHouseholdCaches()).resolves.toBe(false)
  })
})
