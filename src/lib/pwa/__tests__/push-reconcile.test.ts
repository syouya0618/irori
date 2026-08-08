/**
 * 起動時の突き合わせ（B-4）。
 *
 * ここで縛るのは 4 つじゃ:
 *   1. **購読を作らぬ・消さぬ**（不可逆な操作は主の操作からのみ）
 *   2. **受理された時だけ印を付ける**（失敗で印を付けると直す機会を自ら捨てる）
 *   3. **`res.ok` を成功と読まぬ**（proxy の 307 → HTML 200 が罠じゃ）
 *   4. **印は利用者で区切る**（共用端末で持ち主が代われば必ずもう一度走る）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  PUSH_RECONCILE_MARKER_KEY,
  PUSH_RESUBSCRIBE_PATH,
  buildReconcileMarker,
  isResubscribeAccepted,
  reconcilePushSubscription,
  type PushReconcileDeps,
  type PushSubscriptionJsonLike,
  type ResubscribeRequestBody,
} from "../push-reconcile"

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/token-1"
const UA = "Mozilla/5.0 (Macintosh) Chrome/140.0"
const USER_A = "11111111-1111-4111-8111-111111111111"
const USER_B = "22222222-2222-4222-8222-222222222222"

const SUBSCRIPTION: PushSubscriptionJsonLike = {
  endpoint: ENDPOINT,
  keys: { p256dh: "k", auth: "a" },
}

function setup(
  options: {
    subscription?: PushSubscriptionJsonLike | null
    accepted?: boolean
    marker?: string | null
    userId?: string
  } = {},
) {
  const registered: ResubscribeRequestBody[] = []
  let marker = options.marker ?? null
  const deps: PushReconcileDeps = {
    getSubscriptionJson: async () =>
      options.subscription === undefined ? SUBSCRIPTION : options.subscription,
    register: async (body) => {
      registered.push(body)
      return options.accepted ?? true
    },
    readMarker: () => marker,
    writeMarker: (value) => {
      marker = value
    },
    userId: options.userId ?? USER_A,
    userAgent: UA,
  }
  return { deps, registered, getMarker: () => marker }
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("reconcilePushSubscription", () => {
  it("ブラウザの購読をそのまま登録し直す（冪等な upsert 経由）", async () => {
    const { deps, registered, getMarker } = setup()
    await expect(reconcilePushSubscription(deps)).resolves.toBe("registered")

    expect(registered).toEqual([
      { endpoint: ENDPOINT, p256dh: "k", auth: "a", userAgent: UA },
    ])
    expect(getMarker()).toBe(buildReconcileMarker(USER_A, ENDPOINT))
  })

  it("購読が無ければ**何もせぬ**（subscribe せぬ = 権限要求を起こさぬ）", async () => {
    const { deps, registered } = setup({ subscription: null })
    await expect(reconcilePushSubscription(deps)).resolves.toBe("no-subscription")
    expect(registered).toEqual([])
  })

  it("同じ利用者・同じ endpoint で印が在れば退く（failure_count を毎回畳まぬため）", async () => {
    const { deps, registered } = setup({ marker: buildReconcileMarker(USER_A, ENDPOINT) })
    await expect(reconcilePushSubscription(deps)).resolves.toBe("already-reconciled")
    expect(registered).toEqual([])
  })

  it("印が**別の** endpoint なら走る（購読が回った直後を拾う）", async () => {
    const { deps, registered } = setup({
      marker: buildReconcileMarker(USER_A, "https://fcm.googleapis.com/old"),
    })
    await expect(reconcilePushSubscription(deps)).resolves.toBe("registered")
    expect(registered).toHaveLength(1)
  })

  // ── 共用端末の持ち主交代（SEC-2）─────────────────────────────
  // sessionStorage は同じタブ内の遷移（セッション切れ → /login → 再ログイン）で
  // **保持される**。印が endpoint だけなら、別人がログインしても
  // `already-reconciled` で退き、DB 行の user_id は前の利用者のまま残る。
  // ＝ 前の利用者の世帯の通知が、今の利用者の端末へ届き続ける。
  it("**別人がログインしたら必ず走る**（印が前の利用者のものでも退かぬ）", async () => {
    const { deps, registered, getMarker } = setup({
      marker: buildReconcileMarker(USER_A, ENDPOINT),
      userId: USER_B,
    })
    await expect(reconcilePushSubscription(deps)).resolves.toBe("registered")
    // upsert_push_subscription が endpoint の持ち主を B へ付け替える。
    expect(registered).toHaveLength(1)
    expect(getMarker()).toBe(buildReconcileMarker(USER_B, ENDPOINT))
  })

  it("印は endpoint 単体では成立せぬ（利用者を落とした実装は退けぬ）", async () => {
    const { deps, registered } = setup({ marker: ENDPOINT })
    await expect(reconcilePushSubscription(deps)).resolves.toBe("registered")
    expect(registered).toHaveLength(1)
  })

  it("鍵が欠けた購読は送らぬ（DB の CHECK で落ちるだけゆえ）", async () => {
    const { deps, registered } = setup({
      subscription: { endpoint: ENDPOINT, keys: { p256dh: "k", auth: null } },
    })
    await expect(reconcilePushSubscription(deps)).resolves.toBe("incomplete")
    expect(registered).toEqual([])
  })

  it("**受理されねば印を付けぬ**（次のハードロードで必ずやり直せる）", async () => {
    const { deps, getMarker } = setup({ accepted: false })
    await expect(reconcilePushSubscription(deps)).resolves.toBe("rejected")
    expect(getMarker()).toBeNull()
  })

  it("受理されなかった直後にもう一度呼べば、また登録を試みる", async () => {
    const { deps, registered } = setup({ accepted: false })
    await reconcilePushSubscription(deps)
    await reconcilePushSubscription(deps)
    expect(registered).toHaveLength(2)
  })
})

describe("isResubscribeAccepted — **`res.ok` を信じてはならぬ**", () => {
  const json = (body: unknown, status = 200) => ({
    status,
    headers: {
      get: (n: string) => (n === "content-type" ? "application/json" : null),
    },
    json: async () => body,
  })

  it("JSON の { ok: true } のみ受理", async () => {
    await expect(isResubscribeAccepted(json({ ok: true }))).resolves.toBe(true)
  })

  it("proxy の承認ゲートが返す **HTML の 200** は受理せぬ", async () => {
    await expect(
      isResubscribeAccepted({
        status: 200,
        headers: {
          get: (n: string) => (n === "content-type" ? "text/html; charset=utf-8" : null),
        },
        json: async () => {
          throw new Error("not json")
        },
      }),
    ).resolves.toBe(false)
  })

  it("redirect: manual の opaqueredirect（status 0）も受理せぬ", async () => {
    await expect(
      isResubscribeAccepted({
        status: 0,
        headers: { get: () => null },
        json: async () => {
          throw new Error("opaque")
        },
      }),
    ).resolves.toBe(false)
  })

  it("401 / 500 は受理せぬ", async () => {
    await expect(isResubscribeAccepted(json({ ok: true }, 401))).resolves.toBe(false)
    await expect(isResubscribeAccepted(json({ ok: true }, 500))).resolves.toBe(false)
  })

  it("{ ok: false } も null も受理せぬ", async () => {
    await expect(isResubscribeAccepted(json({ ok: false }))).resolves.toBe(false)
    await expect(isResubscribeAccepted(null)).resolves.toBe(false)
  })
})

describe("定数", () => {
  it("パスは Route Handler / sw.js と一致する", () => {
    expect(PUSH_RESUBSCRIBE_PATH).toBe("/api/push/resubscribe")
  })

  it("印のキーは endpoint を持つ（購読が回れば値が変わる設計）", () => {
    expect(PUSH_RECONCILE_MARKER_KEY).toBe("irori.push.reconciled-endpoint")
  })

  it("印の値は 利用者 と endpoint の両方を含む（分解せず丸ごと比較する）", () => {
    const marker = buildReconcileMarker(USER_A, ENDPOINT)
    expect(marker).toContain(USER_A)
    expect(marker).toContain(ENDPOINT)
    // 利用者が違えば別の値になること（＝ 突き合わせが必ず走ること）。
    expect(marker).not.toBe(buildReconcileMarker(USER_B, ENDPOINT))
  })
})
