import { describe, it, expect } from "vitest"
import {
  applyInboxView,
  parseInboxView,
  toInboxListItem,
  toSubmitterListItem,
  toTimelineEntries,
  type FeedbackEventRow,
  type FeedbackListRow,
} from "../feedback-view"

const listRow = (over: Partial<FeedbackListRow> = {}): FeedbackListRow => ({
  id: "fb1",
  title: "夜は暗く",
  status: "in_progress",
  created_at: "2026-10-25T00:00:00Z",
  updated_at: "2026-10-25T01:00:00Z",
  submitter_name: "妻",
  submitter_has_unseen: false,
  operator_seen_at: "2026-10-25T00:30:00Z",
  released_commit_sha: null,
  released_note: null,
  released_observed_deploy: null,
  released_verified_at: null,
  ...over,
})

const event = (over: Partial<FeedbackEventRow> = {}): FeedbackEventRow => ({
  id: "ev1",
  feedback_id: "fb1",
  kind: "status_changed",
  actor_role: "operator",
  from_status: "received",
  to_status: "considering",
  comment: null,
  merge_ref: null,
  release_commit_sha: null,
  release_note: null,
  release_observed_deploy: null,
  release_verified_at: null,
  created_at: "2026-10-25T01:00:00Z",
  ...over,
})

describe("一覧の 1 行", () => {
  it("投稿者の一覧は詳細へ繋ぎ、未読の更新を文字で示す", () => {
    expect(toSubmitterListItem(listRow({ submitter_has_unseen: true }))).toMatchObject({
      href: "/feedback/fb1",
      marker: "更新あり",
      metaLabel: "10/25 10:00 更新",
      released: false,
    })
  })
  it("受信箱は受信箱の詳細へ繋ぎ、未読と提出者を出す", () => {
    expect(toInboxListItem(listRow({ operator_seen_at: null }))).toMatchObject({
      href: "/feedback/inbox/fb1",
      marker: "未読",
      submitterName: "妻",
    })
  })
  it("released でも証拠が欠ければ released=false（反映済みとして描かぬ）", () => {
    expect(toSubmitterListItem(listRow({ status: "released" })).released).toBe(false)
    expect(
      toSubmitterListItem(
        listRow({
          status: "released",
          released_commit_sha: "abcdef1",
          released_verified_at: "2026-10-25T02:00:00Z",
        }),
      ).released,
    ).toBe(true)
  })
})

describe("受信箱の絞り込み", () => {
  it("未知の値は「未対応」へ退化させる", () => {
    expect(parseInboxView("done")).toBe("done")
    expect(parseInboxView(["done"])).toBe("open")
    expect(parseInboxView("evil")).toBe("open")
    expect(parseInboxView(undefined)).toBe("open")
  })
  /** 絞り込みの呼び出しを記録する fake（PostgREST の 3 つの絞り込みだけ）。 */
  function recorder() {
    const calls: unknown[][] = []
    const q = {
      not: (...args: unknown[]) => (calls.push(["not", ...args]), q),
      is: (...args: unknown[]) => (calls.push(["is", ...args]), q),
      in: (...args: unknown[]) => (calls.push(["in", ...args]), q),
    }
    return { q, calls }
  }
  it("未対応は「完了の 2 つ以外」の denylist で絞る（未知の状態も未対応に残す）", () => {
    const { q, calls } = recorder()
    applyInboxView(q, "open")
    expect(calls).toEqual([["not", "status", "in", "(released,declined)"]])
  })
  it("未読はどの運用者も開いておらぬもの", () => {
    const { q, calls } = recorder()
    applyInboxView(q, "unread")
    expect(calls).toEqual([["is", "operator_seen_at", null]])
  })
  it("完了は反映済みと見送り", () => {
    const { q, calls } = recorder()
    applyInboxView(q, "done")
    expect(calls).toEqual([["in", "status", ["released", "declined"]]])
  })
  it("すべては絞らぬ", () => {
    const { q, calls } = recorder()
    applyInboxView(q, "all")
    expect(calls).toEqual([])
  })
})

describe("履歴", () => {
  it("released の履歴は証拠が揃う時だけ release を持つ", () => {
    const [withEvidence, without] = toTimelineEntries([
      event({
        id: "a",
        to_status: "released",
        release_commit_sha: "abcdef1",
        release_verified_at: "2026-10-25T03:00:00Z",
        release_note: "v1.7.0",
      }),
      event({ id: "b", to_status: "released" }),
    ])
    expect(withEvidence.release).toEqual({
      commitSha: "abcdef1",
      note: "v1.7.0",
      verifiedLabel: "10/25 12:00",
    })
    expect(without.release).toBeNull()
  })
  it("運用者の画面だけ知らせの状況を添える（無ければ宛先なし）", () => {
    const summaries = new Map([
      ["ev1", { queued: 0, accepted: 1, unconfirmed: 0, gone: 0, expired: 0, revoked: 0, superseded: 0 }],
    ])
    const [withPush] = toTimelineEntries([event()], summaries)
    expect(withPush.pushLabel).toContain("受理 1 台")
    const [none] = toTimelineEntries([event({ id: "other" })], summaries)
    expect(none.pushLabel).toMatch(/宛先なし/)
    const [submitterView] = toTimelineEntries([event()])
    expect(submitterView.pushLabel).toBeUndefined()
  })
  it("未知の種別は other に退化させる", () => {
    expect(toTimelineEntries([event({ kind: "reopened" })])[0].kind).toBe("other")
  })
})
