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
// `/baby` 等のエントリは今のキーでもそのまま当たる。`?date=` 付きの document を
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
  // 世帯キャッシュの持ち主の記録（→ CACHE_OWNER_KEY）。版を持たせぬのは、キャッシュの
  // 形を変えて版を上げても「今この端末を使っておる利用者」は変わらぬゆえ。ここに載せて
  // おかねば activate が未知の irori-* として消し、SW を更新するたびに持ち主が消える。
  meta: `${PREFIX}meta`,
}

// ───────── 世帯キャッシュ（documents / rsc）の持ち主（共用端末の分離） ─────────
//
// 共用端末で A がログアウトして B がログインしても、B のオフライン閲覧に A の世帯を出さぬ。
// 破棄（PURGE_HOUSEHOLD_CACHES）だけでは足りぬ: 破棄の**後**に届いた A の古い応答
// （破棄の前に出た要求の遅延応答・破棄から signOut の完了までに別タブが A の cookie で
// 出した要求）が再び保存され、B のオフライン閲覧に出る。破棄そのものが失敗した端末でも出る。
//
// ゆえに二つを突き合わせる（どちらも src/lib/pwa/sw-messages.ts と**手動同期**）:
//   - 応答の主: src/proxy.ts が承認ゲートを通った応答にだけ載せる CACHE_OWNER_HEADER
//     （検証済みの user id）。SW は cookie を読めぬゆえ、主はサーバに決めさせる。
//     クライアントの記録から主を推してはならぬ — セッションが破棄なしで終わった後
//     （他端末からのサインアウト・失効）、次の利用者の着地 HTML が guard より先に SW を
//     通り、前の利用者の名で保存される（独立レビュー r1 で確認した漏れ）。
//   - 持ち主の記録（CACHE_OWNER_KEY）: この端末で今オフライン閲覧を許す利用者。ページの
//     CacheUserGuard が書き、ログアウト・利用者の交代で消す。
// 保存: 応答の主が在り、かつ今の記録と一致する時だけ（主の無い応答・記録と違う主の応答・
//   記録が無い間の応答は保存せぬ）。
// 配信: 項目の主が**今の**記録と一致する時だけ。一致せねば無いものとして扱い、消す。
// **荷重を担うのは配信時の照合じゃ。** 保存の直前の確認と put の間に交代が挟まっても、
// その項目は前の利用者の主のまま残り、配られぬ。主の無い旧版の項目も配られぬ。
const CACHE_OWNER_KEY = "/__irori/cache-owner"
const CACHE_OWNER_HEADER = "x-irori-cache-owner"

// オフライン閲覧を許可する認証済みページ。
// src/lib/constants/pages.ts の VALID_PAGES (+ /settings) と手動同期すること。
// (classic script のため import できない — ページ追加時はここも更新する)
const APP_PAGES = ["/baby", "/calendar", "/settings"]

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
// `/` へ直した (#219) のに、ホーム画面から起動すると必ず当時の献立ページが開いたままじゃった。
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
 *       毎朝のまとめを 16 回叩くだけで /baby /settings … が全て追い出される。
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
// HTML を /baby として保存すると、オフライン時に壊れた画面を返してしまう)
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
 * 持ち主の記録を消す（以後、前の主の項目は誰にも配られぬ）。サーバの応答が「記録の主は
 * もうこの端末のセッションに居らぬ」と示した時に呼ぶ。アプリの破棄（ログアウト・利用者の
 * 交代）を経ずにセッションが終わる経路 — 他端末からのサインアウト・失効 — では、記録と
 * 項目が残ったままになり、オフラインで端末を手にした者に配られうるゆえ。
 */
async function clearCacheOwner(reason) {
  try {
    const meta = await caches.open(CACHE_NAMES.meta)
    if (await meta.delete(CACHE_OWNER_KEY)) {
      console.warn("[sw] 世帯キャッシュの持ち主の記録を消した:", reason)
    }
  } catch (err) {
    console.warn("[sw] 世帯キャッシュの持ち主の記録を消せず:", err)
  }
}

/**
 * 応答が /login に着いた（= この端末にセッションが無い）なら、持ち主の記録を消す。
 * proxy は未認証の要求を /login へ送り、ログイン済みの /login は既定ページへ送るゆえ、
 * 「/login に着いた」は「セッションが無い」と同じじゃ。ナビゲーションの redirect は
 * ブラウザが追い（SW 内の fetch は redirect: "manual"）、/login の遷移が改めて
 * nav-passthrough を通る。RSC の fetch は redirect を追い、res.url が /login になる。
 */
async function revokeOwnerIfSignedOut(res) {
  if (!res || !res.ok || !res.url) return
  let pathname
  try {
    pathname = new URL(res.url).pathname
  } catch {
    return
  }
  if (pathname === "/login") await clearCacheOwner("セッション無し")
}

/** 認証系ページ: キャッシュは一切せず、オフライン時のみ /offline を表示 */
async function handleNavPassthrough(request) {
  let res
  try {
    res = await fetch(request)
  } catch {
    return offlineFallback()
  }
  await revokeOwnerIfSignedOut(res)
  return res
}

/**
 * 世帯キャッシュの今の持ち主（無ければ null）。読めぬ時も null（＝保存も配信もせぬ側へ倒す）。
 */
async function readCacheOwner() {
  try {
    const meta = await caches.open(CACHE_NAMES.meta)
    const res = await meta.match(CACHE_OWNER_KEY)
    if (!res) return null
    const owner = (await res.text()).trim()
    return owner || null
  } catch (err) {
    console.warn("[sw] 世帯キャッシュの持ち主を読めず（保存も配信もせぬ）:", err)
    return null
  }
}

/**
 * 世帯キャッシュへ保存する。応答の主（proxy が載せる CACHE_OWNER_HEADER）が在り、かつ
 * 今の持ち主の記録と一致する時だけ（主の無い応答・記録が無い間・記録と違う主 — ログアウト
 * の最中や、交代の直後で guard がまだ記録を書いておらぬ着地 — は保存せぬ）。応答は主の
 * ヘッダを持ったまま保存され、配信時の照合（matchOwned）にそのまま使われる。
 * 保存の失敗は握って警告に残す（保存できぬことを理由に、届いた応答まで捨てて
 * オフライン扱いにせぬ）。
 */
async function putOwned(cacheName, key, res, max, recordedAtStart) {
  const owner = res.headers.get(CACHE_OWNER_HEADER)
  if (!owner) return
  try {
    const recorded = await readCacheOwner()
    if (recorded !== owner) {
      console.warn("[sw] 応答の主が今の持ち主と違うため保存せず:", key)
      // 記録が通信の間ずっと同じなのに、別の利用者のセッションで応答が返った = 記録の主は
      // もうこの端末のセッションに居らぬ（破棄を経ずに終わった後の交代）。guard が記録を
      // 書き直す前でも、前の主の項目を配らぬよう記録を消す。
      // 通信の間に記録が変わっておれば（交代の前に出た要求の遅延応答）消さぬ — 新しい
      // 持ち主の正しい記録まで消すことになる（独立レビュー r3）
      if (recorded && recorded === recordedAtStart) {
        await clearCacheOwner("別の利用者の応答")
      }
      return
    }
    const cache = await caches.open(cacheName)
    await cache.put(key, res)
    await trimCache(cacheName, max)
  } catch (err) {
    console.warn("[sw] 世帯キャッシュへの保存に失敗:", key, err)
  }
}

/**
 * 世帯キャッシュから、主が今の持ち主と一致する項目だけを返す（無ければ undefined）。
 * 主の違う・主の無い項目は配らず、ついでに消す（前の利用者のデータを残さぬ）。
 */
async function matchOwned(cacheName, key) {
  const owner = await readCacheOwner()
  if (!owner) return undefined
  const cache = await caches.open(cacheName)
  const cached = await cache.match(key)
  if (!cached) return undefined
  if (cached.headers.get(CACHE_OWNER_HEADER) !== owner) {
    await cache.delete(key)
    return undefined
  }
  return cached
}

/**
 * APP_PAGES への navigate: network-first → cache → /offline。
 *
 * キーは `makeDocumentCacheKey` (＝ `?date=` を落とす)。**put と match の両方で
 * 同じ関数を使うこと** — 片方だけ直すと「保存はするのに当たらぬ」or
 * 「当たるのに濃度が増える」のどちらかが残る。
 */
async function handleDocument(request) {
  const key = makeDocumentCacheKey(request.url)
  // 要求を出す前の記録（putOwned が「通信の間に記録が変わったか」を見分けるため）
  const recordedAtStart = await readCacheOwner()
  try {
    const res = await fetch(request)
    const contentType = res.headers.get("content-type") || ""
    // text/html のみ保存 (redirect は cacheable が弾く)
    if (cacheable(res) && contentType.includes("text/html")) {
      await putOwned(
        CACHE_NAMES.documents,
        key,
        res.clone(),
        MAX_ENTRIES.documents,
        recordedAtStart
      )
    }
    return res
  } catch (err) {
    const cached = await matchOwned(CACHE_NAMES.documents, key)
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
  const key = makeCacheKey(request.url)
  // 要求を出す前の記録（handleDocument と同じ）
  const recordedAtStart = await readCacheOwner()
  try {
    const res = await fetch(request)
    // セッションが切れておれば /login へ redirect される（RSC の fetch はそれを追う）
    await revokeOwnerIfSignedOut(res)
    const contentType = res.headers.get("content-type") || ""
    // RSC flight payload (text/x-component) のみ保存
    if (cacheable(res) && contentType.includes("text/x-component")) {
      await putOwned(CACHE_NAMES.rsc, key, res.clone(), MAX_ENTRIES.rsc, recordedAtStart)
    }
    return res
  } catch (err) {
    const cached = await matchOwned(CACHE_NAMES.rsc, key)
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
      // 認証系ページ: キャッシュは一切せず、オフライン時のみ /offline を表示。
      // /login に着いたら持ち主の記録を消す（→ revokeOwnerIfSignedOut）
      event.respondWith(handleNavPassthrough(event.request))
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
//
// ⚠️ **失敗も ack で返すこと。** ページ側 (src/lib/pwa/sw-messages.ts) は `ok` を読み、
// true の時だけ LAST_USER_ID を消す。黙って ack を出さねば、ページはタイムアウトまで
// 待たされた末に「確かめられぬ」へ倒れるしかない (P2-24)。
//
// 持ち主の記録を**先に**消す（以後は保存も配信もせぬ）。消してから破棄するゆえ、破棄の
// 最中・後に届いた前の利用者の応答は保存されず、残っても配られぬ。
self.addEventListener("message", (event) => {
  const data = event.data
  if (!data || data.type !== "PURGE_HOUSEHOLD_CACHES") return
  const port = event.ports && event.ports[0]
  event.waitUntil(
    (async () => {
      let ok = false
      try {
        const meta = await caches.open(CACHE_NAMES.meta)
        await meta.delete(CACHE_OWNER_KEY)
        await Promise.all([
          caches.delete(CACHE_NAMES.documents),
          caches.delete(CACHE_NAMES.rsc),
        ])
        ok = true
      } catch (err) {
        console.warn("[sw] 世帯キャッシュの破棄に失敗:", err)
      }
      if (port) port.postMessage({ ok })
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
  CACHE_OWNER_KEY,
  CACHE_OWNER_HEADER,
  MAX_ENTRIES,
  APP_PAGES,
  PRECACHE_URLS,
  PRECACHE_EVICT_URLS,
  RESUBSCRIBE_PATH,
  DEFAULT_NOTIFICATION_URL,
  CALENDAR_DATE_PARAM,
}
