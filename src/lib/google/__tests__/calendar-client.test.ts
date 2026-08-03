/**
 * `calendar-client.ts` の **URL 契約**とエラー分類の回帰網（計画書 §D-6）。
 *
 * ## `global.fetch` の stub についての断り書き（グローバル規約との関係）
 * グローバル規約が禁じておるのは「**ブラウザ専用 I/O** を mock で隠し、node で
 * 落ちる事実を覆い隠すこと」（`fetch('/fonts/…')` のような相対 URL 等）。
 * ここでの stub は**ネットワーク境界**の stub じゃ。`calendar-client.ts` は
 * node/サーバ実行前提で、本番も同じ `fetch` API・同じ絶対 URL を使う
 * （相対 URL fetch も `localStorage` も `window` 依存も持たぬ）。
 * ゆえに「テスト緑・本番不動作」の死角は生まれず、本則には抵触せぬ。
 *
 * 実際の Google API は**一度も叩いておらぬ**（認証情報を持たぬ）。ここが固定して
 * おるのは「我々が投げる URL の形」と「返ってきた status の解釈」までじゃ。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  fetchCalendarList,
  fetchEventsPage,
  fetchAllEventPages,
  GoogleCalendarError,
  EVENTS_SINGLE_EVENTS,
  EVENTS_SHOW_DELETED,
  EVENTS_MAX_RESULTS,
} from "../calendar-client"
import { GOOGLE_FETCH_TIMEOUT_MS } from "../fetch-with-timeout"

const ACCESS_TOKEN = "ya29.test-access-token"
const CALENDAR_ID = "family@group.calendar.google.com"
const TIME_MIN = "2026-07-01T00:00:00.000Z"
const SYNC_TOKEN = "CPjq_-eLxYwDEPjq_-eLxYwDGAU="

/** JSON を返す成功レスポンス。 */
function jsonOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

/** エラーレスポンス（Calendar API は `{ error: { code, message } }` を返す）。 */
function jsonError(status: number, message = "boom"): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: { code: status, message } }),
  } as unknown as Response
}

/** 呼ばれた URL を記録しつつ順番に body を返す stub。 */
function stubFetchSequence(responses: Response[]) {
  const urls: string[] = []
  const headers: (HeadersInit | undefined)[] = []
  let index = 0
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url)
    headers.push(init?.headers)
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    return response
  })
  vi.stubGlobal("fetch", mock)
  return { urls, headers, mock }
}

/** 中断されるまで解決しない fetch（timeout の実発火を見るため）。 */
function stubHangingFetch() {
  const mock = vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.")
        err.name = "AbortError"
        reject(err)
      })
    })
  })
  vi.stubGlobal("fetch", mock)
  return mock
}

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ============================================================
// syncToken 併用禁止（これが最重要）
// ============================================================

describe("events.list の URL 契約", () => {
  it("【最重要】増分同期のリクエストに timeMin が絶対に含まれない", async () => {
    const { urls } = stubFetchSequence([jsonOk({ items: [] })])

    await fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "incremental",
      syncToken: SYNC_TOKEN,
    })

    expect(urls).toHaveLength(1)
    const params = paramsOf(urls[0])
    expect(params.has("timeMin")).toBe(false)
    expect(params.get("syncToken")).toBe(SYNC_TOKEN)
  })

  it("増分同期には syncToken と併用できぬパラメータが 1 つも含まれない", async () => {
    // Google 公式 events.list リファレンス原文:
    // "These are: iCalUID, orderBy, privateExtendedProperty, q,
    //  sharedExtendedProperty, timeMin, timeMax, updatedMin"
    const INCOMPATIBLE_WITH_SYNC_TOKEN = [
      "iCalUID",
      "orderBy",
      "privateExtendedProperty",
      "q",
      "sharedExtendedProperty",
      "timeMin",
      "timeMax",
      "updatedMin",
    ] as const
    const { urls } = stubFetchSequence([jsonOk({ items: [] })])

    await fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "incremental",
      syncToken: SYNC_TOKEN,
    })

    const params = paramsOf(urls[0])
    const violations = INCOMPATIBLE_WITH_SYNC_TOKEN.filter((key) =>
      params.has(key)
    )
    expect(violations).toEqual([])
  })

  it("増分の 2 ページ目（pageToken 付き）にも timeMin が混ざらない", async () => {
    const { urls } = stubFetchSequence([
      jsonOk({ items: [], nextPageToken: "p2" }),
      jsonOk({ items: [], nextSyncToken: "final" }),
    ])

    await fetchAllEventPages(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "incremental",
      syncToken: SYNC_TOKEN,
    })

    expect(urls).toHaveLength(2)
    for (const url of urls) {
      expect(paramsOf(url).has("timeMin")).toBe(false)
    }
    expect(paramsOf(urls[1]).get("pageToken")).toBe("p2")
  })

  it("フル同期は timeMin を含み syncToken を含まない", async () => {
    const { urls } = stubFetchSequence([jsonOk({ items: [] })])

    await fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "full",
      timeMin: TIME_MIN,
    })

    const params = paramsOf(urls[0])
    expect(params.get("timeMin")).toBe(TIME_MIN)
    expect(params.has("syncToken")).toBe(false)
  })

  it("両モードで singleEvents=true が固定される", async () => {
    const { urls } = stubFetchSequence([jsonOk({ items: [] })])

    await fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "full",
      timeMin: TIME_MIN,
    })
    await fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "incremental",
      syncToken: SYNC_TOKEN,
    })

    expect(urls).toHaveLength(2)
    for (const url of urls) {
      expect(paramsOf(url).get("singleEvents")).toBe("true")
    }
    // 定数側が "false" へ書き換わっても気付けるようにする。
    expect(EVENTS_SINGLE_EVENTS).toBe("true")
  })

  it("showDeleted / maxResults が両モードで完全に同一である", async () => {
    const { urls } = stubFetchSequence([jsonOk({ items: [] })])

    await fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "full",
      timeMin: TIME_MIN,
    })
    await fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "incremental",
      syncToken: SYNC_TOKEN,
    })

    const full = paramsOf(urls[0])
    const incremental = paramsOf(urls[1])
    expect(full.get("showDeleted")).toBe(incremental.get("showDeleted"))
    expect(full.get("maxResults")).toBe(incremental.get("maxResults"))
    expect(full.get("showDeleted")).toBe(EVENTS_SHOW_DELETED)
    expect(full.get("maxResults")).toBe(EVENTS_MAX_RESULTS)
  })

  it("access token は URL に出さず Authorization ヘッダで送る", async () => {
    const { urls, headers } = stubFetchSequence([jsonOk({ items: [] })])

    await fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "full",
      timeMin: TIME_MIN,
    })

    expect(urls[0]).not.toContain(ACCESS_TOKEN)
    expect(headers[0]).toMatchObject({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    })
  })

  it("calendarId は URL エンコードされる", async () => {
    const { urls } = stubFetchSequence([jsonOk({ items: [] })])

    await fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "full",
      timeMin: TIME_MIN,
    })

    expect(urls[0]).toContain(encodeURIComponent(CALENDAR_ID))
  })
})

// ============================================================
// ページネーション（nextSyncToken は最終ページのみ）
// ============================================================

describe("fetchAllEventPages のページネーション", () => {
  it("2 ページ以上のとき nextSyncToken を最終ページからのみ取る", async () => {
    // 途中ページにも（本来は載らぬ）トークンを置き、実装がそれを拾わぬことを見る。
    const { urls } = stubFetchSequence([
      jsonOk({
        items: [{ id: "a" }],
        nextPageToken: "p2",
        nextSyncToken: "TOKEN_FROM_PAGE_1_MUST_NOT_BE_USED",
      }),
      jsonOk({
        items: [{ id: "b" }],
        nextPageToken: "p3",
        nextSyncToken: "TOKEN_FROM_PAGE_2_MUST_NOT_BE_USED",
      }),
      jsonOk({ items: [{ id: "c" }], nextSyncToken: "TOKEN_FROM_LAST_PAGE" }),
    ])

    const result = await fetchAllEventPages<{ id: string }>(
      ACCESS_TOKEN,
      CALENDAR_ID,
      { mode: "incremental", syncToken: SYNC_TOKEN }
    )

    expect(urls).toHaveLength(3)
    expect(result.nextSyncToken).toBe("TOKEN_FROM_LAST_PAGE")
    expect(result.events.map((e) => e.id)).toEqual(["a", "b", "c"])
  })

  it("1 ページで終わるときはそのページの nextSyncToken を返す", async () => {
    stubFetchSequence([jsonOk({ items: [{ id: "a" }], nextSyncToken: "only" })])

    const result = await fetchAllEventPages(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "full",
      timeMin: TIME_MIN,
    })

    expect(result.nextSyncToken).toBe("only")
  })

  it("最終ページに nextSyncToken が無ければ null を返す（保存禁止の契約は D-5 側）", async () => {
    stubFetchSequence([jsonOk({ items: [] })])

    const result = await fetchAllEventPages(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "full",
      timeMin: TIME_MIN,
    })

    expect(result.nextSyncToken).toBeNull()
  })

  it("途中ページだけがトークンを持ち最終ページが持たねば null（拾い置きを禁じる）", async () => {
    // 「最後に見た非 null を採る」実装はこの形で初めて剥がれる。前のケース
    // （最終ページがトークンを持つ）はその実装でも通ってしまい弁別できぬ。
    // 途中ページのトークンを保存すると、そのページ以降の差分を**永久に取り
    // 逃す**（次の 410 か再連携までミラーに現れぬ）ゆえ null で落ちねばならぬ。
    stubFetchSequence([
      jsonOk({
        items: [],
        nextPageToken: "p2",
        nextSyncToken: "TOKEN_FROM_PAGE_1_MUST_NOT_BE_USED",
      }),
      jsonOk({ items: [] }),
    ])

    const result = await fetchAllEventPages(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "incremental",
      syncToken: SYNC_TOKEN,
    })

    expect(result.nextSyncToken).toBeNull()
  })

  it("pageToken が前進しなければ無限ループせず throw する", async () => {
    // 同じ pageToken を返し続ける異常な API を模す。
    stubFetchSequence([jsonOk({ items: [], nextPageToken: "same" })])

    await expect(
      fetchAllEventPages(ACCESS_TOKEN, CALENDAR_ID, {
        mode: "full",
        timeMin: TIME_MIN,
      })
    ).rejects.toBeInstanceOf(GoogleCalendarError)
  })
})

// ============================================================
// HTTP status の分類
// ============================================================

describe("HTTP status の分類", () => {
  it("410 → kind='gone'（syncToken 失効。フル再同期の合図）", async () => {
    stubFetchSequence([jsonError(410)])

    await expect(
      fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
        mode: "incremental",
        syncToken: SYNC_TOKEN,
      })
    ).rejects.toMatchObject({ kind: "gone", status: 410 })
  })

  it("403 → kind='quota'", async () => {
    stubFetchSequence([jsonError(403, "rateLimitExceeded")])

    await expect(
      fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
        mode: "full",
        timeMin: TIME_MIN,
      })
    ).rejects.toMatchObject({ kind: "quota", status: 403 })
  })

  it("429 → kind='quota'", async () => {
    stubFetchSequence([jsonError(429)])

    await expect(
      fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
        mode: "full",
        timeMin: TIME_MIN,
      })
    ).rejects.toMatchObject({ kind: "quota", status: 429 })
  })

  it("401 は kind='unknown' + status=401（D-5 は status で refresh 再試行を判断する）", async () => {
    stubFetchSequence([jsonError(401, "Invalid Credentials")])

    await expect(
      fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
        mode: "full",
        timeMin: TIME_MIN,
      })
    ).rejects.toMatchObject({ kind: "unknown", status: 401 })
  })

  it("500 → kind='unknown'", async () => {
    stubFetchSequence([jsonError(500)])

    await expect(
      fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
        mode: "full",
        timeMin: TIME_MIN,
      })
    ).rejects.toMatchObject({ kind: "unknown", status: 500 })
  })

  it("エラーは GoogleCalendarError のインスタンスである", async () => {
    stubFetchSequence([jsonError(410)])

    await expect(
      fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
        mode: "incremental",
        syncToken: SYNC_TOKEN,
      })
    ).rejects.toBeInstanceOf(GoogleCalendarError)
  })

  it("HTML など JSON でない body でも status の解釈が壊れない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 410,
        json: async () => {
          throw new SyntaxError("Unexpected token <")
        },
      }))
    )

    await expect(
      fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
        mode: "incremental",
        syncToken: SYNC_TOKEN,
      })
    ).rejects.toMatchObject({ kind: "gone", status: 410 })
  })
})

// ============================================================
// ネットワーク層（timeout / 接続断）
// ============================================================

describe("ネットワーク層の失敗", () => {
  it("AbortError → kind='network'", async () => {
    const abortError = new Error("aborted")
    abortError.name = "AbortError"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw abortError
      })
    )

    await expect(
      fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
        mode: "full",
        timeMin: TIME_MIN,
      })
    ).rejects.toMatchObject({ kind: "network", status: null })
  })

  it("undici の `TypeError: fetch failed`（DNS/接続断）も kind='network'", async () => {
    // AbortError だけを見る実装だと、ここが 'unknown'（恒久失敗扱い）へ落ちる。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      })
    )

    await expect(
      fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
        mode: "full",
        timeMin: TIME_MIN,
      })
    ).rejects.toMatchObject({ kind: "network" })
  })

  it("AbortController が 10 秒で実際に発火する（9.999 秒では発火せぬ）", async () => {
    vi.useFakeTimers()
    const mock = stubHangingFetch()

    const promise = fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "full",
      timeMin: TIME_MIN,
    })
    const assertion = expect(promise).rejects.toMatchObject({ kind: "network" })

    await vi.advanceTimersByTimeAsync(GOOGLE_FETCH_TIMEOUT_MS - 1)
    const signal = (mock.mock.calls[0][1] as RequestInit).signal
    expect(signal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(signal?.aborted).toBe(true)
    await assertion
  })

  it("成功時に timeout タイマーが残らない（clearTimeout が効いている）", async () => {
    vi.useFakeTimers()
    stubFetchSequence([jsonOk({ items: [] })])

    await fetchEventsPage(ACCESS_TOKEN, CALENDAR_ID, {
      mode: "full",
      timeMin: TIME_MIN,
    })

    expect(vi.getTimerCount()).toBe(0)
  })
})

// ============================================================
// calendarList
// ============================================================

describe("fetchCalendarList", () => {
  it("全ページを辿り、非機密フィールドだけを写す", async () => {
    const { urls } = stubFetchSequence([
      jsonOk({
        items: [{ id: "a", summary: "家族", primary: true, accessRole: "owner" }],
        nextPageToken: "p2",
      }),
      jsonOk({
        items: [{ id: "b", accessRole: "reader" }],
      }),
    ])

    const entries = await fetchCalendarList(ACCESS_TOKEN)

    expect(urls).toHaveLength(2)
    expect(paramsOf(urls[1]).get("pageToken")).toBe("p2")
    expect(entries).toEqual([
      { id: "a", summary: "家族", primary: true, accessRole: "owner" },
      // summary 欠落は null へ退化（`google_calendar_subscriptions.summary` は nullable）。
      { id: "b", summary: null, primary: false, accessRole: "reader" },
    ])
  })

  it("id を持たぬ項目は破棄し、残りは取り込む", async () => {
    stubFetchSequence([jsonOk({ items: [{ summary: "壊れ" }, { id: "ok" }] })])

    const entries = await fetchCalendarList(ACCESS_TOKEN)

    expect(entries.map((e) => e.id)).toEqual(["ok"])
  })

  it("403 → kind='quota'", async () => {
    stubFetchSequence([jsonError(403)])

    await expect(fetchCalendarList(ACCESS_TOKEN)).rejects.toMatchObject({
      kind: "quota",
      status: 403,
    })
  })

  it("items が配列でなくても落ちない", async () => {
    stubFetchSequence([jsonOk({ items: null })])

    await expect(fetchCalendarList(ACCESS_TOKEN)).resolves.toEqual([])
  })
})
