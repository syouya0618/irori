/**
 * 設定ページ（Server Component）→ SettingsContent への配線。
 *
 * ## P1-02: 承認カードは**インスタンスの運用者だけ**に出す
 * かつては世帯の owner なら誰でも `get_pending_approvals` を叩き、相互に信頼せぬ
 * 他世帯の新規登録者（email 入り）を自世帯の設定画面に「承認待ち」として見ておった。
 * いまは `is_app_operator()` が true の時だけ一覧を引く。判定に失敗したら**閉じる**
 * （カードを出さぬ）。運用者が一覧を読めなかった時は「0 件」と偽らず null で渡す。
 *
 * ## P2-31: 世帯を読めなかった時に空欄のフォームを渡さぬ
 * `?? null` と既定の授乳間隔で埋めて渡すと、保存の 1 クリックで名前と生年月日が
 * NULL に上書きされる。読めなかったことを null で運ぶ。
 *
 * page.tsx を描画はせず、返る要素の props だけを見る（SettingsContent は spy）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactElement } from "react"

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`)
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
}))

type Result = { data: unknown; error: unknown }

let tableResults: Record<string, Result> = {}
let rpcResults: Record<string, Result> = {}
const rpc = vi.fn((name: string) =>
  Promise.resolve(rpcResults[name] ?? { data: null, error: null }),
)

/** select/eq/... を何段でも受け、single/maybeSingle/await のどれでも結果を返す鎖 */
function chain(table: string) {
  const result = () =>
    Promise.resolve(tableResults[table] ?? { data: null, error: null })
  const c: Record<string, unknown> = {}
  for (const method of ["select", "eq", "not", "order", "limit", "in", "is"]) {
    c[method] = () => c
  }
  c.single = result
  c.maybeSingle = result
  c.then = (
    onFulfilled: (value: Result) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => result().then(onFulfilled, onRejected)
  return c
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => chain(table),
    rpc: (name: string) => rpc(name),
  }),
}))

vi.mock("@/lib/supabase/verified-user", () => ({
  getVerifiedUser: async () => ({ userId: "u1", email: "me@example.com" }),
}))

vi.mock("@/lib/supabase/child-context", () => ({ getChildContext: async () => {
  const h = tableResults.households?.data as Record<string, unknown> | null
  return { child: { id: "synthetic-child", is_legacy: true, name: h?.baby_name, birth_date: h?.baby_birth_date, feeding_interval_min: h?.feeding_interval_min } }
} }))

const logSupabaseError = vi.fn()
vi.mock("@/lib/supabase/log-error", () => ({
  logSupabaseError: (...args: unknown[]) => logSupabaseError(...args),
}))

vi.mock("../settings-content", () => ({
  SettingsContent: () => null,
}))

import SettingsPage from "../page"

const PENDING_USER = {
  id: "p1",
  display_name: "しんき",
  email: "new@example.com",
  created_at: "2026-10-01T00:00:00.000Z",
}

function profileRow(role: "owner" | "member" = "owner") {
  return {
    data: {
      id: "u1",
      display_name: "テスト",
      avatar_url: null,
      household_id: "h1",
      role,
      default_page: "baby",
    },
    error: null,
  }
}

const HOUSEHOLD_OK: Result = {
  data: {
    id: "h1",
    name: "我が家",
    baby_name: "あかり",
    baby_birth_date: "2026-05-01",
    feeding_interval_min: 150,
  },
  error: null,
}

const DB_ERROR = { message: "boom", code: "XX000", details: null, hint: null }

async function renderProps(): Promise<Record<string, unknown>> {
  const element = (await SettingsPage({
    searchParams: Promise.resolve({}),
  })) as ReactElement<Record<string, unknown>>
  return (element.props.children as ReactElement<Record<string, unknown>>).props
}

const rpcNames = () => rpc.mock.calls.map(([name]) => name)

beforeEach(() => {
  rpc.mockClear()
  logSupabaseError.mockClear()
  tableResults = {
    profiles: profileRow("owner"),
    households: HOUSEHOLD_OK,
    google_connections: { data: [], error: null },
    push_subscriptions: { data: [], error: null },
    notification_heartbeat: { data: null, error: null },
    notification_deliveries: { data: null, error: null },
    notification_preferences: { data: null, error: null },
  }
  rpcResults = {
    is_app_operator: { data: false, error: null },
    get_pending_approvals: { data: [PENDING_USER], error: null },
  }
})

describe("承認カードの可否は is_app_operator で決める（P1-02）", () => {
  it("運用者でない owner には一覧を引かず、カードも出さぬ", async () => {
    const props = await renderProps()

    expect(rpcNames()).toContain("is_app_operator")
    expect(rpcNames()).not.toContain("get_pending_approvals")
    expect(props.isAppOperator).toBe(false)
    expect(props.pendingUsers).toEqual([])
  })

  it("運用者には一覧を引いて渡す", async () => {
    rpcResults.is_app_operator = { data: true, error: null }

    const props = await renderProps()

    expect(rpcNames()).toContain("get_pending_approvals")
    expect(props.isAppOperator).toBe(true)
    expect(props.pendingUsers).toEqual([PENDING_USER])
  })

  it("運用者なら世帯の役割（member）に依らず一覧を引く", async () => {
    tableResults.profiles = profileRow("member")
    rpcResults.is_app_operator = { data: true, error: null }

    const props = await renderProps()

    expect(rpcNames()).toContain("get_pending_approvals")
    expect(props.isAppOperator).toBe(true)
  })

  it("判定に失敗したら閉じる: ログに残し、一覧を引かず、カードを出さぬ", async () => {
    rpcResults.is_app_operator = { data: null, error: DB_ERROR }

    const props = await renderProps()

    expect(logSupabaseError).toHaveBeenCalledWith(
      "settings",
      expect.stringContaining("is_app_operator"),
      DB_ERROR,
      expect.objectContaining({ userId: "u1" }),
    )
    expect(rpcNames()).not.toContain("get_pending_approvals")
    expect(props.isAppOperator).toBe(false)
  })

  it("true 以外の値（null・文字列）は運用者とみなさぬ", async () => {
    for (const data of [null, "true", 1]) {
      rpc.mockClear()
      rpcResults.is_app_operator = { data, error: null }
      const props = await renderProps()
      expect(props.isAppOperator, String(data)).toBe(false)
      expect(rpcNames()).not.toContain("get_pending_approvals")
    }
  })

  it("運用者が一覧を読めなかったら「0 件」と偽らず null を渡す", async () => {
    rpcResults.is_app_operator = { data: true, error: null }
    rpcResults.get_pending_approvals = { data: null, error: DB_ERROR }

    const props = await renderProps()

    expect(logSupabaseError).toHaveBeenCalledWith(
      "settings",
      "pending approvals lookup failed",
      DB_ERROR,
      expect.any(Object),
    )
    expect(props.isAppOperator).toBe(true)
    expect(props.pendingUsers).toBeNull()
  })
})

describe("世帯を読めなかった時（P2-31）", () => {
  it("households の取得に失敗したら babyProfile / household を null で渡す（空欄のフォームにせぬ）", async () => {
    tableResults.households = { data: null, error: DB_ERROR }

    const props = await renderProps()

    expect(logSupabaseError).toHaveBeenCalledWith(
      "settings",
      "household lookup failed",
      DB_ERROR,
      expect.objectContaining({ householdId: "h1" }),
    )
    expect(props.babyProfile).toBeNull()
    expect(props.household).toBeNull()
  })

  it("読めた時は値をそのまま渡す（対照）", async () => {
    const props = await renderProps()

    expect(props.babyProfile).toEqual({
      name: "あかり",
      birthDate: "2026-05-01",
      feedingIntervalMin: 150,
    })
    expect(props.household).toEqual({ id: "h1", name: "我が家" })
  })
})

describe("読めなかった接続・端末を「無い」と描かせぬ（Agent C）", () => {
  const CONNECTION = {
    id: "c1",
    google_email: "a@example.com",
    connection_status: "active",
    sync_status: "idle",
    last_error_kind: null,
    last_synced_at: null,
  }

  it("Google 接続の取得に失敗したら googleConnectionsUnknown を立てる", async () => {
    tableResults.google_connections = { data: null, error: DB_ERROR }
    const props = await renderProps()
    expect(props.googleConnectionsUnknown).toBe(true)
    expect(props.googleConnections).toEqual([])
  })

  it("通知端末の取得に失敗したら pushDevicesUnknown を立てる", async () => {
    tableResults.push_subscriptions = { data: null, error: DB_ERROR }
    const props = await renderProps()
    expect(props.pushDevicesUnknown).toBe(true)
  })

  it("購読一覧の取得に失敗したら接続ごとに calendarsUnknown を立てる（再接続へ誘わぬ）", async () => {
    tableResults.google_connections = { data: [CONNECTION], error: null }
    tableResults.google_calendar_subscriptions = { data: null, error: DB_ERROR }
    const props = await renderProps()
    const views = props.googleConnections as Array<Record<string, unknown>>
    expect(views[0].calendarsUnknown).toBe(true)
    expect(views[0].calendars).toEqual([])
  })

  it("対照: 読めた時はどの旗も立てぬ", async () => {
    tableResults.google_connections = { data: [CONNECTION], error: null }
    tableResults.google_calendar_subscriptions = { data: [], error: null }
    const props = await renderProps()
    expect(props.googleConnectionsUnknown).toBe(false)
    expect(props.pushDevicesUnknown).toBe(false)
    const views = props.googleConnections as Array<Record<string, unknown>>
    expect(views[0].calendarsUnknown).toBe(false)
  })
})

describe("要望・改善提案の件数（ヘルプのカード）", () => {
  it("運用者でなければ受信箱を数えず、導線も出させぬ", async () => {
    tableResults.feedback_items = { data: null, error: null, count: 2 } as Result
    const props = await renderProps()
    expect(props.feedback).toEqual({ unseenUpdates: 2, isAppOperator: false, inboxUnread: null })
  })

  it("運用者には受信箱の未読を数えて渡す（判定は is_app_operator・owner ではない）", async () => {
    tableResults.profiles = profileRow("member")
    rpcResults.is_app_operator = { data: true, error: null }
    tableResults.feedback_items = { data: null, error: null, count: 3 } as Result
    const props = await renderProps()
    expect(props.feedback).toEqual({ unseenUpdates: 3, isAppOperator: true, inboxUnread: 3 })
  })

  it("数えられなかった時は「0 件」と偽らず null（ログに残す）", async () => {
    rpcResults.is_app_operator = { data: true, error: null }
    tableResults.feedback_items = { data: null, error: DB_ERROR }
    const props = await renderProps()
    expect(props.feedback).toEqual({ unseenUpdates: null, isAppOperator: true, inboxUnread: null })
    expect(logSupabaseError).toHaveBeenCalledWith(
      "feedback",
      "unseen feedback count failed",
      DB_ERROR,
      expect.objectContaining({ userId: "u1" }),
    )
  })
})
