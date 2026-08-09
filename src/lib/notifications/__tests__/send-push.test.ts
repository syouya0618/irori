/**
 * 送信の境界（B-3）。**「何を恒久的失敗と見なすか」だけを固定する。**
 *
 * ここを誤ると被害が非対称じゃ: 恒久扱いを広く取れば購読が消し飛び（復旧には
 * 主が各端末で再登録するしかない）、狭く取れば死んだ購読が残るだけで済む。
 * ゆえに `gone` は 404 / 410 の **allowlist** に限る
 * （CLAUDE.md「再試行は広く、破棄は狭く」）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const sendNotification = vi.fn()

class FakeWebPushError extends Error {
  statusCode: number
  endpoint: string
  constructor(message: string, statusCode: number, endpoint: string) {
    super(message)
    this.statusCode = statusCode
    this.endpoint = endpoint
  }
}

vi.mock("web-push", () => ({
  default: { sendNotification: (...args: unknown[]) => sendNotification(...args) },
  WebPushError: FakeWebPushError,
}))

const { sendPushNotification, readVapidConfig, PUSH_GONE_STATUSES } =
  await import("../send-push")

const TARGET = {
  endpoint: "https://fcm.googleapis.com/secret-token",
  p256dh: "k",
  auth: "a",
}
const VAPID = { publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" }

beforeEach(() => {
  sendNotification.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("sendPushNotification", () => {
  it("成功したら ok", async () => {
    sendNotification.mockResolvedValueOnce({ statusCode: 201 })
    await expect(sendPushNotification(TARGET, VAPID, { title: "t" })).resolves.toEqual(
      { ok: true },
    )
  })

  it("VAPID は**呼び出しごとに渡す**（global を書き換えて並行実行で競合させぬ）", async () => {
    sendNotification.mockResolvedValueOnce({ statusCode: 201 })
    await sendPushNotification(TARGET, VAPID, { title: "t" })
    const options = sendNotification.mock.calls[0][2] as {
      vapidDetails: unknown
      timeout: number
      TTL: number
    }
    expect(options.vapidDetails).toEqual(VAPID)
    // 外部 API 呼び出しにタイムアウトは必須（CLAUDE.md）。
    expect(options.timeout).toBeGreaterThan(0)
    expect(options.TTL).toBeGreaterThan(0)
  })

  it.each([404, 410])("%i は gone（購読を消してよい合図）", async (status) => {
    sendNotification.mockRejectedValueOnce(
      new FakeWebPushError("gone", status, TARGET.endpoint),
    )
    await expect(
      sendPushNotification(TARGET, VAPID, { title: "t" }),
    ).resolves.toMatchObject({ ok: false, gone: true, status })
  })

  it.each([400, 401, 403, 429, 500, 503])(
    "%i は gone ではない（再試行側へ倒す）",
    async (status) => {
      sendNotification.mockRejectedValueOnce(
        new FakeWebPushError("nope", status, TARGET.endpoint),
      )
      await expect(
        sendPushNotification(TARGET, VAPID, { title: "t" }),
      ).resolves.toMatchObject({ ok: false, gone: false, status })
    },
  )

  /**
   * ★ **集合そのものを固定する（B-4）。**
   *
   * 上の 2 つは「見本」じゃ。見本だけでは `>= 400 && < 500` への書き換え
   * （＝ 4xx 一括の blocklist）を**捕まえられぬ** — 404/410 は依然 gone ゆえ
   * 前者は緑、401/403/429 を列挙しておらねば後者も緑になる。
   * ゆえに **100..599 を総なめして「gone になった status の集合」を作り、
   * それが `{404, 410}` と完全一致すること**を assert する。
   * blocklist へ戻した瞬間、集合が 100 個ぶん膨れて必ず赤になる。
   */
  it("**gone になる status の集合は {404, 410} ちょうど**（100..599 を総なめ）", async () => {
    const gone: number[] = []
    for (let status = 100; status <= 599; status++) {
      sendNotification.mockRejectedValueOnce(
        new FakeWebPushError("swept", status, TARGET.endpoint),
      )
      const result = await sendPushNotification(TARGET, VAPID, { title: "t" })
      if (result.ok === false && result.gone) gone.push(status)
    }
    expect(gone).toEqual([404, 410])
  })

  it("公開されておる allowlist 定数も同じ集合じゃ（実装と宣言の食い違いを殺す）", () => {
    expect([...PUSH_GONE_STATUSES].sort((a, b) => a - b)).toEqual([404, 410])
  })

  it("通信断（WebPushError でない例外）も gone ではない", async () => {
    sendNotification.mockRejectedValueOnce(new Error("ETIMEDOUT"))
    await expect(
      sendPushNotification(TARGET, VAPID, { title: "t" }),
    ).resolves.toMatchObject({ ok: false, gone: false, status: null })
  })

  it("**返り値に endpoint を含めぬ**（呼び出し側が素直にログへ出しても漏れぬように）", async () => {
    sendNotification.mockRejectedValueOnce(
      new FakeWebPushError("boom", 500, TARGET.endpoint),
    )
    const result = await sendPushNotification(TARGET, VAPID, { title: "t" })
    expect(JSON.stringify(result)).not.toContain("secret-token")
  })
})

describe("readVapidConfig", () => {
  it("3 つ揃えば読める（末尾改行は trim する）", () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "pub\n")
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv")
    vi.stubEnv("VAPID_SUBJECT", "mailto:a@b.c")
    expect(readVapidConfig()).toEqual({
      publicKey: "pub",
      privateKey: "priv",
      subject: "mailto:a@b.c",
    })
  })

  it("1 つでも欠ければ null（fail-closed）", () => {
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "pub")
    vi.stubEnv("VAPID_PRIVATE_KEY", "")
    vi.stubEnv("VAPID_SUBJECT", "mailto:a@b.c")
    expect(readVapidConfig()).toBeNull()
  })
})
