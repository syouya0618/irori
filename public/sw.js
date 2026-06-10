/*
 * irori Service Worker — runtime-cache 型オフライン対応 (network-first)
 *
 * 方針:
 * - オンラインで訪問済みの APP_PAGES の HTML / RSC payload をオフラインでも閲覧可能にする
 * - 復帰後は network-first により常に最新を取得してキャッシュを更新する
 * - 別オリジン (Supabase 等) と非 GET (Server Action POST) は一切触らない
 * - オフライン書き込み・Push 通知はスコープ外
 */

// キャッシュスキーマ (キャッシュ名・分類ロジック・キー形式) を変更した時のみ手動で bump する。
// bump すると activate 時に旧バージョンのキャッシュが全削除される。
const CACHE_VERSION = "v1"
const PREFIX = "irori-"

const CACHE_NAMES = {
  precache: `${PREFIX}${CACHE_VERSION}-precache`,
  documents: `${PREFIX}${CACHE_VERSION}-documents`,
  rsc: `${PREFIX}${CACHE_VERSION}-rsc`,
  static: `${PREFIX}${CACHE_VERSION}-static`,
  images: `${PREFIX}${CACHE_VERSION}-images`,
}

// オフライン閲覧を許可する認証済みページ。
// src/lib/constants/pages.ts の VALID_PAGES (+ /settings) と手動同期すること。
// (classic script のため import できない — ページ追加時はここも更新する)
const APP_PAGES = ["/meals", "/shopping", "/stock", "/baby", "/settings"]

// install 時に precache する静的リソース
const PRECACHE_URLS = [
  "/offline",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
]

// 各キャッシュの上限エントリ数 (FIFO トリム)
const MAX_ENTRIES = {
  documents: 16,
  rsc: 16,
  static: 120,
  images: 40,
}

// precache 内の /offline HTML をオンライン時に再取得する閾値 (24h)
const OFFLINE_MAX_AGE_MS = 24 * 60 * 60 * 1000

// ───────────────────────── 純粋関数 ─────────────────────────
// self.__TEST_HOOKS__ で公開し、vitest (node) から node:vm 経由でテストする。
// request は duck-type ({ url, method, mode, headers.get() }) を受け付ける —
// Node では new Request(url, { mode: "navigate" }) が TypeError になるため。

/**
 * キャッシュキー用に URL を正規化する。
 * Next.js が付与する _rsc クエリ (キャッシュバスター) のみ除去し、他のクエリは維持する。
 * これによりハッシュ違いの _rsc が同一キーに正規化され、ヒット率が安定する。
 */
function makeCacheKey(rawUrl) {
  const url = new URL(rawUrl)
  url.searchParams.delete("_rsc")
  return url.href
}

/**
 * pathname が APP_PAGES に該当するか (末尾スラッシュは正規化して比較)
 */
function isAppPage(pathname) {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname
  return APP_PAGES.includes(normalized)
}

/**
 * リクエストをキャッシュ戦略に分類する。null は「SW は関与しない (ブラウザ既定の挙動)」。
 *
 * - 別オリジン → null: Supabase (REST/Auth/Storage/Realtime) を構造的に不可侵にする要
 * - 非 GET → null: Server Action の POST 等を素通しする
 * - navigate: /offline → precached / APP_PAGES → document /
 *   それ以外 (/login, /, /auth/*, /invite/*, /setup, /pending-approval) → nav-passthrough
 *   (認証フロー系は絶対にキャッシュしない)
 * - RSC fetch (RSC ヘッダー or ?_rsc=): prefetch は null (部分 payload で汚染しない) /
 *   APP_PAGES → rsc / それ以外 → null
 * - precache 対象 → precached / /_next/static/ → static / 画像系 → image
 * - 残り (/api/, /auth/ への fetch 等) → null
 */
function classifyRequest(request, originHref) {
  let url
  try {
    url = new URL(request.url)
  } catch {
    return null
  }

  // 別オリジンは一切触らない (Supabase 等)
  if (url.origin !== new URL(originHref).origin) return null

  // 非 GET (Server Action POST 等) は素通し
  if (request.method !== "GET") return null

  const pathname = url.pathname

  // ── ページナビゲーション ──
  if (request.mode === "navigate") {
    if (pathname === "/offline") return "precached"
    if (isAppPage(pathname)) return "document"
    // 認証・セットアップ系ページ: キャッシュ禁止。オフライン時のみ /offline へフォールバック
    return "nav-passthrough"
  }

  // ── RSC payload fetch (クライアントサイドナビゲーション) ──
  const isRsc = request.headers.get("RSC") === "1" || url.searchParams.has("_rsc")
  if (isRsc) {
    // prefetch は部分的な flight payload のことがあり、キャッシュを汚染するため関与しない
    if (request.headers.get("Next-Router-Prefetch") === "1") return null
    if (isAppPage(pathname)) return "rsc"
    return null
  }

  // ── 静的リソース ──
  if (PRECACHE_URLS.includes(pathname)) return "precached"
  if (pathname.startsWith("/_next/static/")) return "static"
  if (
    pathname.startsWith("/_next/image") ||
    pathname === "/favicon.ico" ||
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico)$/i.test(pathname)
  ) {
    return "image"
  }

  // それ以外 (/api/, /auth/ への fetch 等) は関与しない
  return null
}

/**
 * /offline の HTML が参照する /_next/static/ アセット URL を抽出する。
 * <script src="..."> / <link href="..."> の属性形と、flight payload 内の
 * エスケープ済み文字列 (\"/_next/static/...\") の両方にマッチする
 * (文字クラスが \ と " で止まるため、エスケープ形でも URL だけを切り出せる)。
 */
function extractAssetUrls(html) {
  const matches = html.match(/\/_next\/static\/[^"'\s\\<>]+/g) || []
  return Array.from(new Set(matches))
}

/**
 * キャッシュを FIFO でトリムする (cache.keys() は挿入順を返すため、先頭 = 最古)。
 * max が未指定 (precache 等) ならトリムしない。
 */
async function trimCache(cacheName, max) {
  if (!max) return
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  const excess = keys.length - max
  for (let i = 0; i < excess; i++) {
    await cache.delete(keys[i])
  }
}

// redirect されたレスポンスを誤キャッシュしない要 (例: 認証切れで /login へ redirect された
// HTML を /meals として保存すると、オフライン時に壊れた画面を返してしまう)
const cacheable = (res) => Boolean(res) && res.ok && !res.redirected

/**
 * /offline の HTML とその参照アセット (遅延 chunk / CSS / フォント) を precache に保存する。
 * HTML だけを precache すると、/offline を一度もオンラインで開いていない端末で
 * ハイドレーション時の遅延 chunk 取得が失敗し、ChunkLoadError → error boundary に
 * 化けてしまう (実機検証で確認済み)。あわせて旧ビルドのアセットを掃除する
 * (precache は FIFO トリム対象外のため、ここで明示的に削除しないと際限なく溜まる)。
 */
async function precacheOfflineDocument(cache, res) {
  const html = await res.clone().text()
  const assetUrls = extractAssetUrls(html)
  await Promise.all(
    assetUrls.map(async (url) => {
      try {
        // ハッシュ付き URL は内容不変のため、既存エントリは再取得しない
        if (await cache.match(url)) return
        const assetRes = await fetch(url)
        if (cacheable(assetRes)) {
          await cache.put(url, assetRes)
        } else {
          console.warn("[sw] offline アセット precache スキップ:", url, assetRes.status)
        }
      } catch (err) {
        console.warn("[sw] offline アセット precache 失敗:", url, err)
      }
    })
  )
  await cache.put("/offline", res)
  // 旧ビルドの /_next/static/ アセットを削除
  const keys = await cache.keys()
  const valid = new Set(assetUrls)
  await Promise.all(
    keys
      .filter((request) => {
        const pathname = new URL(request.url).pathname
        return pathname.startsWith("/_next/static/") && !valid.has(pathname)
      })
      .map((request) => cache.delete(request))
  )
}

// ───────────────────────── ライフサイクル ─────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAMES.precache)
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            // cache: "reload" で HTTP キャッシュをバイパスし常に新鮮なレスポンスを取得
            const res = await fetch(url, { cache: "reload" })
            // cacheable チェックにより、proxy の認証 redirect (/login) を
            // /offline 等として誤保存しない (matcher 除外と合わせた二重防御)
            if (!cacheable(res)) {
              console.warn("[sw] precache スキップ (非 cacheable):", url, res.status)
              return
            }
            if (url === "/offline") {
              await precacheOfflineDocument(cache, res)
            } else {
              await cache.put(url, res)
            }
          } catch (err) {
            // install 時にオフライン等で取得できなくても SW 自体は有効化する
            // (/offline は maybeRefreshOffline() が次のオンライン時に自己修復する)
            console.warn("[sw] precache 失敗:", url, err)
          }
        })
      )
      await self.skipWaiting()
    })()
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 旧バージョンの irori-* キャッシュを全削除 (他アプリのキャッシュには触れない)
      const names = await caches.keys()
      const valid = Object.values(CACHE_NAMES)
      await Promise.all(
        names
          .filter((name) => name.startsWith(PREFIX) && !valid.includes(name))
          .map((name) => caches.delete(name))
      )
      await self.clients.claim()
    })()
  )
})

// ───────────────────────── fetch ハンドラ ─────────────────────────

/** precache の /offline。無ければ最終フォールバックの 503 plain text */
async function offlineFallback() {
  const cache = await caches.open(CACHE_NAMES.precache)
  const cached = await cache.match("/offline")
  if (cached) return cached
  return new Response("オフラインです", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}

/**
 * precache 内の /offline が古い (24h 超 or 欠落) ならオンライン時に再取得する。
 * デプロイで /offline の参照する CSS 等が変わっても、長期間古い HTML が残らないようにする。
 */
async function maybeRefreshOffline() {
  try {
    const cache = await caches.open(CACHE_NAMES.precache)
    const cached = await cache.match("/offline")
    if (cached) {
      const dateHeader = cached.headers.get("date")
      if (dateHeader) {
        const age = Date.now() - new Date(dateHeader).getTime()
        if (age >= 0 && age <= OFFLINE_MAX_AGE_MS) return
      }
    }
    const res = await fetch("/offline", { cache: "reload" })
    if (cacheable(res)) {
      // 新ビルドの参照アセットも含めて更新する
      await precacheOfflineDocument(cache, res)
    }
  } catch {
    // オフライン時の正常系: 次のオンライン時の document リクエストで再試行される
  }
}

/** APP_PAGES への navigate: network-first → cache → /offline */
async function handleDocument(request) {
  const cache = await caches.open(CACHE_NAMES.documents)
  const key = makeCacheKey(request.url)
  try {
    const res = await fetch(request)
    const contentType = res.headers.get("content-type") || ""
    // text/html のみ保存 (redirect は cacheable が弾く)
    if (cacheable(res) && contentType.includes("text/html")) {
      await cache.put(key, res.clone())
      await trimCache(CACHE_NAMES.documents, MAX_ENTRIES.documents)
    }
    return res
  } catch (err) {
    const cached = await cache.match(key)
    if (cached) return cached
    console.warn("[sw] document オフラインフォールバック:", request.url, err)
    return offlineFallback()
  }
}

/**
 * APP_PAGES への RSC fetch: network-first → cache → reject。
 * キャッシュミス時に /offline の HTML を flight payload として返してはならない
 * (Next のルーターが壊れる)。reject すると Next が location.href への
 * ハードナビゲーションにフォールバックし、documents 経路 (handleDocument) で回復する。
 */
async function handleRsc(request) {
  const cache = await caches.open(CACHE_NAMES.rsc)
  const key = makeCacheKey(request.url)
  try {
    const res = await fetch(request)
    const contentType = res.headers.get("content-type") || ""
    // RSC flight payload (text/x-component) のみ保存
    if (cacheable(res) && contentType.includes("text/x-component")) {
      await cache.put(key, res.clone())
      await trimCache(CACHE_NAMES.rsc, MAX_ENTRIES.rsc)
    }
    return res
  } catch (err) {
    const cached = await cache.match(key)
    if (cached) return cached
    throw err
  }
}

/** precached / static / image: cache-first (miss 時のみネットワーク) */
async function cacheFirst(request, cacheName, max) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  // precache にピン留めされたアセット (/offline の参照 chunk 等) も照会する
  if (cacheName !== CACHE_NAMES.precache) {
    const precache = await caches.open(CACHE_NAMES.precache)
    const precached = await precache.match(request)
    if (precached) return precached
  }
  const res = await fetch(request)
  if (cacheable(res)) {
    await cache.put(request, res.clone())
    await trimCache(cacheName, max)
  }
  return res
}

self.addEventListener("fetch", (event) => {
  const kind = classifyRequest(event.request, self.location.href)
  if (kind === null) return // SW 不関与 (別オリジン / 非 GET / api 等)

  switch (kind) {
    case "document":
      // ついでに /offline の鮮度を保つ (レスポンスはブロックしない)
      event.waitUntil(maybeRefreshOffline())
      event.respondWith(handleDocument(event.request))
      break
    case "rsc":
      event.respondWith(handleRsc(event.request))
      break
    case "nav-passthrough":
      // 認証系ページ: キャッシュは一切せず、オフライン時のみ /offline を表示
      event.respondWith(fetch(event.request).catch(() => offlineFallback()))
      break
    case "precached":
      event.respondWith(cacheFirst(event.request, CACHE_NAMES.precache))
      break
    case "static":
      event.respondWith(cacheFirst(event.request, CACHE_NAMES.static, MAX_ENTRIES.static))
      break
    case "image":
      event.respondWith(cacheFirst(event.request, CACHE_NAMES.images, MAX_ENTRIES.images))
      break
  }
})

// ───────────────────────── message ハンドラ ─────────────────────────

// 別ユーザーのログイン・ログアウト時に世帯データ入りキャッシュ (documents / rsc) を
// 破棄する。static / images / precache は個人データを含まないため残す。
self.addEventListener("message", (event) => {
  const data = event.data
  if (!data || data.type !== "PURGE_HOUSEHOLD_CACHES") return
  event.waitUntil(
    (async () => {
      await Promise.all([
        caches.delete(CACHE_NAMES.documents),
        caches.delete(CACHE_NAMES.rsc),
      ])
      if (event.ports && event.ports[0]) {
        event.ports[0].postMessage({ ok: true })
      }
    })()
  )
})

// ───────────────────────── テストフック ─────────────────────────
// vitest (node:vm) から純粋関数を検証するための公開。実行時挙動には影響しない。
self.__TEST_HOOKS__ = {
  classifyRequest,
  makeCacheKey,
  trimCache,
  extractAssetUrls,
  CACHE_NAMES,
  APP_PAGES,
  PRECACHE_URLS,
}
