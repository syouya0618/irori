import {
  fetchWithTimeout,
  readJsonSafe,
  summarizeErrorBody,
} from "@/lib/google/fetch-with-timeout"

/**
 * Google Calendar API v3 の I/O シェル（計画書 §D-3）。
 *
 * 純関数コア（`src/lib/domain/google-calendar-sync.ts`）へは**依存せぬ**。
 * 生イベントの型は呼び出し側が型引数で与える（D-5 が `GoogleRawEvent` を渡す）。
 *
 * ## Google 公式 `events.list` リファレンスの一次情報（原文引用）
 *
 * 1. **syncToken と併用できぬパラメータ**:
 *    > "These are: `iCalUID`, `orderBy`, `privateExtendedProperty`, `q`,
 *    >  `sharedExtendedProperty`, `timeMin`, `timeMax`, `updatedMin`"
 *    → **`timeMin` はフル同期の初回のみ**。増分同期に付けたら 400 で壊れる。
 *      本モジュールは params を判別可能ユニオンにしてある。**実測（tsc 6）**:
 *      オブジェクトリテラルで `{ mode:"incremental", syncToken, timeMin }` と
 *      書けば TS2353 で落ちる（通常の呼び出し形はこれゆえ実用上は塞がる）が、
 *      **一旦変数へ組んでから渡す経路は excess property check が効かず素通りする**。
 *      ゆえに最終的な担保は型ではなく `buildEventsUrl` の構造
 *      （incremental 分岐が `timeMin` を書く行を持たぬこと）と、それを固定する
 *      `__tests__/calendar-client.test.ts` の URL 契約テストじゃ。
 * 2. **410 GONE**:
 *    > "If the `syncToken` expires, the server will respond with a 410 GONE response
 *    >  code and the client should clear its storage and perform a full
 *    >  synchronization without any `syncToken`."
 * 3. **ページネーション**（Synchronize resources efficiently ガイド）:
 *    > "If the result set is too large and the response gets paginated, then the
 *    >  `nextSyncToken` field is present only on the very last page."
 * 4. **増分同期の削除**:
 *    > "The result will always contain deleted entries, so that the clients get the
 *    >  chance to remove them from storage."
 *    → ゆえに `showDeleted=false` でも増分同期は cancelled を運ぶ。フル同期側で
 *      cancelled を引かずに済むこの値を**両モード共通**にしてある。
 * 5. **maxResults**:
 *    > "By default the value is 250 events. The page size can never be larger than 2500 events."
 */

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3"

/**
 * 全リクエストで固定する値（増分・フルで**同一**に保つ）。
 * 揺らすと Google 側の差分計算と我々のミラーが食い違う。
 */
export const EVENTS_SINGLE_EVENTS = "true"
/** 上記 4 の一次情報により、増分同期の削除検知はこの値に依存せぬ。 */
export const EVENTS_SHOW_DELETED = "false"
/** Google の既定値と同一（上限は 2500）。 */
export const EVENTS_MAX_RESULTS = "250"

/**
 * 暴走防止。250 件 × 200 ページ = 5 万件で打ち切る。
 * **黙って打ち切らず throw する**（無音の欠落はページネーションで最も高くつく事故ゆえ）。
 */
const MAX_EVENT_PAGES = 200
const MAX_CALENDAR_LIST_PAGES = 50

/**
 * 失敗の種別。**この 4 値は `google_connections.last_error_kind` の CHECK
 * （`'invalid_grant' | 'gone' | 'quota' | 'network' | 'unknown'`）の部分集合**ゆえ、
 * D-5 は変換せずそのまま DB へ書ける。
 *
 * - `gone`   : 410。syncToken 失効。`sync_token=NULL` にしてミラーを掃除し、
 *              次回フル同期させること（計画書 §D-3「410 フル再同期」）。
 * - `quota`  : 403 / 429。一過性。次回トリガで自動回復。
 * - `network`: 接続断 / timeout。一過性。
 * - `unknown`: 上記以外。
 *
 * ## D-5 への契約: **401 は `kind='unknown'` + `status=401` で来る**
 * access token の期限切れ・失効は「新しい kind」を発明せず `status` で運ぶ
 * （kind を増やすと DB の CHECK に無い値になり、書き込みが落ちる）。
 * D-5 は `err.status === 401` を見て `refreshAccessToken()` → 1 回だけ再試行し、
 * その refresh が `GoogleAuthError.kind==='invalid_grant'` なら `needs_reauth` へ
 * 遷移させること。
 */
export type GoogleCalendarErrorKind = "gone" | "quota" | "network" | "unknown"

export class GoogleCalendarError extends Error {
  readonly kind: GoogleCalendarErrorKind
  /** HTTP status（ネットワーク層の失敗では null）。401 の弁別に使う（上記契約）。 */
  readonly status: number | null
  /** Google が返したエラー記述の要約（機密は含まぬ）。 */
  readonly googleError: string | null

  constructor(
    kind: GoogleCalendarErrorKind,
    message: string,
    options: { status?: number | null; googleError?: string | null } = {}
  ) {
    super(message)
    this.name = "GoogleCalendarError"
    this.kind = kind
    this.status = options.status ?? null
    this.googleError = options.googleError ?? null
  }
}

/** `calendarList.list` の 1 件（我々が読む部分だけ）。 */
export interface GoogleCalendarListEntry {
  id: string
  /** 表示名。欠落しうる（`google_calendar_subscriptions.summary` は nullable）。 */
  summary: string | null
  primary: boolean
  /** "owner" | "reader" | "writer" | "freeBusyReader"（未知値もありうる）。 */
  accessRole: string | null
}

/**
 * `events.list` のクエリ種別。
 *
 * **判別可能ユニオンにしてある理由**: `timeMin` と `syncToken` の併用は Google が
 * 明示的に禁じており（上記一次情報 1）、増分同期に `timeMin` を付けると
 * 「未来のみ同期」のつもりが 400 で全滅する。オプショナル項目の集合にすると
 * 併用が**型として書けてしまう**ため、判別子で分けて呼び出し側の事故を減らす。
 * ただし型だけに頼るな — 変数経由の呼び出しは型検査をすり抜ける（上記一次情報 1
 * の実測メモを見よ）。真の担保は `buildEventsUrl` の構造と URL 契約テストじゃ。
 */
export type GoogleEventsQuery =
  /** フル同期。**`timeMin` を付けてよいのはこちらだけ**。 */
  | { mode: "full"; timeMin: string }
  /** 増分同期。`timeMin` / `timeMax` / `updatedMin` / `orderBy` 等は付けてはならぬ。 */
  | { mode: "incremental"; syncToken: string }

export type GoogleEventsPageParams = GoogleEventsQuery & {
  pageToken?: string | null
}

export interface GoogleEventsPage<T> {
  items: T[]
  /** 次ページがあれば非 null。 */
  nextPageToken: string | null
  /** **最終ページにのみ載る**（上記一次情報 3）。 */
  nextSyncToken: string | null
}

export interface GoogleEventsResult<T> {
  events: T[]
  /**
   * 最終ページから得た増分トークン。
   *
   * ## D-5 への契約: **null を保存するな**
   * Google が最終ページで `nextSyncToken` を返さぬ異常時に `sync_token=NULL` を
   * 書くと、以後**永久にフル同期へ退化**して増分同期が静かに死ぬ。
   * `null` のときは既存の `sync_token` を**据え置く**こと
   * （410 による意図的な NULL 化とは経路を分けよ）。
   */
  nextSyncToken: string | null
}

/**
 * `events.list` の URL を組み立てる。**export せぬ**
 * （テストは必ず `global.fetch` の stub 越しに実 URL を検査すること。
 *  builder を直接テストすると「実際に投げた URL」の保証にならぬ）。
 */
function buildEventsUrl(
  calendarId: string,
  params: GoogleEventsPageParams
): string {
  const url = new URL(
    `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`
  )
  // ── 増分・フルで同一に保つ 3 値 ──
  url.searchParams.set("singleEvents", EVENTS_SINGLE_EVENTS)
  url.searchParams.set("showDeleted", EVENTS_SHOW_DELETED)
  url.searchParams.set("maxResults", EVENTS_MAX_RESULTS)

  if (params.mode === "incremental") {
    url.searchParams.set("syncToken", params.syncToken)
    // ここに timeMin / timeMax / updatedMin / orderBy / q を足してはならぬ。
    // 併用は Google が禁じており、増分同期が 400 で全滅する。
  } else {
    url.searchParams.set("timeMin", params.timeMin)
  }

  if (params.pageToken) {
    url.searchParams.set("pageToken", params.pageToken)
  }
  return url.toString()
}

/** HTTP status → `GoogleCalendarErrorKind`。 */
function classifyStatus(status: number): GoogleCalendarErrorKind {
  if (status === 410) return "gone"
  // 403 は rateLimitExceeded / userRateLimitExceeded / quotaExceeded を含む。
  // 429 は Too Many Requests。いずれも一過性ゆえ恒久失敗と混ぜぬ。
  if (status === 403 || status === 429) return "quota"
  return "unknown"
}

/** Calendar API を 1 回叩き、失敗を `GoogleCalendarError` へ写す共通経路。 */
async function requestCalendarApi(
  url: string,
  accessToken: string,
  scope: string
): Promise<unknown> {
  const outcome = await fetchWithTimeout(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!outcome.ok) {
    // timeout も接続断も一過性。`AbortError` だけを見ると undici の
    // `TypeError: fetch failed`（DNS/接続失敗）が `unknown` へ誤分類される。
    console.error(`[${scope}] ネットワーク層で失敗`, {
      aborted: outcome.aborted,
      message: outcome.message,
    })
    throw new GoogleCalendarError("network", "Google への接続に失敗しました")
  }

  const { response } = outcome
  const payload = await readJsonSafe(response)

  if (!response.ok) {
    const kind = classifyStatus(response.status)
    const googleError = summarizeErrorBody(payload)
    // access token は載せぬ（URL にも含めておらぬ。Authorization ヘッダのみ）。
    console.error(`[${scope}] Calendar API が失敗`, {
      status: response.status,
      kind,
      googleError,
    })
    throw new GoogleCalendarError(kind, "Google カレンダーの取得に失敗しました", {
      status: response.status,
      googleError,
    })
  }

  return payload
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 購読可能なカレンダー一覧を全ページ取得する。
 *
 * 終端は Google のトークン方式に従い「`nextPageToken` が無いこと」で判定する
 * （OFFSET ページングではないため件数比較による終端判定は使わぬ）。
 */
export async function fetchCalendarList(
  accessToken: string
): Promise<GoogleCalendarListEntry[]> {
  const entries: GoogleCalendarListEntry[] = []
  let pageToken: string | null = null
  let pages = 0

  do {
    if (pages >= MAX_CALENDAR_LIST_PAGES) {
      // 無音で打ち切らぬ。打ち切りは「カレンダーが一覧に出ない」として表面化する。
      throw new GoogleCalendarError(
        "unknown",
        `カレンダー一覧のページ数が上限 ${MAX_CALENDAR_LIST_PAGES} を超えました`
      )
    }
    const url = new URL(`${CALENDAR_API_BASE}/users/me/calendarList`)
    url.searchParams.set("maxResults", "250")
    if (pageToken) url.searchParams.set("pageToken", pageToken)

    const payload = await requestCalendarApi(
      url.toString(),
      accessToken,
      "google-calendar:list"
    )
    const record = (payload ?? {}) as Record<string, unknown>
    for (const raw of asArray(record.items)) {
      const item = (raw ?? {}) as Record<string, unknown>
      const id = asStringOrNull(item.id)
      // id 無しは購読キーを作れぬゆえ捨てる（黙らず理由を残す）。
      if (id === null) {
        console.warn("[google-calendar:list] id を持たぬカレンダーを破棄")
        continue
      }
      entries.push({
        id,
        summary: asStringOrNull(item.summary),
        primary: item.primary === true,
        accessRole: asStringOrNull(item.accessRole),
      })
    }

    const nextPageToken = asStringOrNull(record.nextPageToken)
    // 同じ pageToken が返り続けると無限ループになる。
    if (nextPageToken !== null && nextPageToken === pageToken) {
      throw new GoogleCalendarError(
        "unknown",
        "カレンダー一覧の pageToken が前進しません"
      )
    }
    pageToken = nextPageToken
    pages += 1
  } while (pageToken !== null)

  return entries
}

/**
 * `events.list` を 1 ページ取得する。
 *
 * 生イベントの型は呼び出し側が与える（D-5 が `GoogleRawEvent` を渡し、
 * そのまま `diffPage` へ流せる。ここで D-2 を import せぬための型引数じゃ）。
 *
 * ## D-5 への契約: **全ページ走査を自前でループするな**
 * 必ず `fetchAllEventPages()` を通せ。ここを手で回すと「`nextSyncToken` は最終
 * ページのみ」という規則を各呼び出し側で再実装することになり、本 PR が塞いだ
 * 事故（途中ページのトークンを保存し、以後の差分を永久に取り逃す）が戻る。
 * この関数を直接使ってよいのは、1 ページだけ覗く診断用途に限る。
 */
export async function fetchEventsPage<T = unknown>(
  accessToken: string,
  calendarId: string,
  params: GoogleEventsPageParams
): Promise<GoogleEventsPage<T>> {
  const url = buildEventsUrl(calendarId, params)
  const payload = await requestCalendarApi(
    url,
    accessToken,
    "google-calendar:events"
  )
  const record = (payload ?? {}) as Record<string, unknown>
  return {
    items: asArray(record.items) as T[],
    nextPageToken: asStringOrNull(record.nextPageToken),
    nextSyncToken: asStringOrNull(record.nextSyncToken),
  }
}

/**
 * `events.list` を**全ページ**取得し、最終ページの `nextSyncToken` だけを返す。
 *
 * 一次情報どおり `nextSyncToken` は最終ページにしか載らぬ。途中ページのトークンを
 * 拾って保存すると、以後の増分同期が**取りこぼした差分を永久に取り戻せぬ**
 * （その間の変更は次の 410 か再連携までミラーに現れぬ）。ゆえにこの関数は
 * **`nextPageToken` が無いページの値だけ**を採る。
 */
export async function fetchAllEventPages<T = unknown>(
  accessToken: string,
  calendarId: string,
  query: GoogleEventsQuery
): Promise<GoogleEventsResult<T>> {
  const events: T[] = []
  let pageToken: string | null = null
  let pages = 0

  for (;;) {
    if (pages >= MAX_EVENT_PAGES) {
      // 無音の欠落を作らぬ。ここで throw すれば sync_token も前進せず、
      // 次回同じ差分をもう一度取りに行ける。
      throw new GoogleCalendarError(
        "unknown",
        `イベントのページ数が上限 ${MAX_EVENT_PAGES} を超えました`
      )
    }
    // 明示注釈が要る: `pageToken` は下で `page.nextPageToken` から代入されるため、
    // 注釈が無いと TS が page の型を自身の初期化子から推論しようとして TS7022 になる。
    const page: GoogleEventsPage<T> = await fetchEventsPage<T>(
      accessToken,
      calendarId,
      { ...query, pageToken }
    )
    events.push(...page.items)
    pages += 1

    // 終端: nextPageToken が無い = このページが最終ページ。
    if (page.nextPageToken === null) {
      return { events, nextSyncToken: page.nextSyncToken }
    }
    if (page.nextPageToken === pageToken) {
      throw new GoogleCalendarError(
        "unknown",
        "イベントの pageToken が前進しません"
      )
    }
    pageToken = page.nextPageToken
  }
}
