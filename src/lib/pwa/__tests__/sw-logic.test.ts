import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
// classic script の sw.js は import できぬゆえ、手動同期の綻びをここで殺す
// （既定の着地先がアプリ側の定数と一致することを機械で縛る）。
import { CALENDAR_DATE_PARAM, CALENDAR_PATH } from "@/lib/domain/calendar-link"

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
  // B-6: document 専用キー（`?date=` を落とす）。
  makeDocumentCacheKey: (rawUrl: string) => string
  // ⚠️ 戻りを `unknown` にすると「オフラインで何が返ったか」を型が助けてくれぬ
  // （上の buildResubscribeBody の傷と同じ轍じゃ）。status と本文で締める。
  handleDocument: (
    request: DuckRequest,
  ) => Promise<{ status: number; text: () => Promise<string> }>
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
  // B-6: 通知の着地先。`unknown` で受けるのは duck 実装（notification も client も
  // 最小のスタブ）を渡すためじゃ。**戻りは string / Promise<void> で締める** ——
  // 全部 `unknown` にすると「クエリを落としておらぬ」を型が助けてくれぬ。
  notificationTargetUrl: (notification: unknown) => string
  handleNotificationClick: (event: unknown) => Promise<void>
  DEFAULT_NOTIFICATION_URL: string
  CACHE_NAMES: Record<string, string>
  MAX_ENTRIES: Record<string, number>
  APP_PAGES: string[]
  PRECACHE_URLS: string[]
  PRECACHE_EVICT_URLS: string[]
  RESUBSCRIBE_PATH: string
  CALENDAR_DATE_PARAM: string
}

/** 登録された `addEventListener(type, listener)` の対。 */
interface RecordedListener {
  type: string
  listener: (event: unknown) => void
}

/**
 * sw.js を評価し、`__TEST_HOOKS__` と **登録されたイベント名の一覧**、
 * そして**リスナ関数そのもの**を返す。
 *
 * ⚠️ `addEventListener` を no-op スタブにすると、**リスナ登録そのものを検証できぬ**。
 * `"push"` を `"pushnotification"` と綴り間違えても純粋関数のテストは全部緑のまま、
 * 本番では 1 通も届かぬ — CLAUDE.md の「規約ファイルは在るだけでは効いておらぬ」と
 * 同 family じゃ。ゆえに記録関数にして集合を assert できるようにする。
 *
 * ⚠️ さらに**リスナ関数を捨ててはならぬ**（B-6 のレビュー指摘）。名前だけ記録して
 * 関数を捨てると、`data: { url: payload.url }` を `data: {}` に戻しても・
 * `event.waitUntil(handleNotificationClick(event))` を書き崩しても全部緑のまま、
 * 通知タップは 100% 今日を開く。**クエリを運ぶ継ぎ目はここでしか撃てぬ。**
 */
function loadSwWithEvents(
  extraGlobals: Record<string, unknown> = {},
  selfOverrides: Record<string, unknown> = {},
): {
  hooks: TestHooks
  events: string[]
  listeners: RecordedListener[]
} {
  const code = readFileSync(SW_PATH, "utf8")
  const events: string[] = []
  const listeners: RecordedListener[] = []
  const self: Record<string, unknown> = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      events.push(type)
      listeners.push({ type, listener })
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
  return { hooks, events, listeners }
}

/** 登録済みリスナを 1 本取り出す（無ければ落とす — 空回りを緑にせぬ）。 */
function listenerFor(
  listeners: RecordedListener[],
  type: string,
): (event: unknown) => void {
  const found = listeners.filter((l) => l.type === type)
  if (found.length !== 1) {
    throw new Error(`"${type}" リスナが ${found.length} 本（1 本であるべき）`)
  }
  return found[0].listener
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

    it("navigate × `/calendar?date=` (通知の着地先) → document", () => {
      // B-6: 通知タップはこの分類を通る。ここが null / nav-passthrough に化けると
      // キャッシュされず、オフラインで必ず /offline が出る。
      const req = makeReq(abs("/calendar?date=2026-09-01"), { mode: "navigate" })
      expect(hooks.classifyRequest(req, ORIGIN)).toBe("document")
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

    it("PRECACHE_URLS の fetch (アイコン) → precached", () => {
      expect(hooks.classifyRequest(makeReq(abs("/icons/icon-192.png")), ORIGIN)).toBe(
        "precached"
      )
    })

    /**
     * ⚠️ **manifest だけは SW が触れてはならぬ。**
     *
     * precache は cache-first で、中身が更新されるのは `install` の時だけ ——
     * そして `install` が再実行されるのは **sw.js のバイト列が変わった時だけ**。
     * ゆえに manifest をここへ入れると、manifest を直して配っても既存端末には
     * **永久に古い方が配られ続ける**。
     *
     * 2026-08-10 に実際に起きた: `start_url` を `/` へ直した (#219) のに
     * ホーム画面からは必ず献立が開き、**アイコンを入れ直しても直らなんだ** ——
     * 入れ直すその瞬間に OS が読む manifest を、SW が古い方へすり替えておったゆえ。
     * 「manifest の取得が SW を通る」ことは Chrome で実測済み（precache から
     * 削除 → 再読込 → エントリが戻った）。
     *
     * この 2 本は**対で意味を持つ**。片方だけだと「一覧から消したが分類は
     * precached のまま」という半端な状態を素通しする。
     */
    it("manifest は SW が関与せぬ（null＝ブラウザが常に生を取る）", () => {
      expect(
        hooks.classifyRequest(makeReq(abs("/manifest.webmanifest")), ORIGIN)
      ).toBeNull()
    })

    it("manifest は PRECACHE_URLS に無く、退避対象に挙がっておる", () => {
      expect(hooks.PRECACHE_URLS).not.toContain("/manifest.webmanifest")
      // 過去に焼き込まれた毒入りエントリを activate で掃くための名指し
      expect(hooks.PRECACHE_EVICT_URLS).toContain("/manifest.webmanifest")
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

    // ⚠️ **この 2 本と下の makeDocumentCacheKey 節は対で読むこと。**
    // rsc は日を残さねばならぬ（落とせば別の日の flight payload をルーターへ返す）。
    // document は日を落とさねばならぬ（残せばオフラインで当たらず、キーが際限なく
    // 増えて他ページを追い出す）。「同じことを 2 回書いておる」と見て統合すると、
    // どちら向きでも必ず片方が壊れる。
    it("他のクエリは維持する（rsc はこのキーを共有する）", () => {
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

  describe("makeDocumentCacheKey（B-6: document 専用。日を落とす）", () => {
    it("`?date=` を落とす（濃度を APP_PAGES 相当に保つ）", () => {
      expect(hooks.makeDocumentCacheKey(abs("/calendar?date=2026-09-01"))).toBe(
        abs("/calendar"),
      )
    })

    it("日付が違っても同一キーへ正規化される", () => {
      expect(hooks.makeDocumentCacheKey(abs("/calendar?date=2026-09-01"))).toBe(
        hooks.makeDocumentCacheKey(abs("/calendar?date=2027-01-31")),
      )
    })

    it("_rsc も落とす（makeCacheKey に委ねておる）", () => {
      expect(hooks.makeDocumentCacheKey(abs("/calendar?date=2026-09-01&_rsc=abc"))).toBe(
        abs("/calendar"),
      )
    })

    it("date 以外のクエリは維持する（勝手に広げておらぬ）", () => {
      // `/settings?google=connected` は接続直後の着地先じゃ。ここまで落とすと
      // 別の意味のページを 1 つのキーに混ぜることになる。
      expect(hooks.makeDocumentCacheKey(abs("/settings?google=connected"))).toBe(
        abs("/settings?google=connected"),
      )
    })

    it("クエリ名はアプリ側の定数と一致する（手動同期の綻びを殺す）", () => {
      // src/lib/domain/calendar-link.ts の CALENDAR_DATE_PARAM（classic script ゆえ
      // import 不可）。改名すると sw 側が日を落とさなくなり、オフラインの着地が壊れる。
      expect(hooks.CALENDAR_DATE_PARAM).toBe(CALENDAR_DATE_PARAM)
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

/**
 * document キャッシュ — **通知の着地を実際に描く経路**（B-6 のレビュー指摘）。
 *
 * 通知の着地先を `?date=` にしただけでは足りぬ。`handleDocument` のキーが日付を
 * 抱えたままだと、同じ 1 つの変更で 2 つ壊れる:
 *   (a) オフラインで cached の `/calendar` に当たらず `/offline` が出る
 *       —— 通知タップは最も圏外になりやすい瞬間ゆえ実害じゃ
 *   (b) キー濃度が日付ぶん無制限に増え、上限 16 の FIFO が他ページを追い出す
 * どちらも純粋関数のテストでは 1 本も落ちぬ。ゆえに **fetch リスナへ実際に
 * navigate を投げて**、返った本文とキャッシュのキー集合を見る。
 */
describe("document キャッシュ — `?date=` の着地（B-6）", () => {
  /** sw.js が触る範囲だけを満たす Response の代役。 */
  class FakeRes {
    status: number
    ok: boolean
    redirected: boolean
    body: string
    headers: { get: (name: string) => string | null }
    private headerMap: Record<string, string>

    constructor(
      body: string,
      init: {
        status?: number
        headers?: Record<string, string>
        redirected?: boolean
      } = {},
    ) {
      this.body = body
      this.status = init.status ?? 200
      this.ok = this.status >= 200 && this.status < 300
      this.redirected = init.redirected ?? false
      this.headerMap = {}
      for (const [k, v] of Object.entries(init.headers ?? {})) {
        this.headerMap[k.toLowerCase()] = v
      }
      this.headers = { get: (name) => this.headerMap[name.toLowerCase()] ?? null }
    }

    clone(): FakeRes {
      return new FakeRes(this.body, {
        status: this.status,
        headers: this.headerMap,
        redirected: this.redirected,
      })
    }

    text(): Promise<string> {
      return Promise.resolve(this.body)
    }
  }

  const HTML = { "content-type": "text/html; charset=utf-8" }
  const OFFLINE_BODY = "オフライン画面じゃ"

  interface Entry {
    url: string
    res: FakeRes
  }

  /** CacheStorage の代役。`open` は同名なら**同じ配列**を返す（挿入順 = FIFO 順）。 */
  function makeCacheStorage() {
    const stores = new Map<string, Entry[]>()
    const keyOf = (req: string | { url: string }) =>
      typeof req === "string" ? new URL(req, ORIGIN).href : req.url
    const entriesOf = (name: string) => {
      if (!stores.has(name)) stores.set(name, [])
      return stores.get(name)!
    }
    const open = (name: string) => {
      const entries = entriesOf(name)
      return Promise.resolve({
        keys: () => Promise.resolve(entries.map((e) => ({ url: e.url }))),
        match: (req: string | { url: string }) => {
          const url = keyOf(req)
          return Promise.resolve(entries.find((e) => e.url === url)?.res)
        },
        put: (req: string | { url: string }, res: FakeRes) => {
          const url = keyOf(req)
          const i = entries.findIndex((e) => e.url === url)
          if (i >= 0) entries[i] = { url, res }
          else entries.push({ url, res })
          return Promise.resolve()
        },
        delete: (req: string | { url: string }) => {
          const url = keyOf(req)
          const i = entries.findIndex((e) => e.url === url)
          if (i >= 0) entries.splice(i, 1)
          return Promise.resolve(i >= 0)
        },
      })
    }
    return {
      caches: {
        open,
        keys: () => Promise.resolve([...stores.keys()]),
        delete: (name: string) => Promise.resolve(stores.delete(name)),
      },
      seed: (name: string, url: string, res: FakeRes) =>
        entriesOf(name).push({ url: new URL(url, ORIGIN).href, res }),
      urlsIn: (name: string) => entriesOf(name).map((e) => e.url),
    }
  }

  function setup() {
    const store = makeCacheStorage()
    let online = true
    const fetched: string[] = []
    const fetchImpl = (input: string | DuckRequest) => {
      const href = typeof input === "string" ? new URL(input, ORIGIN).href : input.url
      fetched.push(href)
      if (!online) return Promise.reject(new Error("offline"))
      const u = new URL(href)
      return Promise.resolve(new FakeRes(`server:${u.pathname}${u.search}`, { headers: HTML }))
    }
    const { hooks, listeners } = loadSwWithEvents({
      caches: store.caches,
      fetch: fetchImpl,
      Response: FakeRes,
    })
    // precache に /offline を仕込む。**退化先を判別可能にする要**じゃ ——
    // 無いと offlineFallback が素の 503 を返し、「キャッシュに当たった」と
    // 「/offline が出た」の区別が本文から付かなくなる。
    // date ヘッダを新鮮にして maybeRefreshOffline の再取得を止める（余計な fetch を混ぜぬ）。
    store.seed(
      hooks.CACHE_NAMES.precache,
      "/offline",
      new FakeRes(OFFLINE_BODY, {
        headers: { ...HTML, date: new Date().toUTCString() },
      }),
    )

    async function navigate(path: string): Promise<{ status: number; body: string }> {
      let responded: Promise<{ status: number; text: () => Promise<string> }> | null = null
      const waits: Promise<unknown>[] = []
      listenerFor(listeners, "fetch")({
        request: makeReq(abs(path), { mode: "navigate" }),
        respondWith: (p: Promise<{ status: number; text: () => Promise<string> }>) => {
          responded = p
        },
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      })
      // 空回りを緑にせぬ: 分類が null に化けたらここで落ちる。
      if (!responded) throw new Error(`fetch リスナが respondWith を呼ばなかった: ${path}`)
      const res = await (responded as Promise<{
        status: number
        text: () => Promise<string>
      }>)
      // maybeRefreshOffline は自分で catch するが、未 await の reject を残さぬ。
      await Promise.all(waits.map((p) => Promise.resolve(p).catch(() => undefined)))
      return { status: res.status, body: await res.text() }
    }

    return {
      hooks,
      navigate,
      goOffline: () => {
        online = false
      },
      documentUrls: () => store.urlsIn(hooks.CACHE_NAMES.documents),
      fetched,
    }
  }

  it("harness が空回りしておらぬ（オンライン訪問で documents に 1 件入る）", async () => {
    const sw = setup()
    const res = await sw.navigate("/calendar")
    expect(res.body).toBe("server:/calendar")
    expect(sw.documentUrls()).toEqual([abs("/calendar")])
  })

  it("オフラインで cached が無ければ /offline へ倒れる（対照: 退化先は実際に出る）", async () => {
    const sw = setup()
    sw.goOffline()
    const res = await sw.navigate("/meals")
    expect(res.body).toBe(OFFLINE_BODY)
  })

  it("**オフラインの `?date=` は cached のカレンダーを返す**（/offline へ落ちぬ）", async () => {
    const sw = setup()
    await sw.navigate("/calendar") // オンラインで一度開いておく
    sw.goOffline()
    const res = await sw.navigate("/calendar?date=2026-09-01")
    // 日付付きのキーで探すと**構造的に必ずミス**する（B-6 が直した経路そのものが
    // オフラインで死ぬ）。ここが OFFLINE_BODY なら退行じゃ。
    expect(res.body).toBe("server:/calendar")
    expect(res.status).toBe(200)
  })

  it("オンラインの `?date=` 訪問も cached を作る（通知しか使わぬ端末を見捨てぬ）", async () => {
    const sw = setup()
    await sw.navigate("/calendar?date=2026-09-01")
    expect(sw.documentUrls()).toEqual([abs("/calendar")])
    sw.goOffline()
    expect((await sw.navigate("/calendar")).body).toBe("server:/calendar?date=2026-09-01")
  })

  it("`?date=` を 16 回叩いても他の APP_PAGES がオフラインキャッシュから消えぬ", async () => {
    const sw = setup()
    for (const page of sw.hooks.APP_PAGES) await sw.navigate(page)
    // 毎朝のまとめ ≒ 2 週間ぶん。上限（16）を超える回数を叩く。
    const taps = sw.hooks.MAX_ENTRIES.documents
    expect(taps).toBeGreaterThan(0)
    for (let i = 1; i <= taps; i++) {
      await sw.navigate(`/calendar?date=2026-09-${String(i).padStart(2, "0")}`)
    }

    const urls = sw.documentUrls()
    // (1) 日付がキーに 1 つも残っておらぬ（put 側も正規化されておる証拠）。
    //     match だけ直した半端な修正はここで落ちる。
    expect(urls.filter((u) => u.includes("date="))).toEqual([])
    // (2) キー濃度は APP_PAGES の本数どまり。
    expect(urls.length).toBe(sw.hooks.APP_PAGES.length)
    // (3) 追い出されておらぬこと（オフライン閲覧が全滅せぬ）。
    for (const page of sw.hooks.APP_PAGES) {
      expect(urls, `${page} が documents から消えておる`).toContain(abs(page))
    }
    // (4) 実際にオフラインで開けること（キー集合だけでなく振る舞いで見る）。
    sw.goOffline()
    expect((await sw.navigate("/meals")).body).toBe("server:/meals")
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
    // ⚠️ url は **`?date=` 付きの実値**で撃つこと（B-6）。`"/calendar"` で撃つと
    // 「クエリを落とす正規化」が入っても永久に緑のままじゃ。
    const result = hooks.parsePushPayload({
      data: {
        json: () => ({
          title: "予定",
          body: "10分前です",
          url: "/calendar?date=2026-09-01",
          tag: "e1",
        }),
        text: () => "",
      },
    })
    expect(result).toEqual({
      title: "予定",
      body: "10分前です",
      url: "/calendar?date=2026-09-01",
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

/**
 * push リスナ — **`?date=` を通知へ載せる継ぎ目**（B-6 のレビュー指摘）。
 *
 * 鎖は「組立 → 送信 → **push リスナ** → **notificationclick リスナ** → navigate →
 * page → CalendarView」じゃ。両端は縛られておるのに、真ん中の 2 本のリスナは
 * リスナ関数を捨てる harness のせいで一度も起動されておらなかった。
 * ゆえに `data: { url: payload.url }` を `data: {}` に戻しても vitest 全数が緑のまま、
 * 通知タップは 100% 今日を開く（CLAUDE.md「テスト緑・本番不発」型）。
 */
describe("push リスナ — 通知の data.url（B-6）", () => {
  interface Shown {
    title: string
    options: { body?: string; tag?: string; data?: { url?: string } }
  }

  function setup() {
    const shown: Shown[] = []
    const { hooks, listeners } = loadSwWithEvents(
      {},
      {
        registration: {
          showNotification: (title: string, options: Shown["options"]) => {
            shown.push({ title, options })
            return Promise.resolve()
          },
        },
      },
    )
    async function dispatch(payload: unknown) {
      const waits: Promise<unknown>[] = []
      listenerFor(listeners, "push")({
        data: { json: () => payload, text: () => "" },
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      })
      // ⚠️ waitUntil を通さぬ実装は、SW が寝た瞬間に通知を出せず Safari が
      // 権限を剥奪する。空回りを緑にせぬためここで落とす。
      if (waits.length === 0) throw new Error("push リスナが waitUntil を呼ばなかった")
      await Promise.all(waits)
    }
    return { hooks, shown, dispatch }
  }

  it("配信ジョブの url を**そのまま** data.url へ載せる（クエリを落とさぬ）", async () => {
    const { shown, dispatch } = setup()
    await dispatch({
      title: "検診",
      body: "9月1日 10:00",
      url: "/calendar?date=2026-09-01",
      tag: "event:abc",
    })

    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe("検診")
    expect(shown[0].options.body).toBe("9月1日 10:00")
    expect(shown[0].options.tag).toBe("event:abc")
    // ここが `/calendar` に化けたら B-6 は丸ごと死ぬ（通知は正しい日を運んでおるのに）。
    expect(shown[0].options.data?.url).toBe("/calendar?date=2026-09-01")
  })

  it("url を持たぬ古いペイロードは既定の /calendar へ倒す（data を空にせぬ）", async () => {
    const { hooks, shown, dispatch } = setup()
    await dispatch({ title: "お知らせ", body: "本文" })
    expect(shown[0].options.data?.url).toBe(hooks.DEFAULT_NOTIFICATION_URL)
  })

  it("壊れたペイロードでも必ず可視通知を出す（Safari の権限剥奪を避ける）", async () => {
    const { shown, dispatch } = setup()
    await dispatch("文字列だった")
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe("irori")
  })
})

/**
 * notificationclick — **通知の着地日**（B-6）。
 *
 * ここが「focus だけ」に戻ると、通知は正しい日（`?date=`）を運んでおるのに
 * 既存タブは開いたままの日を映す —— 「前日20時」の通知と毎朝のまとめは
 * **今日でない日**を指すゆえ、それは毎回外れることを意味する。
 * 純粋関数のテストでは捕まらぬ（本文も URL も正しいのに画面だけ違う）ゆえ、
 * ハンドラ本体を `__TEST_HOOKS__` から呼んで navigate 先まで見る。
 */
describe("notificationclick — 既存タブの日付を動かす（B-6）", () => {
  const TARGET = "/calendar?date=2026-09-01"

  interface ClientCall {
    focused: boolean
    navigated: string[]
  }

  function makeClient(options: { canNavigate?: boolean; navigateFails?: boolean } = {}) {
    const record: ClientCall = { focused: false, navigated: [] }
    const client: Record<string, unknown> = {
      focus: () => {
        record.focused = true
        return Promise.resolve(client)
      },
    }
    if (options.canNavigate !== false) {
      client.navigate = (url: string) => {
        record.navigated.push(url)
        return options.navigateFails
          ? Promise.reject(new Error("not controlled"))
          : Promise.resolve(client)
      }
    }
    return { client, record }
  }

  function setup(clients: unknown[]) {
    const opened: string[] = []
    const { hooks, listeners } = loadSwWithEvents(
      {},
      {
        clients: {
          matchAll: () => Promise.resolve(clients),
          openWindow: (url: string) => {
            opened.push(url)
            return Promise.resolve(null)
          },
        },
      },
    )
    return { hooks, opened, listeners }
  }

  const clickEvent = (url?: unknown, onClose?: () => void) => ({
    notification: {
      data: url === undefined ? {} : { url },
      close: onClose ?? (() => {}),
    },
  })

  it("既存タブを focus し、**`?date=` 付きの URL へ navigate する**", async () => {
    const { client, record } = makeClient()
    const { hooks, opened } = setup([client])

    await hooks.handleNotificationClick(clickEvent(TARGET))

    expect(record.focused).toBe(true)
    // focus だけで満足しておらぬこと = B-6 の核心。
    expect(record.navigated).toEqual([TARGET])
    // 既存タブが在るのに窓を増やさぬ（同じ画面が 2 つ並ぶのは始末が悪い）。
    expect(opened).toEqual([])
  })

  it("通知を閉じておる（押しても残るように見せぬ）", async () => {
    let closed = 0
    const { client } = makeClient()
    const { hooks } = setup([client])
    await hooks.handleNotificationClick(clickEvent(TARGET, () => (closed += 1)))
    expect(closed).toBe(1)
  })

  it("タブが無ければ `?date=` 付きで新しく開く", async () => {
    const { hooks, opened } = setup([])
    await hooks.handleNotificationClick(clickEvent(TARGET))
    expect(opened).toEqual([TARGET])
  })

  it("navigate が拒まれても throw せぬ（waitUntil を壊さぬ）", async () => {
    // 対で置く: 制御外の client では navigate が reject する。focus までは効く。
    const { client, record } = makeClient({ navigateFails: true })
    const { hooks, opened } = setup([client])

    await expect(hooks.handleNotificationClick(clickEvent(TARGET))).resolves.toBeUndefined()
    expect(record.focused).toBe(true)
    expect(record.navigated).toEqual([TARGET])
    // 二重に窓を開かぬ（日付が動かぬ方がまだ軽い、という判断を固定する）。
    expect(opened).toEqual([])
  })

  it("navigate を持たぬ client でも落ちぬ", async () => {
    const { client, record } = makeClient({ canNavigate: false })
    const { hooks, opened } = setup([client])
    await expect(hooks.handleNotificationClick(clickEvent(TARGET))).resolves.toBeUndefined()
    expect(record.focused).toBe(true)
    expect(opened).toEqual([])
  })

  it("**リスナが handler を呼び `waitUntil` で待たれておる**（継ぎ目そのもの）", async () => {
    // ⚠️ ハンドラ本体をいくら縛っても、`e.waitUntil(handleNotificationClick(e))` を
    // `handleNotificationClick()` に書き崩す・リスナ本体を空にする、で全部緑のまま
    // 通知タップが死ぬ。ゆえにリスナ関数を直接叩いて navigate まで見る。
    const { client, record } = makeClient()
    const { listeners } = setup([client])
    const waits: Promise<unknown>[] = []
    let closed = 0

    listenerFor(listeners, "notificationclick")({
      notification: { data: { url: TARGET }, close: () => (closed += 1) },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    })

    // waitUntil を通さねば、SW が寝て navigate 前に処理が打ち切られうる。
    expect(waits).toHaveLength(1)
    await Promise.all(waits)
    expect(record.navigated).toEqual([TARGET])
    expect(closed).toBe(1)
  })

  describe("notificationTargetUrl — 着地先の読み取り", () => {
    const hooks = loadSw()

    it("`?date=` を含む URL をそのまま使う（クエリを落とさぬ）", () => {
      // ⚠️ ここで pathname だけを取る「正規化」を足すと、通知は正しい日を
      // 運んでおるのに今日が開く（B-6 が直した不具合そのものへ戻る）。
      expect(hooks.notificationTargetUrl(clickEvent(TARGET).notification)).toBe(TARGET)
    })

    it.each([
      ["url が無い", undefined],
      ["空文字", ""],
      ["文字列でない", 42],
      ["null", null],
    ])("%s なら既定の /calendar へ倒す", (_label, url) => {
      expect(hooks.notificationTargetUrl(clickEvent(url).notification)).toBe(
        hooks.DEFAULT_NOTIFICATION_URL,
      )
    })

    it("notification 自体が無くても落ちぬ", () => {
      expect(hooks.notificationTargetUrl(undefined)).toBe("/calendar")
      expect(hooks.notificationTargetUrl(null)).toBe("/calendar")
    })
  })

  it("既定の着地先はアプリの /calendar と一致する（手動同期の綻びを殺す）", () => {
    // src/lib/domain/calendar-link.ts の CALENDAR_PATH（classic script ゆえ import 不可）
    expect(loadSw().DEFAULT_NOTIFICATION_URL).toBe(CALENDAR_PATH)
  })
})

/**
 * activate — **毒入り precache エントリの掃除**。
 *
 * 定数一覧（`PRECACHE_URLS` に無い・`PRECACHE_EVICT_URLS` に在る）を assert する
 * だけでは足りぬ。それは「一覧は直したが掃除は動かぬ」を素通しする。
 * 既存端末には**すでに焼き込まれたエントリ**が在り、それを消すのは activate ゆえ、
 * リスナ本体を実際に走らせて確かめる。
 */
describe("activate リスナ", () => {
  function makeCachesSpy(existingNames: string[]) {
    const deletedCaches: string[] = []
    const deletedEntries: string[] = []
    const fakeCache = {
      keys: () => Promise.resolve([]),
      delete: (url: string) => {
        deletedEntries.push(url)
        return Promise.resolve(true)
      },
    }
    return {
      caches: {
        keys: () => Promise.resolve(existingNames),
        open: () => Promise.resolve(fakeCache),
        delete: (name: string) => {
          deletedCaches.push(name)
          return Promise.resolve(true)
        },
      },
      deletedCaches,
      deletedEntries,
    }
  }

  /** activate リスナを走らせ、waitUntil に渡された仕事の完了まで待つ */
  async function runActivate(caches: unknown) {
    const { listeners } = loadSwWithEvents({ caches })
    let work: Promise<unknown> | null = null
    listenerFor(listeners, "activate")({
      waitUntil: (p: Promise<unknown>) => {
        work = p
      },
    })
    if (!work) throw new Error("activate が waitUntil を呼んでおらぬ")
    await work
  }

  it("precache から /manifest.webmanifest を消す（既存端末の毒抜き）", async () => {
    const spy = makeCachesSpy(["irori-v1-precache"])
    await runActivate(spy.caches)
    expect(spy.deletedEntries).toContain("/manifest.webmanifest")
  })

  it("旧バージョンのキャッシュだけを消し、現行版は残す", async () => {
    const spy = makeCachesSpy([
      "irori-v0-documents",
      "irori-v1-documents",
      "irori-v1-precache",
      "someone-elses-cache",
    ])
    await runActivate(spy.caches)
    expect(spy.deletedCaches).toEqual(["irori-v0-documents"])
    // 他アプリのキャッシュには触れぬ（prefix 判定の証人）
    expect(spy.deletedCaches).not.toContain("someone-elses-cache")
  })

  it("現行版のオフライン用ドキュメントを巻き添えで捨てぬ（bump ではなく名指しで消す理由）", async () => {
    const spy = makeCachesSpy(["irori-v1-documents", "irori-v1-precache"])
    await runActivate(spy.caches)
    expect(spy.deletedCaches).toEqual([])
    // 消えるのは名指しのエントリだけ
    expect(spy.deletedEntries).toEqual(["/manifest.webmanifest"])
  })
})
