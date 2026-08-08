import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"

/**
 * public/sw.js の純粋関数 (self.__TEST_HOOKS__) を node:vm で実行して検証する。
 *
 * NOTE: Node では new Request(url, { mode: "navigate" }) が TypeError になるため、
 * request は duck-type ({ url, method, mode, headers.get() }) で渡す。
 */

const SW_PATH = resolve(__dirname, "../../../../public/sw.js")
const ORIGIN = "http://127.0.0.1:3000/"

interface DuckRequest {
  url: string
  method: string
  mode: string
  headers: { get: (name: string) => string | null }
}

interface PushPayload {
  title: string
  body: string
  url?: string
  tag?: string
}

interface DuckPushEvent {
  data?: { json: () => unknown; text: () => string } | null
}

interface ResubscribeBody {
  endpoint: string
  p256dh: string
  auth: string
  oldEndpoint?: string
  userAgent?: string
}

interface DuckResponse {
  status: number
  headers: { get: (name: string) => string | null }
  json: () => Promise<unknown>
}

interface TestHooks {
  classifyRequest: (request: DuckRequest, originHref: string) => string | null
  makeCacheKey: (rawUrl: string) => string
  trimCache: (cacheName: string, max?: number) => Promise<void>
  extractAssetUrls: (html: string) => string[]
  parsePushPayload: (event: DuckPushEvent | null) => PushPayload
  // ⚠️ 実体は 3 引数（public/sw.js の `buildResubscribeBody(json, oldEndpoint,
  // userAgent)`）。ここを 2 引数のまま宣言すると、**UA を渡す呼び方が型で塞がれ**、
  // 「UA が body に載る」ことを誰も検査できなくなる。
  buildResubscribeBody: (
    json: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | null,
    oldEndpoint?: string | null,
    userAgent?: string | null,
  ) => ResubscribeBody | null
  isResubscribeAccepted: (res: DuckResponse | null) => Promise<boolean>
  handlePushSubscriptionChange: (event: unknown) => Promise<void>
  CACHE_NAMES: Record<string, string>
  APP_PAGES: string[]
  PRECACHE_URLS: string[]
  RESUBSCRIBE_PATH: string
}

/**
 * sw.js を評価し、`__TEST_HOOKS__` と **登録されたイベント名の一覧**を返す。
 *
 * ⚠️ `addEventListener` を no-op スタブにすると、**リスナ登録そのものを検証できぬ**。
 * `"push"` を `"pushnotification"` と綴り間違えても純粋関数のテストは全部緑のまま、
 * 本番では 1 通も届かぬ — CLAUDE.md の「規約ファイルは在るだけでは効いておらぬ」と
 * 同 family じゃ。ゆえに記録関数にして集合を assert できるようにする。
 */
function loadSwWithEvents(
  extraGlobals: Record<string, unknown> = {},
  selfOverrides: Record<string, unknown> = {},
): {
  hooks: TestHooks
  events: string[]
} {
  const code = readFileSync(SW_PATH, "utf8")
  const events: string[] = []
  const self: Record<string, unknown> = {
    addEventListener: (type: string) => {
      events.push(type)
    },
    location: { href: ORIGIN },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    registration: { showNotification: () => Promise.resolve() },
    ...selfOverrides,
  }
  const sandbox: Record<string, unknown> = {
    self,
    console,
    URL,
    Date,
    Response: class {},
    ...extraGlobals,
  }
  runInNewContext(code, sandbox)
  const hooks = self.__TEST_HOOKS__ as TestHooks | undefined
  if (!hooks) throw new Error("sw.js が self.__TEST_HOOKS__ を公開していません")
  return { hooks, events }
}

function loadSw(
  extraGlobals: Record<string, unknown> = {},
  selfOverrides: Record<string, unknown> = {},
): TestHooks {
  return loadSwWithEvents(extraGlobals, selfOverrides).hooks
}

function makeReq(
  url: string,
  opts: {
    method?: string
    mode?: string
    headers?: Record<string, string>
  } = {}
): DuckRequest {
  const headers = opts.headers ?? {}
  return {
    url,
    method: opts.method ?? "GET",
    mode: opts.mode ?? "no-cors",
    headers: { get: (name: string) => headers[name] ?? null },
  }
}

const abs = (path: string) => new URL(path, ORIGIN).href

describe("sw.js __TEST_HOOKS__", () => {
  const hooks = loadSw()

  it("APP_PAGES / PRECACHE_URLS / CACHE_NAMES が期待値で公開されている", () => {
    expect(hooks.APP_PAGES).toEqual([
      "/meals",
      "/shopping",
      "/stock",
      "/baby",
      "/calendar",
      "/settings",
    ])
    expect(hooks.PRECACHE_URLS).toContain("/offline")
    expect(hooks.CACHE_NAMES.precache).toBe("irori-v1-precache")
    expect(hooks.CACHE_NAMES.documents).toBe("irori-v1-documents")
    expect(hooks.CACHE_NAMES.rsc).toBe("irori-v1-rsc")
  })

  describe("classifyRequest", () => {
    it("別オリジン (Supabase) は null (構造的に不可侵)", () => {
      const req = makeReq("http://127.0.0.1:54321/rest/v1/meal_records?select=*", {
        mode: "cors",
      })
      expect(hooks.classifyRequest(req, ORIGIN)).toBeNull()
    })

    it("POST (Server Action) は null (素通し)", () => {
      const req = makeReq(abs("/meals"), { method: "POST", mode: "navigate" })
      expect(hooks.classifyRequest(req, ORIGIN)).toBeNull()
    })

    it("navigate × APP_PAGES → document", () => {
      for (const page of hooks.APP_PAGES) {
        const req = makeReq(abs(page), { mode: "navigate" })
        expect(hooks.classifyRequest(req, ORIGIN)).toBe("document")
      }
    })

    it("navigate × 末尾スラッシュ付き APP_PAGES → document (正規化)", () => {
      const req = makeReq(abs("/meals/"), { mode: "navigate" })
      expect(hooks.classifyRequest(req, ORIGIN)).toBe("document")
    })

    it("navigate × 認証系ページ → nav-passthrough (キャッシュ禁止)", () => {
      for (const path of ["/login", "/", "/invite/abc123", "/setup", "/pending-approval"]) {
        const req = makeReq(abs(path), { mode: "navigate" })
        expect(hooks.classifyRequest(req, ORIGIN)).toBe("nav-passthrough")
      }
    })

    it("navigate × /offline → precached", () => {
      const req = makeReq(abs("/offline"), { mode: "navigate" })
      expect(hooks.classifyRequest(req, ORIGIN)).toBe("precached")
    })

    it("RSC ヘッダー × APP_PAGES → rsc", () => {
      const req = makeReq(abs("/meals?_rsc=abc12"), {
        mode: "cors",
        headers: { RSC: "1" },
      })
      expect(hooks.classifyRequest(req, ORIGIN)).toBe("rsc")
    })

    it("?_rsc= クエリのみ (ヘッダーなし) でも APP_PAGES → rsc", () => {
      const req = makeReq(abs("/shopping?_rsc=xyz"), { mode: "cors" })
      expect(hooks.classifyRequest(req, ORIGIN)).toBe("rsc")
    })

    it("RSC × prefetch → null (部分 payload で汚染しない)", () => {
      const req = makeReq(abs("/meals?_rsc=abc12"), {
        mode: "cors",
        headers: { RSC: "1", "Next-Router-Prefetch": "1" },
      })
      expect(hooks.classifyRequest(req, ORIGIN)).toBeNull()
    })

    it("RSC × APP_PAGES 外 (/login) → null", () => {
      const req = makeReq(abs("/login?_rsc=abc12"), {
        mode: "cors",
        headers: { RSC: "1" },
      })
      expect(hooks.classifyRequest(req, ORIGIN)).toBeNull()
    })

    it("/_next/static/ → static", () => {
      const req = makeReq(abs("/_next/static/chunks/main-app-abc.js"))
      expect(hooks.classifyRequest(req, ORIGIN)).toBe("static")
    })

    it("/api/ への fetch → null", () => {
      const req = makeReq(abs("/api/baby-report"), { mode: "cors" })
      expect(hooks.classifyRequest(req, ORIGIN)).toBeNull()
    })

    it("/auth/ への fetch → null", () => {
      const req = makeReq(abs("/auth/callback?code=xyz"), { mode: "cors" })
      expect(hooks.classifyRequest(req, ORIGIN)).toBeNull()
    })

    it("画像 (拡張子 / _next/image / favicon.ico) → image", () => {
      expect(hooks.classifyRequest(makeReq(abs("/photos/meal.webp")), ORIGIN)).toBe("image")
      expect(
        hooks.classifyRequest(makeReq(abs("/_next/image?url=%2Ffoo.png&w=640&q=75")), ORIGIN)
      ).toBe("image")
      expect(hooks.classifyRequest(makeReq(abs("/favicon.ico")), ORIGIN)).toBe("image")
    })

    it("PRECACHE_URLS の fetch (manifest / アイコン) → precached", () => {
      expect(hooks.classifyRequest(makeReq(abs("/manifest.webmanifest")), ORIGIN)).toBe(
        "precached"
      )
      expect(hooks.classifyRequest(makeReq(abs("/icons/icon-192.png")), ORIGIN)).toBe(
        "precached"
      )
    })

    it("不正 URL は null (例外を投げない)", () => {
      const req = makeReq("not a url")
      expect(hooks.classifyRequest(req, ORIGIN)).toBeNull()
    })
  })

  describe("makeCacheKey", () => {
    it("_rsc クエリのみ除去する", () => {
      expect(hooks.makeCacheKey(abs("/meals?_rsc=abc12"))).toBe(abs("/meals"))
    })

    it("他のクエリは維持する", () => {
      expect(hooks.makeCacheKey(abs("/meals?date=2026-06-01&_rsc=abc"))).toBe(
        abs("/meals?date=2026-06-01")
      )
    })

    it("ハッシュ違いの _rsc が同一キーに正規化される", () => {
      expect(hooks.makeCacheKey(abs("/baby?_rsc=aaa"))).toBe(
        hooks.makeCacheKey(abs("/baby?_rsc=zzz"))
      )
    })

    it("クエリなし URL はそのまま", () => {
      expect(hooks.makeCacheKey(abs("/stock"))).toBe(abs("/stock"))
    })
  })

  describe("extractAssetUrls", () => {
    it("script/link 属性形の /_next/static/ URL を抽出する", () => {
      const html =
        '<link rel="stylesheet" href="/_next/static/chunks/0_abc.css"/>' +
        '<script src="/_next/static/chunks/turbopack-xyz.js" async></script>'
      expect(hooks.extractAssetUrls(html)).toEqual([
        "/_next/static/chunks/0_abc.css",
        "/_next/static/chunks/turbopack-xyz.js",
      ])
    })

    it("flight payload 内のエスケープ済み文字列 (\\\") からも URL だけを切り出す", () => {
      const html =
        '<script>self.__next_f.push([1,"[\\"/_next/static/chunks/080ra-1y_w-lt.js\\"]"])</script>'
      expect(hooks.extractAssetUrls(html)).toEqual([
        "/_next/static/chunks/080ra-1y_w-lt.js",
      ])
    })

    it("重複 URL は一意化される", () => {
      const html =
        '<script src="/_next/static/chunks/a.js"></script>' +
        '<script>"\\"/_next/static/chunks/a.js\\""</script>'
      expect(hooks.extractAssetUrls(html)).toEqual(["/_next/static/chunks/a.js"])
    })

    it("/_next/static/ 以外の URL は含めない", () => {
      const html = '<script src="/api/foo.js"></script><img src="/icons/icon.svg"/>'
      expect(hooks.extractAssetUrls(html)).toEqual([])
    })
  })

  describe("trimCache", () => {
    function makeFakeCaches(urls: string[]) {
      const deleted: string[] = []
      const entries = urls.map((url) => ({ url }))
      const fakeCache = {
        keys: () => Promise.resolve(entries),
        delete: (request: { url: string }) => {
          deleted.push(request.url)
          return Promise.resolve(true)
        },
      }
      return { caches: { open: () => Promise.resolve(fakeCache) }, deleted }
    }

    it("上限超過分を挿入順 (古い順) に FIFO で削除する", async () => {
      const { caches, deleted } = makeFakeCaches(["u1", "u2", "u3", "u4", "u5"])
      const trimHooks = loadSw({ caches })
      await trimHooks.trimCache("irori-v1-documents", 3)
      expect(deleted).toEqual(["u1", "u2"])
    })

    it("上限以下なら何も削除しない", async () => {
      const { caches, deleted } = makeFakeCaches(["u1", "u2"])
      const trimHooks = loadSw({ caches })
      await trimHooks.trimCache("irori-v1-documents", 3)
      expect(deleted).toEqual([])
    })

    it("max 未指定 (precache 等) ならトリムしない", async () => {
      const { caches, deleted } = makeFakeCaches(["u1", "u2", "u3"])
      const trimHooks = loadSw({ caches })
      await trimHooks.trimCache("irori-v1-precache")
      expect(deleted).toEqual([])
    })
  })
})

describe("イベントリスナの登録", () => {
  it("push / notificationclick / pushsubscriptionchange を含む必要なイベントが全て登録される", () => {
    const { events } = loadSwWithEvents()

    // 集合として固定する。綴り間違い・登録漏れがそのまま赤になる。
    // ⚠️ `pushsubscriptionchange` を落とすと、ブラウザが購読を回した瞬間に
    // **通知が黙って止まる**（純粋関数のテストは全部緑のまま）。
    expect([...events].sort()).toEqual([
      "activate",
      "fetch",
      "install",
      "message",
      "notificationclick",
      "push",
      "pushsubscriptionchange",
    ])
  })
})

describe("pushsubscriptionchange（購読の張り直し・B-4）", () => {
  const NEW_SUB = {
    endpoint: "https://fcm.googleapis.com/new",
    keys: { p256dh: "k-new", auth: "a-new" },
  }

  function jsonResponse(body: unknown, status = 200): DuckResponse {
    return {
      status,
      headers: { get: (n: string) => (n === "content-type" ? "application/json" : null) },
      json: () => Promise.resolve(body),
    }
  }

  /** proxy が承認ゲートで返す HTML（セッション切れ・未承認）。 */
  function htmlResponse(status = 200): DuckResponse {
    return {
      status,
      headers: { get: (n: string) => (n === "content-type" ? "text/html; charset=utf-8" : null) },
      json: () => Promise.reject(new Error("not json")),
    }
  }

  interface FetchCall {
    url: string
    init: {
      method?: string
      redirect?: string
      credentials?: string
      body?: string
    }
  }

  /**
   * SW の `self.navigator.userAgent`。**既定で在ることにする** ——
   * 実機（Chrome / Safari の WorkerNavigator）は必ず持っておるゆえ、既定を
   * 「無い」にすると UA が body に載る経路が**一度も実行されぬ**まま緑になる。
   */
  const SW_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0"

  function setup(
    options: {
      response?: DuckResponse | (() => DuckResponse)
      existing?: unknown
      subscribeResult?: unknown
      onSubscribe?: (options: unknown) => void
      /** null を渡せば `self.navigator` 自体を置かぬ（UA が取れぬ端末）。 */
      userAgent?: string | null
    } = {},
  ) {
    const calls: FetchCall[] = []
    const fetch = (url: string, init: FetchCall["init"]) => {
      calls.push({ url, init })
      const res = options.response ?? jsonResponse({ ok: true })
      return Promise.resolve(typeof res === "function" ? res() : res)
    }
    const pushManager = {
      getSubscription: () => Promise.resolve(options.existing ?? null),
      subscribe: (subscribeOptions: unknown) => {
        options.onSubscribe?.(subscribeOptions)
        return Promise.resolve(options.subscribeResult ?? null)
      },
    }
    const userAgent = options.userAgent === undefined ? SW_UA : options.userAgent
    const hooks = loadSw(
      { fetch },
      {
        registration: { pushManager },
        ...(userAgent === null ? {} : { navigator: { userAgent } }),
      },
    )
    return { hooks, calls }
  }

  const subscription = (json: unknown) => ({ toJSON: () => json })

  it("`event.newSubscription` をそのままサーバへ登録し直す", async () => {
    const { hooks, calls } = setup()
    await hooks.handlePushSubscriptionChange({
      newSubscription: subscription(NEW_SUB),
      oldSubscription: { endpoint: "https://fcm.googleapis.com/old" },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("/api/push/resubscribe")
    expect(calls[0].init.method).toBe("POST")
    // ⚠️ 承認ゲートの 307 を追わせぬ（追うと HTML の 200 を成功と誤読する）。
    expect(calls[0].init.redirect).toBe("manual")
    // ⚠️ `userAgent` を落とすと `ON CONFLICT ... SET user_agent =
    // EXCLUDED.user_agent` が既存の端末名を NULL で潰し、設定カードの全端末が
    // 「不明な端末」に化ける（どれを解除すればよいか主に分からなくなる）。
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      endpoint: NEW_SUB.endpoint,
      p256dh: "k-new",
      auth: "a-new",
      oldEndpoint: "https://fcm.googleapis.com/old",
      userAgent: SW_UA,
    })
  })

  it("UA が取れぬ端末では **載せぬ**（空文字や undefined を送らぬ）", async () => {
    // 対で置く。片側だけでは「常に UA を載せる」実装と区別がつかぬ
    // （＝ 向きが決まらぬ）。
    const { hooks, calls } = setup({ userAgent: null })
    await hooks.handlePushSubscriptionChange({
      newSubscription: subscription(NEW_SUB),
    })

    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].init.body as string)
    expect(body).toEqual({
      endpoint: NEW_SUB.endpoint,
      p256dh: "k-new",
      auth: "a-new",
    })
    expect("userAgent" in body).toBe(false)
  })

  it("newSubscription が無ければ `getSubscription()` を使う（Firefox 等）", async () => {
    const { hooks, calls } = setup({ existing: subscription(NEW_SUB) })
    await hooks.handlePushSubscriptionChange({})

    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].init.body as string).endpoint).toBe(NEW_SUB.endpoint)
  })

  it("どちらも無ければ旧購読の applicationServerKey で subscribe し直す", async () => {
    const seen: unknown[] = []
    const { hooks, calls } = setup({
      subscribeResult: subscription(NEW_SUB),
      onSubscribe: (o) => seen.push(o),
    })
    await hooks.handlePushSubscriptionChange({
      oldSubscription: {
        endpoint: "https://fcm.googleapis.com/old",
        options: { applicationServerKey: "key-bytes", userVisibleOnly: true },
      },
    })

    // Safari は不可視 push を許さぬ。登録時と同じ条件で張り直す。
    expect(seen).toEqual([
      { userVisibleOnly: true, applicationServerKey: "key-bytes" },
    ])
    expect(calls).toHaveLength(1)
  })

  it("鍵の出所が無ければ**何もせぬ**（推測の鍵で 403 の購読を自作せぬ）", async () => {
    const { hooks, calls } = setup()
    await hooks.handlePushSubscriptionChange({
      oldSubscription: { endpoint: "https://fcm.googleapis.com/old" },
    })
    expect(calls).toEqual([])
  })

  it("fetch が落ちても throw せぬ（waitUntil を壊さぬ）", async () => {
    const hooks = loadSw(
      {
        fetch: () => Promise.reject(new Error("offline")),
      },
      { registration: { pushManager: { getSubscription: () => Promise.resolve(null) } } },
    )
    await expect(
      hooks.handlePushSubscriptionChange({ newSubscription: subscription(NEW_SUB) }),
    ).resolves.toBeUndefined()
  })

  describe("isResubscribeAccepted — **`res.ok` を信じてはならぬ**", () => {
    it("JSON の { ok: true } だけを受理とする", async () => {
      const hooks = loadSw()
      await expect(hooks.isResubscribeAccepted(jsonResponse({ ok: true }))).resolves.toBe(
        true,
      )
    })

    it("proxy の承認ゲートが返す HTML 200 は受理せぬ（**これが V8 型の罠じゃ**）", async () => {
      const hooks = loadSw()
      // セッション切れ → /login へ 307 → fetch が追えば HTML の 200 が返り、
      // `res.ok` は true になる。何も登録されておらぬのに成功と記録してしまう。
      await expect(hooks.isResubscribeAccepted(htmlResponse(200))).resolves.toBe(false)
    })

    it("redirect: manual の opaqueredirect（status 0）も受理せぬ", async () => {
      const hooks = loadSw()
      await expect(
        hooks.isResubscribeAccepted({
          status: 0,
          headers: { get: () => null },
          json: () => Promise.reject(new Error("opaque")),
        }),
      ).resolves.toBe(false)
    })

    it("JSON でも { ok: false } は受理せぬ", async () => {
      const hooks = loadSw()
      await expect(
        hooks.isResubscribeAccepted(jsonResponse({ ok: false })),
      ).resolves.toBe(false)
    })

    it("応答が無い（null）でも throw せぬ", async () => {
      const hooks = loadSw()
      await expect(hooks.isResubscribeAccepted(null)).resolves.toBe(false)
    })
  })

  describe("buildResubscribeBody", () => {
    const hooks = loadSw()

    it("鍵が欠けておれば null（送らぬ）", () => {
      expect(
        hooks.buildResubscribeBody({ endpoint: "https://x/y", keys: { p256dh: "k" } }),
      ).toBeNull()
      expect(hooks.buildResubscribeBody({ keys: { p256dh: "k", auth: "a" } })).toBeNull()
      expect(hooks.buildResubscribeBody(null)).toBeNull()
    })

    it("oldEndpoint が新しい endpoint と同じなら載せぬ（消す対象が無い）", () => {
      expect(
        hooks.buildResubscribeBody(NEW_SUB, NEW_SUB.endpoint),
      ).toEqual({ endpoint: NEW_SUB.endpoint, p256dh: "k-new", auth: "a-new" })
    })

    it("oldEndpoint が無くても body は組める", () => {
      expect(hooks.buildResubscribeBody(NEW_SUB, null)).toEqual({
        endpoint: NEW_SUB.endpoint,
        p256dh: "k-new",
        auth: "a-new",
      })
    })

    it("userAgent は在れば載る・無ければ載らぬ（NULL で端末名を潰さぬ）", () => {
      expect(hooks.buildResubscribeBody(NEW_SUB, null, "Mac の Chrome")).toEqual({
        endpoint: NEW_SUB.endpoint,
        p256dh: "k-new",
        auth: "a-new",
        userAgent: "Mac の Chrome",
      })
      // 空文字・null は「取れなかった」と同じ扱い（サーバ側で null へ退化する）。
      expect(hooks.buildResubscribeBody(NEW_SUB, null, "")).toEqual({
        endpoint: NEW_SUB.endpoint,
        p256dh: "k-new",
        auth: "a-new",
      })
      expect(hooks.buildResubscribeBody(NEW_SUB, null, null)).toEqual({
        endpoint: NEW_SUB.endpoint,
        p256dh: "k-new",
        auth: "a-new",
      })
    })
  })

  it("登録先パスは Route Handler と一致する（手動同期の綻びを殺す）", () => {
    const hooks = loadSw()
    expect(hooks.RESUBSCRIBE_PATH).toBe("/api/push/resubscribe")
  })
})

describe("parsePushPayload", () => {
  // ⚠️ この関数の契約は「**何を渡されても必ず title と body を返す**」じゃ。
  // Apple 公式: 受け取った push を可視通知として出さねば Safari は権限を剥奪する
  // （"If you don't [present immediately], Safari revokes the push notification
  //  permission for your site."）。ゆえに throw も undefined も許されぬ。
  const hooks = loadSw()

  it("正常なペイロードをそのまま通す", () => {
    const result = hooks.parsePushPayload({
      data: {
        json: () => ({ title: "予定", body: "10分前です", url: "/calendar", tag: "e1" }),
        text: () => "",
      },
    })
    expect(result).toEqual({
      title: "予定",
      body: "10分前です",
      url: "/calendar",
      tag: "e1",
    })
  })

  it("data が無くても汎用文言を返す（throw しない）", () => {
    expect(hooks.parsePushPayload({ data: null })).toEqual({
      title: "irori",
      body: "新しいお知らせがあります",
    })
    expect(hooks.parsePushPayload(null)).toEqual({
      title: "irori",
      body: "新しいお知らせがあります",
    })
  })

  it("JSON が壊れていればテキストとして拾う", () => {
    const result = hooks.parsePushPayload({
      data: {
        json: () => {
          throw new Error("invalid json")
        },
        text: () => "素のテキスト",
      },
    })
    expect(result.title).toBe("irori")
    expect(result.body).toBe("素のテキスト")
  })

  it("JSON もテキストも落ちれば汎用文言へ倒す", () => {
    const result = hooks.parsePushPayload({
      data: {
        json: () => {
          throw new Error("invalid json")
        },
        text: () => {
          throw new Error("invalid text")
        },
      },
    })
    expect(result).toEqual({
      title: "irori",
      body: "新しいお知らせがあります",
    })
  })

  it("title / body が空文字や非文字列なら汎用文言で埋める", () => {
    const result = hooks.parsePushPayload({
      data: { json: () => ({ title: "", body: 42 }), text: () => "" },
    })
    expect(result.title).toBe("irori")
    expect(result.body).toBe("新しいお知らせがあります")
  })

  it("JSON が object でなければ汎用文言へ倒す", () => {
    const result = hooks.parsePushPayload({
      data: { json: () => "文字列だった", text: () => "" },
    })
    expect(result).toEqual({
      title: "irori",
      body: "新しいお知らせがあります",
    })
  })
})
