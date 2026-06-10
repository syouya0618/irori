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

interface TestHooks {
  classifyRequest: (request: DuckRequest, originHref: string) => string | null
  makeCacheKey: (rawUrl: string) => string
  trimCache: (cacheName: string, max?: number) => Promise<void>
  extractAssetUrls: (html: string) => string[]
  CACHE_NAMES: Record<string, string>
  APP_PAGES: string[]
  PRECACHE_URLS: string[]
}

function loadSw(extraGlobals: Record<string, unknown> = {}): TestHooks {
  const code = readFileSync(SW_PATH, "utf8")
  const self: Record<string, unknown> = {
    addEventListener: () => {},
    location: { href: ORIGIN },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
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
  return hooks
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
