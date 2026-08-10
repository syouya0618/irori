/*
 * irori Service Worker — runtime-cache 型オフライン対応 (network-first)
 *
 * 方針:
 * - オンラインで訪問済みの APP_PAGES の HTML / RSC payload をオフラインでも閲覧可能にする
 * - 復帰後は network-first により常に最新を取得してキャッシュを更新する
 * - 別オリジン (Supabase 等) と非 GET (Server Action POST) は一切触らない
 * - オフライン書き込みはスコープ外
 * - **Push 通知**: push / notificationclick / pushsubscriptionchange を扱う。
 *   受け取ったら**必ず可視通知を出すこと** — 出さねば Safari が権限を剥奪する。
 */

// キャッシュスキーマ (キャッシュ名・分類ロジック・キー形式) を変更した時のみ手動で bump する。
// bump すると activate 時に旧バージョンのキャッシュが全削除される。
//
// B-6 で document のキー形式を変えた (`?date=` を落とす) が **bump しておらぬ**。
// 新しいキーは旧キーの**部分集合**（クエリを 1 つ減らすだけ）ゆえ、既存端末の
// `/meals` 等のエントリは今のキーでもそのまま当たる。`?date=` 付きの document を
// 作る版は一度も配っておらぬ（この PR が初出）ゆえ、旧スキーマの残骸も存在せぬ。
// 一方 bump すれば全端末のオフラインキャッシュを無駄に捨てることになる。
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
// src/lib/constants/pages.ts の VALID_PAGES (+ /settings, /calendar) と手動同期すること。
// (classic script のため import できない — ページ追加時はここも更新する)
const APP_PAGES = ["/meals", "/shopping", "/stock", "/baby", "/calendar", "/settings"]

// 通知の着地日を運ぶクエリ名 (B-6)。document キャッシュのキーからはこれを落とす
// (→ makeDocumentCacheKey)。src/lib/domain/calendar-link.ts の CALENDAR_DATE_PARAM と
// **手動同期**すること (classic script ゆえ import できぬ。APP_PAGES と同じ約束じゃ)。
// 綻びは sw-logic.test.ts が両者の一致を assert して殺しておる。
const CALENDAR_DATE_PARAM = "date"

// install 時に precache する静的リソース
//
// ⚠️ **`/manifest.webmanifest` をここへ戻してはならぬ。**
//
// precache は cache-first で配られ (`cacheFirst` はヒットしたら二度と再検証せぬ)、
// 中身が更新されるのは `install` の時だけ ——そして `install` が再実行されるのは
// **sw.js のバイト列が変わった時だけ**じゃ。manifest だけを直して配っても、
// 既存端末には**永久に古い manifest が配られ続ける**。
//
// これは机上の話ではない。2026-08-10 に実際に起きた: `start_url` を `/meals` から
// `/` へ直した (#219) のに、ホーム画面から起動すると必ず献立が開いたままじゃった。
// `start_url` は「ホーム画面へ追加した時」に端末へ焼き付くため入れ直しが要るが、
// **入れ直しても直らなんだ** —— その瞬間に OS が読む manifest を、SW が古い方に
// すり替えておったゆえ。**自分で自分の直し方を塞ぐ形**になっておった。
//
// 「manifest の取得が SW を通る」ことは実測で確認済み (Chrome, 2026-08-10):
// precache の該当エントリを削除 → ページ再読込 → **エントリが戻った**
// (`cacheFirst` の miss → network → put)。
//
// 外して失うものは無い。manifest が要るのは install / 起動時の判断の時だけで、
// その時ネットワークが無ければ、そもそもインストールも更新も起きぬ。
const PRECACHE_URLS = [
  "/offline",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
]

/**
 * 過去に precache へ入れてしまい、**もう二度と入れてはならぬ** URL。
 * activate で明示的に削除する（`classifyRequest` はもうここへ振らぬゆえ実害は
 * 消えるが、毒入りのエントリを残しておくと、将来 precache を横断照会する経路が
 * 増えた時に黙って復活する）。
 */
const PRECACHE_EVICT_URLS = ["/manifest.webmanifest"]

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
 * **document** キャッシュ専用のキー。`makeCacheKey` に加えて `?date=` も落とす。
 *
 * 通知の着地先は `/calendar?date=YYYY-MM-DD` じゃ (B-6)。生の URL をキーにすると
 * 1 つの変更で 2 つ壊れる:
 *   (a) オフラインで cached の `/calendar` に**構造的に当たらぬ** → `/offline` が出る。
 *       通知タップは最も圏外になりやすい瞬間ゆえ、これは実害じゃ。
 *   (b) キーの濃度が日付ぶん無制限に増える → documents は上限 16 の FIFO ゆえ、
 *       毎朝のまとめを 16 回叩くだけで /meals /shopping … が全て追い出される。
 *       しかも居座るのは「二度と開かぬ過去の日付」＝キャッシュとして無価値。
 * 日付はサーバが描く**中身**の違いでしかない。ゆえに保存されるのは
 * 「最後にオンラインで開いた日のカレンダー」となり、オフラインでは指された日と
 * 違う日が映りうる —— それは承知のうえの退化じゃ。オフラインに指定日の HTML は
 * そもそも存在せぬゆえ、選択肢は「別の日のカレンダー」か「/offline 画面」しかない。
 *
 * ⚠️ **`makeCacheKey` 側で落としてはならぬ。** あちらは `handleRsc` が共有しており、
 * 日を落とすと**別の日の flight payload** をルーターへ返して無音で違う日を描く
 * （今より悪い）。ゆえに document 限定の関数として分けておる。
 */
function makeDocumentCacheKey(rawUrl) {
  const url = new URL(makeCacheKey(rawUrl))
  url.searchParams.delete(CALENDAR_DATE_PARAM)
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

      // かつて precache へ入れてしまった毒入りエントリを掃く。
      // CACHE_VERSION を bump すれば同時に消えるが、bump は**全端末の
      // オフライン用ドキュメントを巻き添えで捨てる** —— 1 ファイルを直すために
      // 払う代償として重すぎるゆえ、名指しで消す方を採った。
      const precache = await caches.open(CACHE_NAMES.precache)
      await Promise.all(PRECACHE_EVICT_URLS.map((url) => precache.delete(url)))

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

/**
 * APP_PAGES への navigate: network-first → cache → /offline。
 *
 * キーは `makeDocumentCacheKey` (＝ `?date=` を落とす)。**put と match の両方で
 * 同じ関数を使うこと** — 片方だけ直すと「保存はするのに当たらぬ」or
 * 「当たるのに濃度が増える」のどちらかが残る。
 */
async function handleDocument(request) {
  const cache = await caches.open(CACHE_NAMES.documents)
  const key = makeDocumentCacheKey(request.url)
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

// ───────────────────────── push ハンドラ ─────────────────────────

// 着地先が読めぬ通知（旧いペイロード・壊れた data）の退化先。
// src/lib/domain/calendar-link.ts の CALENDAR_PATH と**手動同期**すること
// (classic script ゆえ import できぬ。APP_PAGES と同じ約束じゃ)。
// **push ハンドラより前に置く**: 下の notificationclick 節へ戻すと、`const` の
// TDZ ゆえ「評価中に読む」経路を将来足した瞬間に落ちる。
const DEFAULT_NOTIFICATION_URL = "/calendar"

// ⚠️ **受け取ったら必ず可視通知を出すこと。** Apple 公式:
//   "Safari doesn't support invisible push notifications. ... If you don't
//    [present immediately], Safari revokes the push notification permission
//    for your site."
// ペイロードが壊れていても・空でも、汎用文言で必ず showNotification する。
// ここで例外を投げたり無言で return したりすると、権限そのものを失う。
function parsePushPayload(event) {
  const fallback = { title: "irori", body: "新しいお知らせがあります" }
  if (!event || !event.data) return fallback
  try {
    const parsed = event.data.json()
    if (!parsed || typeof parsed !== "object") return fallback
    return {
      title: typeof parsed.title === "string" && parsed.title ? parsed.title : fallback.title,
      body: typeof parsed.body === "string" && parsed.body ? parsed.body : fallback.body,
      url: typeof parsed.url === "string" ? parsed.url : undefined,
      tag: typeof parsed.tag === "string" ? parsed.tag : undefined,
    }
  } catch {
    // json() が落ちたらテキストとして拾う。それも駄目なら汎用文言。
    try {
      const text = event.data.text()
      return text ? { ...fallback, body: text } : fallback
    } catch {
      return fallback
    }
  }
}

self.addEventListener("push", (event) => {
  const payload = parsePushPayload(event)
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: payload.tag,
      // B-6: `url` は `?date=` を含む（`calendarUrlForDate()`）。既定値は
      // `notificationTargetUrl` と同じ定数を使う（綴りを 2 箇所に持たぬ）。
      data: { url: payload.url || DEFAULT_NOTIFICATION_URL },
    })
  )
})

/**
 * 通知の着地先 URL。`push` が `data.url` へ入れた値をそのまま使う。
 *
 * サーバは `calendarUrlForDate()` で `/calendar?date=YYYY-MM-DD` を組む（B-6）。
 * **この関数がクエリを落とすと、通知は正しい日を運んでおるのに今日が開く** ——
 * ゆえに pathname だけを取り出すような「正規化」を足してはならぬ。
 */
function notificationTargetUrl(notification) {
  const url = notification && notification.data && notification.data.url
  return typeof url === "string" && url ? url : DEFAULT_NOTIFICATION_URL
}

/**
 * 通知タップの本体。**既存タブがあっても必ず `navigate` まで行う**のが要点じゃ。
 *
 * `focus()` だけでは開いておるタブがそのまま前に出るだけで、URL は動かぬ。
 * 「前日20時」の通知や毎朝のまとめは**今日でない日**を指すゆえ、focus だけでは
 * 主は違う日のカレンダーを見せられる（B-6 の直す対象そのものじゃ）。
 *
 * navigate は SW に制御されておらぬ client では reject する。そのときは focus だけで
 * 諦める —— ここで `openWindow` へ落とすとタブが二重に開く（同じ画面が 2 つ並ぶ
 * 方が、日付が動かぬより始末が悪い）。ただし**黙って諦めてはならぬ**:
 * 「通知を叩いたのに日が動かぬ」を後から追える唯一の証跡ゆえ warn を残す。
 */
async function handleNotificationClick(event) {
  // async 関数の body は最初の await までは同期に走る。ゆえにここで閉じてよい
  // （通知はタップ直後に消えねば、押しても残るように見える）。
  if (event && event.notification && typeof event.notification.close === "function") {
    event.notification.close()
  }
  const target = notificationTargetUrl(event && event.notification)
  const clientList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  })
  for (const client of clientList) {
    if ("focus" in client) {
      await client.focus()
      // 既存タブは focus しても日付が動かぬため navigate まで行う
      if ("navigate" in client) {
        try {
          await client.navigate(target)
        } catch (err) {
          console.warn("[sw] 既存タブを navigate できなかった:", target, err)
        }
      } else {
        console.warn("[sw] client.navigate が無く日付を動かせなかった:", target)
      }
      return
    }
  }
  await self.clients.openWindow(target)
}

self.addEventListener("notificationclick", (event) => {
  event.waitUntil(handleNotificationClick(event))
})

// ─────────────────── pushsubscriptionchange (失効処理・B-4) ───────────────────

// ⚠️ **拾わねば購読が黙って死ぬ。** Chrome / Android はブラウザ都合で購読を回す
// (鍵の更新・ストレージ逼迫・長期未使用など)。その瞬間に古い endpoint は 410 になり、
// 配信ジョブが DB 行を消す。ここで新しい購読を登録し直さねば、主は「いつの間にか
// 通知が来なくなった」としか分からぬ。
//
// SW から Server Action は呼べぬ (RSC のプロトコルに乗らぬ) ゆえ、セッション認証の
// Route Handler へ POST する。SW の fetch は cookie を運ぶため、これで足りる。
// パスは src/app/api/push/resubscribe/route.ts と**手動同期**すること
// (classic script ゆえ import できぬ。APP_PAGES と同じ約束じゃ)。
const RESUBSCRIBE_PATH = "/api/push/resubscribe"

/**
 * 購読 JSON からサーバへ送る body を組む。3 つ揃わねば null (送らぬ)。
 * `oldEndpoint` は**新しい endpoint と違う時だけ**載せる (同じなら消す対象が無い)。
 *
 * ⚠️ **`userAgent` を必ず載せること。** `upsert_push_subscription` は
 * `ON CONFLICT ... SET user_agent = EXCLUDED.user_agent` ゆえ、省くと既存行の
 * 端末名が NULL で潰れ、設定カードの全端末が「不明な端末」に化ける
 * (どれを解除すればよいか主に分からなくなる)。
 */
function buildResubscribeBody(subscriptionJson, oldEndpoint, userAgent) {
  if (!subscriptionJson) return null
  const endpoint = subscriptionJson.endpoint
  const keys = subscriptionJson.keys || {}
  if (!endpoint || !keys.p256dh || !keys.auth) return null
  const body = { endpoint, p256dh: keys.p256dh, auth: keys.auth }
  if (typeof userAgent === "string" && userAgent) body.userAgent = userAgent
  if (typeof oldEndpoint === "string" && oldEndpoint && oldEndpoint !== endpoint) {
    body.oldEndpoint = oldEndpoint
  }
  return body
}

/**
 * ⚠️ **`res.ok` を成功の証拠にしてはならぬ。**
 *
 * このパスは `src/proxy.ts` の承認ゲートを通る (`isPublicRoute` に入れておらぬ
 * ＝ 認証が要るゆえ正しい)。セッション切れなら proxy は `/login` へ、未承認なら
 * `/pending-approval` へ **307 redirect** を返す。fetch は既定でそれを追い、
 * **HTML の 200** が返る — `res.ok` は true じゃ。信じれば「登録された」と
 * 記録して何も登録されておらぬ。
 * ゆえに (a) `redirect: "manual"` で追わせず (b) JSON の `{ ok: true }` を確かめる。
 */
async function isResubscribeAccepted(res) {
  if (!res || res.status !== 200) return false
  const contentType = (res.headers && res.headers.get("content-type")) || ""
  if (!contentType.includes("application/json")) return false
  try {
    const body = await res.json()
    return Boolean(body && body.ok === true)
  } catch (err) {
    console.warn("[sw] 再登録の応答を JSON として読めなかった:", err)
    return false
  }
}

/**
 * 新しい購読を得る。3 段構え:
 *   1. `event.newSubscription` (仕様どおりの実装。Chrome はこれを渡す)
 *   2. 既に張り直されておればそれ (`getSubscription()`)
 *   3. 旧購読の `applicationServerKey` で subscribe し直す
 *      (Firefox 等はイベントに何も載せぬため、鍵の出所がここしかない)
 *
 * 3 つとも取れねば null を返して**何もせぬ**。ここで推測の鍵を使って subscribe
 * すると、送信が全て 403 になる購読を自分で作ることになる。復旧は起動時の
 * 突き合わせ (`push-subscription-reconciler.tsx`) が担う。
 */
async function resolveChangedSubscription(event) {
  if (event && event.newSubscription) return event.newSubscription
  const existing = await self.registration.pushManager.getSubscription()
  if (existing) return existing
  const oldOptions = event && event.oldSubscription && event.oldSubscription.options
  const applicationServerKey = oldOptions && oldOptions.applicationServerKey
  if (!applicationServerKey) return null
  return self.registration.pushManager.subscribe({
    // Safari は不可視 push を許さぬ。登録時と同じ条件で張り直す。
    userVisibleOnly: true,
    applicationServerKey,
  })
}

async function handlePushSubscriptionChange(event) {
  try {
    const subscription = await resolveChangedSubscription(event)
    if (!subscription) {
      console.warn("[sw] pushsubscriptionchange: 新しい購読を作れなかった")
      return
    }
    const oldEndpoint =
      (event && event.oldSubscription && event.oldSubscription.endpoint) || null
    // WorkerNavigator も userAgent を持つ。取れねば null で退化させる。
    const userAgent = (self.navigator && self.navigator.userAgent) || null
    const body = buildResubscribeBody(subscription.toJSON(), oldEndpoint, userAgent)
    if (!body) {
      console.warn("[sw] pushsubscriptionchange: 購読情報が欠けておる")
      return
    }
    const res = await fetch(RESUBSCRIBE_PATH, {
      method: "POST",
      credentials: "same-origin",
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!(await isResubscribeAccepted(res))) {
      // ⚠️ ここで購読を消したり unsubscribe したりせぬ。認証切れ・一時障害でも
      // 同じ経路を通るゆえ、破棄は不可逆な過剰反応じゃ (「破棄は狭く」)。
      // 次にアプリを開いた時の突き合わせが拾い直す。
      console.warn(
        "[sw] 購読の再登録が受理されなかった:",
        res ? res.status : "応答なし",
      )
    }
  } catch (err) {
    // 握り潰さぬ。ここが唯一の証跡じゃ (endpoint は出さぬ)。
    console.warn("[sw] pushsubscriptionchange の処理に失敗:", err)
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handlePushSubscriptionChange(event))
})

// ───────────────────────── テストフック ─────────────────────────
// vitest (node:vm) から純粋関数を検証するための公開。実行時挙動には影響しない。
self.__TEST_HOOKS__ = {
  classifyRequest,
  makeCacheKey,
  makeDocumentCacheKey,
  // B-6: document キャッシュ本体。純粋関数だけ公開しておると
  // 「通知の着地先は縛れておるのに、その着地を描く経路は無検査」になる
  // （オフラインで /offline が出る・他ページが追い出される、が両方緑で通る）。
  handleDocument,
  trimCache,
  extractAssetUrls,
  parsePushPayload,
  notificationTargetUrl,
  handleNotificationClick,
  buildResubscribeBody,
  isResubscribeAccepted,
  handlePushSubscriptionChange,
  CACHE_NAMES,
  MAX_ENTRIES,
  APP_PAGES,
  PRECACHE_URLS,
  PRECACHE_EVICT_URLS,
  RESUBSCRIBE_PATH,
  DEFAULT_NOTIFICATION_URL,
  CALENDAR_DATE_PARAM,
}
