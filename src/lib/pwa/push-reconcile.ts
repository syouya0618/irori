/**
 * 起動時の突き合わせ（B-4）— **410 で消した購読を、誰かが張り直す**ための経路。
 *
 * ## なぜ要るか
 * 配信ジョブは 410 / 404 を受けたら DB の購読を消す（それが正しい）。だが
 * **消しっぱなしでは誰も作り直さぬ** — 主が自発的に設定画面を開いて
 * 「この端末で通知を受け取る」を押すまで、通知は永久に来ぬ。しかも画面は
 * 何も警告せぬ（端末一覧から 1 行消えるだけで、それを見る理由が無い）。
 * ゆえにアプリを開いた時に、ブラウザが持っておる購読をサーバへ**冪等に**
 * 登録し直す。`upsert_push_subscription` は `ON CONFLICT DO UPDATE` ゆえ
 * 何度呼んでも行は増えぬ。
 *
 * ## なぜ「DB の endpoint と突き合わせる」形にせぬか
 * `push_subscriptions.endpoint` は**列 GRANT の外**じゃ（B-1）。authenticated は
 * 自分の行ですら endpoint を読めぬゆえ、「ブラウザの endpoint が DB に在るか」は
 * 原理的に問えぬ。件数の食い違い（DB 0 件 × ブラウザ 1 件）で代用する手も在るが、
 * **2 台持ちの片方だけが消えた場合に件数は 1 のままで、その端末は永久に直らぬ**。
 * → 冪等な呼び直しを選ぶ。単純で、取りこぼしが無い。
 *
 * ## ⚠️ 代償を正直に書く: `failure_count` が畳まれる
 * `upsert_push_subscription` は再購読を「健康な状態への復帰」と見なして
 * `failure_count = 0, last_failure_at = NULL` を書く（B-1 migration の設計）。
 * ゆえにこの突き合わせを**毎ページ走らせると、同じ PR で設定カードへ出した
 * `failure_count` が永久に 0 のままになる**（両者が打ち消し合う）。
 * 対策は 2 つ:
 *   1. **セッションに 1 度だけ**走らせる（このモジュールの marker）。
 *   2. カードに `最終失敗`（`last_failure_at`）も並べる。cron は 5 分ごとに回るゆえ、
 *      本当に壊れておる端末なら数分で両方が戻る。
 * 恒久的に潰すなら「カウンタを畳まぬ専用 RPC」を足すことになるが、それは
 * B-1 の migration へ手を入れる話ゆえ本 PR では**意図的に据え置く**。
 */

/** Route Handler のパス。`public/sw.js` の `RESUBSCRIBE_PATH` と対じゃ。 */
export const PUSH_RESUBSCRIBE_PATH = "/api/push/resubscribe"

/**
 * 「このセッションで突き合わせ済み」の印。
 *
 * 値は **`${userId}:${endpoint}`** じゃ（`buildReconcileMarker`）。
 * - 購読が回れば endpoint が変わり、同じセッション内でも自動でもう一度走る。
 * - **利用者が代われば userId が変わり、必ずもう一度走る**。ここが load-bearing:
 *   sessionStorage は同じタブ内の遷移（セッション切れ → `/login` → 再ログイン）で
 *   保持されるゆえ、endpoint だけを印にすると**共用端末で持ち主が代わっても退いて
 *   しまう**。DB 行の `user_id` は前の利用者のまま残り、`upsert_push_subscription`
 *   の付け替え（`DELETE ... WHERE endpoint = ... AND user_id <> auth.uid()`）が
 *   発火せぬ ＝ **前の利用者の世帯の通知が、今の利用者の端末へ届き続ける**。
 *   同じ layout の `CacheUserGuard` が `userId` を受けて利用者交代を見ておるのと
 *   同じ脅威じゃ。
 *
 * ⚠️ 値は**丸ごと 1 つの文字列として比較する**（分解して読まぬ）。endpoint は
 * `:` も `/` も含むゆえ、パースしようとした瞬間に壊れる。
 */
export const PUSH_RECONCILE_MARKER_KEY = "irori.push.reconciled-endpoint"

/** 印の値。**ここでしか組まぬ**（組み方が 2 箇所に散ると比較が食い違う）。 */
export function buildReconcileMarker(userId: string, endpoint: string): string {
  return `${userId}:${endpoint}`
}

/**
 * 「主がこの端末の通知を明示的に切った」印（**localStorage**）。
 *
 * ## なぜ sessionStorage ではないか
 * 上の突き合わせ印はセッション内の再走を止めるだけゆえ session で足りる。
 * こちらは**主の意思**じゃ。タブを閉じただけで巻き戻ってよいものではない。
 *
 * ## なぜ要るか（`unsubscribe()` だけでは足りぬ）
 * 解除の本体はブラウザ側の `subscription.unsubscribe()` じゃ（購読が消えれば
 * 突き合わせは `no-subscription` で退く）。だが圏外・権限周りで**それが失敗し
 * うる**。その時この印が無ければ、次の起動で突き合わせが同じ endpoint を
 * 登録し直し、主が切ったはずの通知が戻る。印は endpoint 単位（購読は
 * ブラウザ単位ゆえ）で、主が「この端末で通知を受け取る」を押せば消える。
 */
export const PUSH_OPT_OUT_MARKER_KEY = "irori.push.opted-out-endpoint"

/**
 * 以下 3 つは**ブラウザ文脈からのみ**呼ぶ（module scope では触らぬゆえ SSR で
 * 評価されても安全）。プライベートモード等で localStorage が使えねば、
 * 「印が無い」へ退化する（＝ 従来どおりの挙動に戻るだけで、画面は壊れぬ）。
 */
export function readPushOptOut(): string | null {
  try {
    return localStorage.getItem(PUSH_OPT_OUT_MARKER_KEY)
  } catch (err) {
    console.warn("[push] 解除の印を読めなかった:", err)
    return null
  }
}

export function writePushOptOut(endpoint: string): void {
  try {
    localStorage.setItem(PUSH_OPT_OUT_MARKER_KEY, endpoint)
  } catch (err) {
    console.warn("[push] 解除の印を書けなかった:", err)
  }
}

export function clearPushOptOut(): void {
  try {
    localStorage.removeItem(PUSH_OPT_OUT_MARKER_KEY)
  } catch (err) {
    console.warn("[push] 解除の印を消せなかった:", err)
  }
}

export interface PushSubscriptionJsonLike {
  endpoint?: string | null
  keys?: { p256dh?: string | null; auth?: string | null } | null
}

export interface ResubscribeRequestBody {
  endpoint: string
  p256dh: string
  auth: string
  userAgent: string | null
}

/**
 * 何が起きたか。**握り潰さぬための戻り値**じゃ（呼び出し側がログに使う）。
 * `unsupported` はこのモジュールの外（ブラウザ機能の有無）で決まる。
 */
export type PushReconcileOutcome =
  | "no-subscription"
  | "already-reconciled"
  /** 主がこの端末の通知を明示的に切っておる（復活させてはならぬ） */
  | "opted-out"
  | "incomplete"
  | "registered"
  | "rejected"

export interface PushReconcileDeps {
  /** ブラウザが今持っておる購読（無ければ null）。 */
  getSubscriptionJson: () => Promise<PushSubscriptionJsonLike | null>
  /** セッション付きで再登録を叩く。**受理された時だけ** true。 */
  register: (body: ResubscribeRequestBody) => Promise<boolean>
  /** 「主が切った」印（`readPushOptOut` の値）。 */
  readOptOut: () => string | null
  readMarker: () => string | null
  /** 引数は `buildReconcileMarker` の出力（endpoint 単体ではない）。 */
  writeMarker: (marker: string) => void
  /** 今ログインしておる利用者。印を利用者で区切るために要る。 */
  userId: string
  userAgent: string | null
}

/**
 * 突き合わせ 1 回ぶん。
 *
 * ⚠️ ここは **購読を作らぬし、消さぬ**。`subscribe()` は権限要求を伴い、
 * `unsubscribe()` は不可逆じゃ。どちらも「主が設定カードで押した」時にだけ
 * 起きてよい（CLAUDE.md「破棄は狭く」）。ここが触れてよいのは
 * 「既に在る購読をサーバへ知らせ直す」ことだけじゃ。
 */
export async function reconcilePushSubscription(
  deps: PushReconcileDeps,
): Promise<PushReconcileOutcome> {
  const json = await deps.getSubscriptionJson()
  const endpoint = json?.endpoint ?? null
  if (!endpoint) return "no-subscription"

  // ⚠️ **主が切ったものを、こちらの都合で戻さぬ。** 設定カードの解除は
  // ブラウザ側の `unsubscribe()` と対じゃが、それが失敗しうる（圏外・権限）。
  // 印が残っておれば、ここが最後の砦になる。印は endpoint 単位ゆえ、購読が
  // 回れば（＝ 別の endpoint になれば）自動で効かなくなる — 恒久的に
  // 通知を殺してしまわぬための設計じゃ。
  if (deps.readOptOut() === endpoint) return "opted-out"

  // セッション内の再走を止める（上の「代償」を参照）。
  // ⚠️ 印は **利用者 × endpoint** じゃ。どちらかが変われば必ずもう一度走る。
  const marker = buildReconcileMarker(deps.userId, endpoint)
  if (deps.readMarker() === marker) return "already-reconciled"

  const p256dh = json?.keys?.p256dh ?? null
  const auth = json?.keys?.auth ?? null
  // 鍵が欠けた購読を送っても DB の CHECK で落ちるだけじゃ。ここで畳む。
  if (!p256dh || !auth) return "incomplete"

  const accepted = await deps.register({
    endpoint,
    p256dh,
    auth,
    userAgent: deps.userAgent,
  })
  // ⚠️ **成功した時だけ印を付ける。** 失敗で印を付けると、セッションの間ずっと
  // 再試行できなくなる（＝ 直す機会を自分で捨てる）。
  if (!accepted) return "rejected"
  deps.writeMarker(marker)
  return "registered"
}

/**
 * 応答が「本当に登録された」ことを表すか。
 *
 * ⚠️ **`res.ok` を信じるな。** `/api/push/resubscribe` は `src/proxy.ts` の
 * 承認ゲートを通る。セッション切れなら `/login` へ、未承認なら
 * `/pending-approval` へ **307** が返り、fetch が既定でそれを追うと
 * **HTML の 200**（`res.ok === true`）になる。何も登録されておらぬのに
 * 「登録できた」と印を付けてしまい、そのセッションの間ずっと直らぬ。
 * `public/sw.js` の `isResubscribeAccepted` と同じ判定じゃ（classic script ゆえ
 * import できず、実装が 2 箇所に在る。片方を直したら必ずもう片方も見よ）。
 */
export async function isResubscribeAccepted(
  res: {
    status: number
    headers: { get: (name: string) => string | null }
    json: () => Promise<unknown>
  } | null,
): Promise<boolean> {
  if (!res || res.status !== 200) return false
  const contentType = res.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) return false
  try {
    const body = (await res.json()) as { ok?: unknown } | null
    return Boolean(body && body.ok === true)
  } catch (err) {
    console.warn("[push-reconcile] 再登録の応答を JSON として読めなかった:", err)
    return false
  }
}
