/**
 * 共用端末のオフラインキャッシュ分離（PR #235 敵対レビュー P2）。
 *
 * ## 何を撃つか
 * 実物の `public/sw.js`（node:vm で評価し、fetch / message リスナを直に叩く）と、実物の
 * `sw-messages`（ページからの破棄）・`CacheUserGuard`・`SettingsContent`（ログアウト）を、
 * **一つの CacheStorage の代役**に噛み合わせる。ページと SW は同じ origin の CacheStorage を
 * 共有するゆえ、ここでも同じ store を両方へ渡す。ネットワークの代役は「要求を出した瞬間の
 * cookie の持ち主」の世帯を本文に返す（応答の中身は送った時点のセッションで決まる）。
 * 応答には src/proxy.ts と同じく、その主（検証済みの user id）を `x-irori-cache-owner` で
 * 載せる（proxy 側の契約は src/__tests__/proxy.test.ts が固定する）。
 *
 * 検査の対象は「キャッシュを消せたか」ではなく、**消した後に届いた古い応答が再び保存され、
 * 次の利用者 B のオフライン閲覧に A の世帯が出ぬか**じゃ。
 *
 * ## Cache API の二つの振る舞い
 * 仕様では、`caches.delete(name)` の後も既に開かれた Cache の参照は使え、そこへの put は
 * 名前から切り離された（もう `open(name)` では見えぬ）キャッシュへ入る（"orphan"）。
 * 実装がこれに従わず、名前で同じキャッシュへ書き戻る場合（"name-bound"）も想定し、
 * 両方で同じ不変条件を確かめる — 修正が仕様の細部（切り離し）に依存せぬことの証拠。
 *
 * jsdom には Service Worker が無い。ゆえに既定ではページは SW に**制御されておらず**
 * （`navigator.serviceWorker` 無し）、破棄はページからの直の Cache API だけで行われる。
 * SW へ PURGE を送る経路は最後の it で controller を立てて撃つ。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Component, type ReactNode } from "react"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react"

const signOut = vi.fn()
vi.mock("@/app/(main)/settings/actions", () => ({
  signOut: (...args: unknown[]) => signOut(...args),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  unstable_rethrow: vi.fn(),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})
// 子カードは各々 server action を呼ぶため無効化する（検証対象はログアウト経路のみ）
vi.mock("@/components/settings/profile-card", () => ({ ProfileCard: () => null }))
vi.mock("@/components/settings/invite-card", () => ({ InviteCard: () => null }))
vi.mock("@/components/settings/approval-card", () => ({ ApprovalCard: () => null }))
vi.mock("@/components/settings/default-page-card", () => ({
  DefaultPageCard: () => null,
}))
vi.mock("@/components/settings/baby-profile-card", () => ({
  BabyProfileCard: () => null,
}))
vi.mock("@/components/settings/export-card", () => ({ ExportCard: () => null }))
vi.mock("@/components/settings/theme-card", () => ({ ThemeCard: () => null }))
vi.mock("@/components/settings/help-card", () => ({ HelpCard: () => null }))

import { SettingsContent } from "@/app/(main)/settings/settings-content"
import { CacheUserGuard } from "@/components/common/cache-user-guard"
import {
  LAST_USER_ID_STORAGE_KEY,
  purgeHouseholdCaches,
  setCacheOwner,
} from "@/lib/pwa/sw-messages"
import { unstable_rethrow } from "next/navigation"
import { toast } from "sonner"

const SW_PATH = resolve(__dirname, "../../../../public/sw.js")
const ORIGIN = "http://127.0.0.1:3000/"
const abs = (path: string) => new URL(path, ORIGIN).href

const USER_A = "user-a"
const USER_B = "user-b"
/** 各利用者の世帯。応答の本文に載る（B のオフライン閲覧に「A家」が出たら漏れ）。 */
const HOUSEHOLD: Record<string, string> = { [USER_A]: "A家", [USER_B]: "B家" }
const OFFLINE_BODY = "オフライン画面"
const SIGN_OUT_FAILED = "ログアウトを完了できませんでした。電波の良い場所でもう一度お試しください"

/** signOut 成功時にクライアントへ届く redirect エラーの番兵（settings-content-sign-out と同じ） */
const REDIRECT = new Error("NEXT_REDIRECT;replace;/login;307;")

type Semantics = "orphan" | "name-bound"

/**
 * CacheStorage の代役。`match` は保存した Response の複製を返す（実物も読むたびに新しい
 * Response を返す）。`failHouseholdDelete` は世帯キャッシュ（documents / rsc）の
 * `caches.delete` だけを失敗させる（quota 等）。
 */
function makeCacheStorage(semantics: Semantics) {
  const stores = new Map<string, Map<string, Response>>()
  const failures = { householdDelete: false }
  /**
   * 一度だけの割り込み: 名前 `name` のキャッシュが次に開かれる直前に `run` を走らせる。
   * SW の putOwned は「持ち主の再確認 → open → put」の順ゆえ、documents に仕掛ければ
   * 再確認と put の間（TOCTOU の窓）に交代を挟める。
   */
  const interleave: { atOpen: { name: string; run: () => Promise<void> } | null } = {
    atOpen: null,
  }
  const keyOf = (req: string | { url: string }) =>
    new URL(typeof req === "string" ? req : req.url, ORIGIN).href
  const live = (name: string) => {
    let store = stores.get(name)
    if (!store) {
      store = new Map()
      stores.set(name, store)
    }
    return store
  }
  const open = async (name: string) => {
    const pending = interleave.atOpen
    if (pending && pending.name === name) {
      interleave.atOpen = null
      await pending.run()
    }
    const boundAtOpen = live(name)
    // orphan: 開いた時点の実体に縛られる（削除後は切り離される）
    // name-bound: 操作のたびに名前から引き直す（削除後の put で名前のキャッシュへ書き戻る）
    const entries = () => (semantics === "orphan" ? boundAtOpen : live(name))
    return {
      match: async (req: string | { url: string }) => entries().get(keyOf(req))?.clone(),
      put: async (req: string | { url: string }, res: Response) => {
        entries().set(keyOf(req), res)
      },
      delete: async (req: string | { url: string }) => entries().delete(keyOf(req)),
      keys: async () => [...entries().keys()].map((url) => ({ url })),
    }
  }
  const caches = {
    open,
    has: async (name: string) => stores.has(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => {
      if (failures.householdDelete && /-(documents|rsc)$/.test(name)) {
        throw new Error("QuotaExceededError")
      }
      return stores.delete(name)
    },
  }
  /** 名前から見える（= SW が配りうる）世帯キャッシュの本文をすべて読む */
  async function visibleHouseholdBodies(): Promise<string[]> {
    const bodies: string[] = []
    for (const [name, store] of stores) {
      if (!/-(documents|rsc)$/.test(name)) continue
      for (const res of store.values()) bodies.push(await res.clone().text())
    }
    return bodies
  }
  return { caches, failures, interleave, live, visibleHouseholdBodies }
}

interface Deferred {
  url: string
  release: () => void
}

function makeWorld(semantics: Semantics) {
  const store = makeCacheStorage(semantics)
  /** cookie の持ち主（ブラウザ単位 = 全タブ共通）。null はログアウト済み。 */
  let session: string | null = null
  let online = true
  /** 次に届く要求のうち、応答を止める本数（SW は fetch の前に Cache を開くゆえ、数で数える） */
  let holdCount = 0
  const held: Deferred[] = []
  /** true なら応答から持ち主ヘッダを外す（proxy を通らなかった応答の代わり） */
  let withoutOwnerHeader = false

  const fetchImpl = (input: string | { url: string }) => {
    const href = typeof input === "string" ? abs(input) : input.url
    if (!online) return Promise.reject(new TypeError("Failed to fetch"))
    const url = new URL(href)
    // 応答の中身は「要求を出した瞬間」の cookie で決まる
    const who = session
    const isRsc = url.searchParams.has("_rsc")
    let res: Response
    if (who) {
      res = new Response(`${HOUSEHOLD[who]}の記録:${url.pathname}`, {
        status: 200,
        headers: {
          "content-type": isRsc ? "text/x-component" : "text/html; charset=utf-8",
          // proxy が承認済みの応答に載せる「この応答の主」（検証済みの user id）
          ...(withoutOwnerHeader ? {} : { "x-irori-cache-owner": who }),
        },
      })
    } else {
      // 未ログイン: proxy は /login 以外を /login へ 307 し、fetch はそれを追う。
      // 届くのは /login の HTML（主のヘッダ無し）で、url は /login・redirected は真
      res = new Response("ログイン画面", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
      Object.defineProperty(res, "url", { value: abs("/login") })
      Object.defineProperty(res, "redirected", { value: url.pathname !== "/login" })
    }
    if (holdCount > 0) {
      holdCount -= 1
      return new Promise<Response>((resolveRes) => {
        held.push({ url: href, release: () => resolveRes(res) })
      })
    }
    return Promise.resolve(res)
  }

  const listeners = new Map<string, (event: unknown) => void>()
  const self: Record<string, unknown> = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener)
    },
    location: { href: ORIGIN },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    registration: { showNotification: () => Promise.resolve() },
  }
  runInNewContext(readFileSync(SW_PATH, "utf8"), {
    self,
    console,
    URL,
    Date,
    Response,
    Headers,
    caches: store.caches,
    fetch: fetchImpl,
  })
  const hooks = self.__TEST_HOOKS__ as { CACHE_NAMES: Record<string, string> }

  // /offline を precache に仕込む（退化先を本文で判別できるように。date を新しくして
  // maybeRefreshOffline の再取得を止める）
  void store.caches.open(hooks.CACHE_NAMES.precache).then((cache) =>
    cache.put(
      "/offline",
      new Response(OFFLINE_BODY, {
        headers: { "content-type": "text/html", date: new Date().toUTCString() },
      }),
    ),
  )

  /**
   * SW の fetch リスナへ要求を投げ、応答の Promise を返す（`respondWith` が呼ばれねば落とす）。
   * document は navigate、rsc は `RSC: 1` + `?_rsc=` の client-side 遷移。
   */
  function request(kind: "document" | "rsc", path: string): Promise<Response> {
    const url = kind === "rsc" ? abs(`${path}?_rsc=abc12`) : abs(path)
    const req = {
      url,
      method: "GET",
      mode: kind === "document" ? "navigate" : "cors",
      headers: { get: (name: string) => (kind === "rsc" && name === "RSC" ? "1" : null) },
    }
    let responded: Promise<Response> | null = null
    const waits: Promise<unknown>[] = []
    listeners.get("fetch")!({
      request: req,
      respondWith: (p: Promise<Response>) => {
        responded = p
      },
      waitUntil: (p: Promise<unknown>) => {
        waits.push(p)
      },
    })
    if (!responded) throw new Error(`fetch リスナが respondWith を呼ばなかった: ${kind} ${path}`)
    const result = responded as Promise<Response>
    return Promise.all([result, ...waits.map((w) => Promise.resolve(w).catch(() => undefined))]).then(
      ([res]) => res as Response,
    )
  }

  /** オフラインで開いた時に見える本文（document）。 */
  async function offlineDocumentBody(path: string): Promise<string> {
    const res = await request("document", path)
    return res.text()
  }

  return {
    store,
    listeners,
    hooks,
    request,
    offlineDocumentBody,
    setSession: (who: string | null) => {
      session = who
    },
    setOnline: (value: boolean) => {
      online = value
    },
    holdNextResponse: () => {
      holdCount += 1
    },
    stripOwnerHeader: (value: boolean) => {
      withoutOwnerHeader = value
    },
    held,
  }
}

/** 再送出されたフレームワークの信号を受ける（Next では RedirectBoundary の役） */
let caughtByBoundary: unknown = null
class SignalBoundary extends Component<{ children: ReactNode }, { caught: boolean }> {
  state = { caught: false }
  static getDerivedStateFromError() {
    return { caught: true }
  }
  componentDidCatch(error: unknown) {
    caughtByBoundary = error
  }
  render() {
    return this.state.caught ? <p>redirected</p> : this.props.children
  }
}

function renderSettings(userId: string) {
  render(
    <SignalBoundary>
      <SettingsContent
        profile={{
          id: userId,
          displayName: "テスト",
          avatarUrl: null,
          role: "owner",
          defaultPage: "baby",
        }}
        household={{ id: `h-${userId}`, name: HOUSEHOLD[userId] }}
        email={`${userId}@example.com`}
        isAppOperator={false}
        pendingUsers={[]}
        babyProfile={{ name: null, birthDate: null, feedingIntervalMin: 180 }}
        googleConnections={[]}
        googleNotice={null}
        pushDevices={[]}
        pushHealth={{
          runState: "healthy",
          ranAtLabel: "3分前",
          failedCount: 0,
          deliveryState: "sent",
          lastSentLabel: "1時間前",
        }}
        digestTime={null}
        digestTimeUnknown={false}
      />
    </SignalBoundary>,
  )
}

/** 非同期の Cache API 操作・effect を流し切る（代役の Cache はすべて Promise ベース）。 */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })
}

/** 利用者がログインして (main) に入る: cookie を切り替え、CacheUserGuard を走らせる。 */
async function enterMain(world: ReturnType<typeof makeWorld>, userId: string) {
  world.setSession(userId)
  render(<CacheUserGuard userId={userId} />)
  await settle()
}

/**
 * 設定画面からログアウトする（実物の SettingsContent.handleSignOut）。サーバの signOut は
 * `duringServer`（サーバ往復の間に起きること）の後に、`outcome` で終わる:
 * - "success": cookie を消して redirect を投げる（既定）
 * - "error-result": `{ error }` を返す。auth-js（2.110 系）はサーバでの失効に失敗した時も
 *   **端末のセッションを消してから** error を返すゆえ、代役も cookie を消す
 * - "network-reject": Server Action が通信断で reject（サーバへ届かず、セッションは残る）
 */
async function logoutViaSettings(
  world: ReturnType<typeof makeWorld>,
  userId: string,
  opts: {
    outcome?: "success" | "error-result" | "network-reject"
    duringServer?: () => Promise<void>
  } = {},
) {
  const outcome = opts.outcome ?? "success"
  signOut.mockImplementationOnce(async () => {
    await opts.duringServer?.()
    if (outcome === "network-reject") throw new TypeError("Failed to fetch")
    world.setSession(null)
    if (outcome === "error-result") return { error: SIGN_OUT_FAILED }
    throw REDIRECT
  })
  renderSettings(userId)
  fireEvent.click(screen.getByRole("button", { name: "ログアウト" }))
  if (outcome === "success") {
    await waitFor(() => expect(caughtByBoundary).toBe(REDIRECT))
  } else {
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled())
  }
  await settle()
}

beforeEach(() => {
  vi.clearAllMocks()
  signOut.mockReset()
  localStorage.clear()
  caughtByBoundary = null
  vi.mocked(unstable_rethrow).mockImplementation((err: unknown) => {
    if (err === REDIRECT) throw err
  })
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "info").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each(["orphan", "name-bound"] as const)(
  "共用端末のオフラインキャッシュ分離（Cache API: %s）",
  (semantics) => {
    function setup() {
      const world = makeWorld(semantics)
      vi.stubGlobal("caches", world.store.caches)
      return world
    }

    it("⭐ A のログアウト前に出た要求の遅延応答が B への切替後に届いても、B のオフライン閲覧に A の世帯は出ぬ", async () => {
      const world = setup()
      await enterMain(world, USER_A)
      // A がオンラインで開いておった画面（ログアウトで破棄される）
      await (await world.request("document", "/baby")).text()

      // 別タブで A の画面遷移が通信中（document と RSC の両方を止める）
      world.holdNextResponse()
      const lateDocument = world.request("document", "/calendar")
      world.holdNextResponse()
      const lateRsc = world.request("rsc", "/settings")
      await settle()
      expect(world.held).toHaveLength(2)

      // A がログアウト → B がログインして (main) に入る
      await logoutViaSettings(world, USER_A)
      cleanup()
      await enterMain(world, USER_B)

      // A の遅延応答が今ごろ届く（A 本人のタブには A の世帯が表示される — それは正しい）
      for (const h of world.held) h.release()
      expect(await (await lateDocument).text()).toContain("A家")
      expect(await (await lateRsc).text()).toContain("A家")
      await settle()
      // 遅延応答は名前から見えるキャッシュへ再保存されておらぬ（主 A ≠ 記録 B。保存側の
      // ガード）。**オフライン照会の前に見る** — 照会の matchOwned は主の違う項目を消す
      // ゆえ、後で見ると「保存されなんだ」と「配られずに消えた」の区別がつかぬ（独立レビュー r4）
      expect((await world.store.visibleHouseholdBodies()).join("|")).not.toContain("A家")

      // B がオフラインで開く
      world.setOnline(false)
      for (const path of ["/baby", "/calendar", "/settings"]) {
        const body = await world.offlineDocumentBody(path)
        expect(body, `${path} に A の世帯が出た`).not.toContain("A家")
        expect(body).toBe(OFFLINE_BODY)
      }
      await expect(world.request("rsc", "/settings")).rejects.toThrow()
    })

    it("対照: 遅れて届いた前の利用者の応答は、新しい持ち主（B）のオフライン閲覧を止めぬ", async () => {
      // 独立レビュー r3 の P3: 応答の主（A）と今の記録（B）が違うことだけで記録を消すと、
      // 交代の前に出た要求の遅延応答が、正しい B の記録まで消す（漏れはせぬが B の保存が止まる）
      const world = setup()
      await enterMain(world, USER_A)
      world.holdNextResponse()
      const late = world.request("document", "/calendar")
      await settle()

      await logoutViaSettings(world, USER_A)
      cleanup()
      await enterMain(world, USER_B)
      world.held[0].release()
      expect(await (await late).text()).toContain("A家")
      await settle()

      // B がオンラインで開いた画面は、B のオフライン閲覧で読める
      await (await world.request("document", "/baby")).text()
      world.setOnline(false)
      expect(await world.offlineDocumentBody("/baby")).toBe("B家の記録:/baby")
      expect(await world.offlineDocumentBody("/calendar")).toBe(OFFLINE_BODY)
    })

    it("⭐ 破棄の後・signOut の完了前に別タブが A の cookie で出した要求の応答も、B のオフライン閲覧に出ぬ", async () => {
      const world = setup()
      await enterMain(world, USER_A)

      // サーバの signOut 往復の間に、別タブが A の cookie のまま /baby を開く
      await logoutViaSettings(world, USER_A, {
        duringServer: async () => {
          const res = await world.request("document", "/baby")
          expect(await res.text()).toContain("A家")
        },
      })
      cleanup()
      await enterMain(world, USER_B)

      world.setOnline(false)
      const body = await world.offlineDocumentBody("/baby")
      expect(body, "/baby に A の世帯が出た").not.toContain("A家")
      expect(body).toBe(OFFLINE_BODY)
    })

    it("⭐ signOut の往復の間に別タブの guard が持ち主を A へ書き戻しても、成功で記録は消え、未ログインの端末に A の世帯は出ぬ", async () => {
      // 独立レビュー r4 の P3: 成功の redirect は Server Action の応答に乗る SPA 遷移で、
      // SW の nav-passthrough（/login で記録を消す経路）を通らぬ。鍵（LAST_USER_ID）はまだ
      // A ゆえ、往復の間に (main) を開き直した別タブの guard は破棄せず setCacheOwner(A) を
      // 書く。破棄が部分失敗した端末では A の項目も残り、未ログインの者に配られる
      const world = setup()
      await enterMain(world, USER_A)
      await (await world.request("document", "/baby")).text()
      world.store.failures.householdDelete = true
      await logoutViaSettings(world, USER_A, {
        duringServer: async () => {
          // 別タブの guard（鍵は A のまま = 「同じ利用者」と見て破棄せず持ち主を書く）
          expect(await setCacheOwner(USER_A)).toBe(true)
          // そのタブが A の cookie で続けて開いた画面は保存される（記録も主も A）
          expect(await (await world.request("document", "/calendar")).text()).toContain("A家")
        },
      })
      cleanup()
      // 漏れの前提が成り立っておる証拠: A の項目は名前から見えるキャッシュに残っておる
      expect((await world.store.visibleHouseholdBodies()).join("|")).toContain("A家")

      // 誰もログインしておらぬ端末をオフラインで開く
      world.setOnline(false)
      for (const path of ["/baby", "/calendar"]) {
        const body = await world.offlineDocumentBody(path)
        expect(body, `${path} に A の世帯が出た`).not.toContain("A家")
        expect(body).toBe(OFFLINE_BODY)
      }
    })

    it("⭐ SW の保存直前の確認と put の間に交代が挟まっても（TOCTOU）、配信時の照合で B に A の世帯は出ぬ", async () => {
      const world = setup()
      await enterMain(world, USER_A)
      // SW が「持ち主はまだ A」と確かめた直後・put の直前に、A のログアウト（破棄）と
      // B のログイン（持ち主を B へ）が挟まる
      world.store.interleave.atOpen = {
        name: world.hooks.CACHE_NAMES.documents,
        run: async () => {
          expect(await purgeHouseholdCaches()).toBe(true)
          world.setSession(USER_B)
          expect(await setCacheOwner(USER_B)).toBe(true)
        },
      }
      const res = await world.request("document", "/baby")
      expect(await res.text()).toContain("A家")
      expect(world.store.interleave.atOpen, "割り込みが起きておらぬ（窓を撃てておらぬ）").toBeNull()
      // 窓を撃てた証拠: A の応答は A のタグのまま名前から見えるキャッシュへ入ってしまっておる。
      // これを止めるのは配信時のタグ照合だけ
      expect((await world.store.visibleHouseholdBodies()).join("|")).toContain("A家")

      world.setOnline(false)
      const body = await world.offlineDocumentBody("/baby")
      expect(body, "/baby に A の世帯が出た").not.toContain("A家")
      expect(body).toBe(OFFLINE_BODY)
      // 配られなかった前の利用者の項目は、照合のついでに消える
      expect((await world.store.visibleHouseholdBodies()).join("|")).not.toContain("A家")
    })

    it("⭐ 世帯キャッシュの破棄に失敗しても、後でログインした B のオフライン閲覧に A の世帯は出ぬ", async () => {
      const world = setup()
      await enterMain(world, USER_A)
      await (await world.request("document", "/baby")).text()

      // 破棄（caches.delete）が quota 等で失敗する端末
      world.store.failures.householdDelete = true
      await logoutViaSettings(world, USER_A)
      cleanup()
      // 破棄を確かめられなんだゆえ鍵は A のまま残る（次の guard に破棄を試み直させる）
      expect(localStorage.getItem(LAST_USER_ID_STORAGE_KEY)).toBe(USER_A)

      await enterMain(world, USER_B)
      // B の guard の破棄も失敗し、鍵は A のまま（再試行のため）
      expect(localStorage.getItem(LAST_USER_ID_STORAGE_KEY)).toBe(USER_A)

      world.setOnline(false)
      const body = await world.offlineDocumentBody("/baby")
      expect(body, "/baby に A の世帯が出た").not.toContain("A家")
      expect(body).toBe(OFFLINE_BODY)
    })

    /**
     * 独立レビュー r1 の P1: セッションが**破棄を経ずに**終わる（他端末からの global sign-out・
     * refresh の失効・承認待ち画面からのログアウト）と、持ち主の記録は前の利用者のまま残る。
     * 次の利用者の着地 document は guard より先に SW を通る。応答の主ではなく記録でタグを
     * 付けると、B の HTML が A のタグで保存され、破棄が 1 回失敗した後に A が戻ると A に配られる。
     */
    it("⭐ 破棄なしでセッションが終わり、次の利用者の着地 document が guard より先に通っても、別の利用者に配られぬ", async () => {
      const world = setup()
      await enterMain(world, USER_A)
      // A がオンラインで開いた画面（世帯キャッシュが在る = 後の破棄が失敗しうる前提）
      await (await world.request("document", "/calendar")).text()
      // 1. A のセッションが破棄なしで終わる（持ち主の記録・鍵は A のまま）
      cleanup()
      world.setSession(null)

      // 2. B がログインし、着地の /baby が guard より先に SW を通る。その後 guard の破棄が失敗
      world.store.failures.householdDelete = true
      world.setSession(USER_B)
      expect(await (await world.request("document", "/baby")).text()).toBe("B家の記録:/baby")
      render(<CacheUserGuard userId={USER_B} />)
      await settle()
      expect(localStorage.getItem(LAST_USER_ID_STORAGE_KEY)).toBe(USER_A)

      // 3. B のセッションも破棄なしで終わり、A が戻る（鍵は A ゆえ A の guard は破棄せぬ）
      world.store.failures.householdDelete = false
      cleanup()
      world.setSession(null)
      world.setSession(USER_A)
      expect(await (await world.request("document", "/calendar")).text()).toBe(
        "A家の記録:/calendar",
      )
      render(<CacheUserGuard userId={USER_A} />)
      await settle()

      // 4. A がオフラインで開く: B の世帯は出ぬ
      world.setOnline(false)
      const body = await world.offlineDocumentBody("/baby")
      expect(body, "/baby に B の世帯が出た").not.toContain("B家")
      expect(body).toBe(OFFLINE_BODY)
    })

    it("主（持ち主ヘッダ）の無い応答は保存せぬ（proxy を通らぬ応答・古いデプロイの応答）", async () => {
      // 保存側の `!owner` の門番。これを外すと (1) 記録の無い端末では `null !== null` で
      // 主の無い項目が保存され、(2) 記録の在る端末では「主が違う」と誤認して A の記録まで
      // 消す（以後 A の保存が止まる）。どちらも照会の前・後の観測で赤くする（独立レビュー r4）
      const world = setup()
      world.setSession(USER_A)
      // (1) 記録が無い（guard がまだ走っておらぬ）端末に、主の無い応答が届く
      world.stripOwnerHeader(true)
      await (await world.request("document", "/baby")).text()
      expect(await world.store.visibleHouseholdBodies()).toEqual([])

      // (2) 記録が在る端末に、主の無い応答が届く
      await enterMain(world, USER_A)
      await (await world.request("document", "/baby")).text()
      world.stripOwnerHeader(false)
      // 保存側で止まっておる（配信時の照合に頼らぬ。照会の前に見る）
      expect(await world.store.visibleHouseholdBodies()).toEqual([])
      // A の記録は消えておらぬ: 続けて開いた画面は保存され、A のオフライン閲覧で読める
      await (await world.request("document", "/calendar")).text()

      world.setOnline(false)
      expect(await world.offlineDocumentBody("/baby")).toBe(OFFLINE_BODY)
      expect(await world.offlineDocumentBody("/calendar")).toBe("A家の記録:/calendar")
    })

    it("主（持ち主ヘッダ）を持たぬ旧版 SW の項目は、記録の有無にかかわらず配られぬ", async () => {
      // sw.js の約束「主の無い旧版の項目も配られぬ」の門番。matchOwned の `!owner` の早期
      // return（記録が無い端末）と、主の照合（記録が在る端末）のどちらを外しても赤くなる
      const world = setup()
      const seedLegacy = () =>
        world.store
          .live(world.hooks.CACHE_NAMES.documents)
          .set(
            abs("/baby"),
            new Response("旧版が保存したA家の記録", {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          )
      // 1. 記録が無い（誰もログインしておらぬ）端末: `null !== null` で配ってはならぬ
      seedLegacy()
      world.setOnline(false)
      expect(await world.offlineDocumentBody("/baby")).toBe(OFFLINE_BODY)

      // 2. 記録が在る（A がログイン中）端末でも、主の無い項目は A にも配られず、消える
      world.setOnline(true)
      await enterMain(world, USER_A)
      seedLegacy()
      world.setOnline(false)
      expect(await world.offlineDocumentBody("/baby")).toBe(OFFLINE_BODY)
      expect((await world.store.visibleHouseholdBodies()).join("|")).not.toContain("A家")
    })

    it("{ error } で返ったログアウト（端末のセッションは消えておる）では持ち主を戻さず、残った A の項目は誰にも配られぬ", async () => {
      // 独立レビュー r2 の P3: 持ち主を戻すと、実質ログアウト済みの端末で、破棄に失敗して
      // 残った A の項目が再び配られる
      const world = setup()
      await enterMain(world, USER_A)
      await (await world.request("document", "/baby")).text()
      world.store.failures.householdDelete = true
      await logoutViaSettings(world, USER_A, { outcome: "error-result" })
      cleanup()

      world.setOnline(false)
      const body = await world.offlineDocumentBody("/baby")
      expect(body, "/baby に A の世帯が出た").not.toContain("A家")
      expect(body).toBe(OFFLINE_BODY)
    })

    it("⭐ 破棄なしでセッションが終わった端末を開いて /login に着いたら、その時点で前の利用者の項目は配られぬ", async () => {
      // 独立レビュー r2 の P2（PR 以前から在る露出）: 他端末からのサインアウト・失効では
      // アプリの破棄が走らず、持ち主の記録と項目が残る
      const world = setup()
      await enterMain(world, USER_A)
      await (await world.request("document", "/baby")).text()
      cleanup()
      world.setSession(null)

      // 誰かがオンラインでアプリを開く: / は proxy に /login へ 307 される。ナビゲーションの
      // SW 内 fetch は redirect: "manual" ゆえ、redirect はブラウザが追い、/login の遷移が
      // 改めて SW を通る（nav-passthrough）。ここではその /login の遷移を撃つ
      expect(await (await world.request("document", "/login")).text()).toBe("ログイン画面")

      // その後オフラインで育児ページを開いても、A の世帯は出ぬ
      world.setOnline(false)
      const body = await world.offlineDocumentBody("/baby")
      expect(body, "/baby に A の世帯が出た").not.toContain("A家")
      expect(body).toBe(OFFLINE_BODY)
    })

    it("⭐ 破棄なしでセッションが終わった後、別の利用者の応答が届いた時点で記録を消す（guard が走らずとも配らぬ）", async () => {
      const world = setup()
      await enterMain(world, USER_A)
      await (await world.request("document", "/baby")).text()
      cleanup()
      world.setSession(null)

      // B が（この端末の /login を経ずに）ログインし、着地の /calendar だけ開いて閉じる
      world.setSession(USER_B)
      await (await world.request("document", "/calendar")).text()
      // B の着地は保存されておらぬ（記録は A のまま = 主が違う。保存側のガード — 独立レビュー r4）
      expect((await world.store.visibleHouseholdBodies()).join("|")).not.toContain("B家")

      world.setOnline(false)
      const body = await world.offlineDocumentBody("/baby")
      expect(body, "/baby に A の世帯が出た").not.toContain("A家")
      expect(body).toBe(OFFLINE_BODY)
    })

    it("通信断でログアウトに失敗した A は自分のオフライン閲覧を保ち、後でログインした B には A の世帯が出ぬ", async () => {
      const world = setup()
      await enterMain(world, USER_A)
      await logoutViaSettings(world, USER_A, { outcome: "network-reject" })
      // 失敗ゆえ鍵は残り、A はログインしたまま使い続ける
      expect(localStorage.getItem(LAST_USER_ID_STORAGE_KEY)).toBe(USER_A)

      await (await world.request("document", "/calendar")).text()
      world.setOnline(false)
      // A 自身のオフライン閲覧は生きておる（隔離が本人の閲覧まで殺しておらぬ）
      expect(await world.offlineDocumentBody("/calendar")).toContain("A家")
      world.setOnline(true)

      // 後で A のセッションが切れ、同じ端末で B がログインする
      cleanup()
      await enterMain(world, USER_B)
      world.setOnline(false)
      const body = await world.offlineDocumentBody("/calendar")
      expect(body, "/calendar に A の世帯が出た").not.toContain("A家")
      expect(body).toBe(OFFLINE_BODY)
    })

    it("対照: 利用者が自分で開いた画面は、その利用者のオフライン閲覧で読める", async () => {
      const world = setup()
      await enterMain(world, USER_A)
      await (await world.request("document", "/baby")).text()
      await logoutViaSettings(world, USER_A)
      cleanup()
      await enterMain(world, USER_B)
      await (await world.request("document", "/baby")).text()
      await (await world.request("rsc", "/calendar")).text()

      world.setOnline(false)
      expect(await world.offlineDocumentBody("/baby")).toBe("B家の記録:/baby")
      expect(await (await world.request("rsc", "/calendar")).text()).toBe("B家の記録:/calendar")
    })

    it("SW に制御されたページ（PURGE を SW へも送る）でも、遅延応答は B のオフライン閲覧に出ぬ", async () => {
      const world = setup()
      // controller を立て、PURGE を vm の SW の message リスナへ届ける
      vi.stubGlobal(
        "MessageChannel",
        class {
          port1: { onmessage: ((e: { data: unknown }) => void) | null; close: () => void }
          port2: { postMessage: (data: unknown) => void }
          constructor() {
            const port1 = { onmessage: null as ((e: { data: unknown }) => void) | null, close: () => {} }
            this.port1 = port1
            this.port2 = {
              postMessage: (data: unknown) => queueMicrotask(() => port1.onmessage?.({ data })),
            }
          }
        },
      )
      vi.stubGlobal("navigator", {
        serviceWorker: {
          controller: {
            postMessage: (message: unknown, transfer: unknown[]) => {
              world.listeners.get("message")!({
                data: message,
                ports: transfer,
                waitUntil: (p: Promise<unknown>) => p,
              })
            },
          },
        },
      })

      await enterMain(world, USER_A)
      world.holdNextResponse()
      const late = world.request("document", "/baby")
      await settle()

      await logoutViaSettings(world, USER_A)
      cleanup()
      await enterMain(world, USER_B)
      world.held[0].release()
      await (await late).text()
      await settle()

      world.setOnline(false)
      const body = await world.offlineDocumentBody("/baby")
      expect(body, "/baby に A の世帯が出た").not.toContain("A家")
      expect(body).toBe(OFFLINE_BODY)
    })
  },
)
