/**
 * 要望の各ページ（Server Component）の門と絞り込み。
 *
 * - 受信箱（一覧・詳細）は `is_app_operator()` が true の時だけ。違えば 404、判定の失敗は
 *   error boundary（「運用者でない」と断定せぬ）
 * - 投稿者の一覧・詳細は**自分の要望だけ**（運用者には RLS が全件を見せるゆえ、
 *   `submitter_id` の絞りを外すと運用者の「自分の要望」に他人の要望が混ざる）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ReactElement } from "react"

class NotFoundSignal extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("not-found")
  },
}))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

type Result = { data: unknown; error: unknown; count?: number }
interface Recorded {
  table: string
  filters: Array<[string, string, unknown]>
}

let tableResults: Record<string, Result> = {}
let rpcResults: Record<string, Result> = {}
let recorded: Recorded[] = []

function chain(table: string) {
  const record: Recorded = { table, filters: [] }
  recorded.push(record)
  const result = () => Promise.resolve(tableResults[table] ?? { data: null, error: null })
  const c: Record<string, unknown> = {}
  for (const method of ["select", "order", "limit"]) c[method] = () => c
  for (const method of ["eq", "is", "in"]) {
    c[method] = (column: string, value: unknown) => {
      record.filters.push([method, column, value])
      return c
    }
  }
  c.not = (column: string, operator: string, value: unknown) => {
    record.filters.push(["not", column, `${operator} ${String(value)}`])
    return c
  }
  c.maybeSingle = result
  c.single = result
  c.then = (ok: (v: Result) => unknown, ng?: (e: unknown) => unknown) => result().then(ok, ng)
  return c
}

const rpc = vi.fn((name: string) => Promise.resolve(rpcResults[name] ?? { data: null, error: null }))
const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

// 子の Client Component は描画に関わらぬ（ここで見るのは門と絞り込み）。
vi.mock("@/components/feedback/feedback-form", () => ({ FeedbackForm: () => null }))
vi.mock("@/components/feedback/feedback-seen-marker", () => ({ FeedbackSeenMarker: () => null }))
vi.mock("@/components/feedback/feedback-refresh-on-visible", () => ({
  FeedbackRefreshOnVisible: () => null,
}))
vi.mock("@/components/feedback/feedback-operator-panel", () => ({
  FeedbackOperatorPanel: () => null,
}))

import FeedbackPage from "../page"
import FeedbackDetailPage from "../[id]/page"
import FeedbackInboxPage from "../inbox/page"
import FeedbackInboxDetailPage from "../inbox/[id]/page"
import { FeedbackOperatorPanel } from "@/components/feedback/feedback-operator-panel"

/** Server Component が返した要素の木から、`type` の要素を探す（mock した子は描かれず、props だけが残る） */
function findElement(node: unknown, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== "object") return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type)
      if (found) return found
    }
    return null
  }
  const element = node as ReactElement<{ children?: unknown }>
  if (element.type === type) return element as ReactElement<Record<string, unknown>>
  return findElement(element.props?.children, type)
}

const ID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
const DB_ERROR = { message: "boom", code: "XX000" }

const ITEM = {
  id: ID,
  submitter_id: "wife",
  submitter_name: "妻",
  title: "夜は暗く",
  body: "",
  status: "received",
  version: 1,
  created_at: "2026-10-25T00:00:00Z",
  updated_at: "2026-10-25T00:00:00Z",
  operator_seen_at: null,
  submitter_has_unseen: false,
  released_commit_sha: null,
  released_note: null,
  released_observed_deploy: null,
  released_verified_at: null,
}

afterEach(() => {
  vi.unstubAllEnvs()
})

beforeEach(() => {
  vi.clearAllMocks()
  recorded = []
  tableResults = {
    feedback_items: { data: [ITEM], error: null },
    feedback_events: { data: [], error: null },
  }
  rpcResults = {
    is_app_operator: { data: false, error: null },
    get_feedback_push_summary: { data: [], error: null },
  }
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: { from: (t: string) => chain(t), rpc }, userId: "wife", householdId: "h1" },
  })
})

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const itemFilters = () =>
  recorded.filter((r) => r.table === "feedback_items").flatMap((r) => r.filters)

describe("受信箱の門（運用者だけ）", () => {
  it("運用者でなければ一覧も詳細も 404（受信箱の存在も見せぬ）", async () => {
    await expect(FeedbackInboxPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
      NotFoundSignal,
    )
    tableResults.feedback_items = { data: ITEM, error: null }
    await expect(FeedbackInboxDetailPage(params(ID))).rejects.toBeInstanceOf(NotFoundSignal)
    // 門の前で要望の表を引いておらぬ
    expect(recorded.filter((r) => r.table === "feedback_items")).toHaveLength(0)
  })

  it("true 以外（null・文字列）は運用者とみなさぬ", async () => {
    for (const data of [null, "true", 1]) {
      rpcResults.is_app_operator = { data, error: null }
      await expect(
        FeedbackInboxPage({ searchParams: Promise.resolve({}) }),
      ).rejects.toBeInstanceOf(NotFoundSignal)
    }
  })

  it("判定に失敗したら 404 ではなく error boundary へ（「運用者でない」と断定せぬ）", async () => {
    rpcResults.is_app_operator = { data: null, error: DB_ERROR }
    await expect(FeedbackInboxPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "運用者の確認に失敗しました",
    )
  })

  it("運用者には一覧を描く（対照）", async () => {
    rpcResults.is_app_operator = { data: true, error: null }
    const element = (await FeedbackInboxPage({
      searchParams: Promise.resolve({ view: "all" }),
    })) as ReactElement
    expect(element).toBeTruthy()
  })

  it("受信箱の一覧と件数は DB で絞る（既定は未対応 = 完了の 2 つ以外）", async () => {
    rpcResults.is_app_operator = { data: true, error: null }
    tableResults.feedback_items = { data: [ITEM], error: null, count: 7 }
    await FeedbackInboxPage({ searchParams: Promise.resolve({}) })
    const queries = recorded.filter((r) => r.table === "feedback_items")
    // 一覧 1 本 + 4 つの棚の件数
    expect(queries).toHaveLength(5)
    expect(queries[0].filters).toEqual([["not", "status", "in (released,declined)"]])
  })

  it("⚠️ 確定の可否は Action と同じ述語（VERCEL_ENV）で決めて panel へ渡す（SHA の無い preview も本番でない）", async () => {
    rpcResults.is_app_operator = { data: true, error: null }
    tableResults.feedback_items = { data: ITEM, error: null }
    vi.stubEnv("VERCEL_ENV", "preview")
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "")
    const preview = findElement(await FeedbackInboxDetailPage(params(ID)), FeedbackOperatorPanel)
    expect(preview?.props).toMatchObject({ nonProductionDeploy: true, runningDeploy: null })

    // 対照: 本番は止めず、稼働中のデプロイも渡す
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abcdef1234567")
    const production = findElement(await FeedbackInboxDetailPage(params(ID)), FeedbackOperatorPanel)
    expect(production?.props).toMatchObject({
      nonProductionDeploy: false,
      runningDeploy: "production:abcdef1234567",
    })
  })

  it("運用者の詳細は配信状況（数だけ）を引く", async () => {
    rpcResults.is_app_operator = { data: true, error: null }
    tableResults.feedback_items = { data: ITEM, error: null }
    await FeedbackInboxDetailPage(params(ID))
    expect(rpc).toHaveBeenCalledWith("get_feedback_push_summary", { p_feedback_id: ID })
  })
})

describe("投稿者の一覧・詳細は自分の要望だけ", () => {
  it("一覧は submitter_id で絞る（運用者でも他人の要望を混ぜぬ）", async () => {
    rpcResults.is_app_operator = { data: true, error: null }
    tableResults.feedback_items = { data: [ITEM], error: null, count: 0 }
    await FeedbackPage()
    expect(itemFilters()).toContainEqual(["eq", "submitter_id", "wife"])
  })

  it("詳細は submitter_id で絞り、見えぬ要望は 404", async () => {
    tableResults.feedback_items = { data: null, error: null }
    await expect(FeedbackDetailPage(params(ID))).rejects.toBeInstanceOf(NotFoundSignal)
    expect(itemFilters()).toContainEqual(["eq", "submitter_id", "wife"])
    expect(itemFilters()).toContainEqual(["eq", "id", ID])
  })

  it("id の形が違えば DB を引かずに 404", async () => {
    await expect(FeedbackDetailPage(params("../x"))).rejects.toBeInstanceOf(NotFoundSignal)
    await expect(FeedbackInboxDetailPage(params("../x"))).rejects.toBeInstanceOf(NotFoundSignal)
    expect(recorded).toHaveLength(0)
  })

  it("一覧を読めなかったら「まだ送っておらぬ」と偽らず error boundary へ", async () => {
    tableResults.feedback_items = { data: null, error: DB_ERROR }
    await expect(FeedbackPage()).rejects.toThrow("要望の一覧を取得できませんでした")
  })
})
