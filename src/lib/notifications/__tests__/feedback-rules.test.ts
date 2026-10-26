import { describe, it, expect } from "vitest"
import {
  buildFeedbackNotification,
  classifyPendingFeedbackNotification,
  type FeedbackEventSnapshot,
  type FeedbackRecipientSnapshot,
  type PendingFeedbackNotification,
} from "../feedback-rules"

const NOW = new Date("2026-10-25T12:00:00Z")
const WIFE = "wife"
const OPERATOR = "operator"

const row = (over: Partial<PendingFeedbackNotification> = {}): PendingFeedbackNotification => ({
  id: "n1",
  event_id: "ev",
  recipient_id: WIFE,
  audience: "submitter",
  subscription_id: "sub",
  scheduled_at: "2026-10-25T11:59:00Z",
  ...over,
})
const statusEvent: FeedbackEventSnapshot = {
  id: "ev",
  feedback_id: "fb",
  kind: "status_changed",
  to_status: "in_progress",
}
const submitted: FeedbackEventSnapshot = { ...statusEvent, kind: "submitted", to_status: "received" }
const ok: FeedbackRecipientSnapshot = { isApproved: true, householdId: "h1", isOperator: false }

describe("classifyPendingFeedbackNotification — 判断の順", () => {
  it("投稿者宛の状態変更は送る（受理の対照）", () => {
    expect(
      classifyPendingFeedbackNotification({
        row: row(), event: statusEvent, submitterId: WIFE, currentStatus: "in_progress", recipient: ok, now: NOW,
      }),
    ).toEqual({ action: "send" })
  })

  it("grace を過ぎた行は、資格が崩れておっても先に expired（順序の固定）", () => {
    expect(
      classifyPendingFeedbackNotification({
        row: row({ scheduled_at: "2026-10-25T11:44:59Z" }),
        event: undefined, submitterId: undefined, currentStatus: undefined, recipient: undefined, now: NOW,
      }),
    ).toEqual({ action: "skip", reason: "expired" })
  })

  it("grace の内側の端（15 分ちょうど前は外・1 秒後は内）", () => {
    const at = (iso: string) =>
      classifyPendingFeedbackNotification({
        row: row({ scheduled_at: iso }), event: statusEvent, submitterId: WIFE, currentStatus: "in_progress", recipient: ok, now: NOW,
      })
    expect(at("2026-10-25T11:45:00Z")).toEqual({ action: "skip", reason: "expired" })
    expect(at("2026-10-25T11:45:01Z")).toEqual({ action: "send" })
  })

  it("壊れた時刻は送らぬ", () => {
    expect(
      classifyPendingFeedbackNotification({
        row: row({ scheduled_at: "oops" }), event: statusEvent, submitterId: WIFE, currentStatus: "in_progress", recipient: ok, now: NOW,
      }),
    ).toEqual({ action: "skip", reason: "expired" })
  })

  it("時刻がまだ来ておらぬ行は wait", () => {
    expect(
      classifyPendingFeedbackNotification({
        row: row({ scheduled_at: "2026-10-25T12:00:01Z" }),
        event: statusEvent, submitterId: WIFE, currentStatus: "in_progress", recipient: ok, now: NOW,
      }),
    ).toEqual({ action: "wait" })
  })

  it.each([
    ["要望が消えた", { event: undefined, submitterId: undefined, currentStatus: undefined, recipient: ok }],
    ["受信者の profiles が無い", { event: statusEvent, submitterId: WIFE, currentStatus: "in_progress", recipient: undefined }],
    ["未承認", { event: statusEvent, submitterId: WIFE, currentStatus: "in_progress", recipient: { ...ok, isApproved: false } }],
    ["世帯を離れた", { event: statusEvent, submitterId: WIFE, currentStatus: "in_progress", recipient: { ...ok, householdId: null } }],
    ["投稿者でない相手", { event: statusEvent, submitterId: "someone-else", currentStatus: "in_progress", recipient: ok }],
    ["投稿者宛なのに受付の履歴", { event: submitted, submitterId: WIFE, currentStatus: "in_progress", recipient: ok }],
  ])("%s → revoked", (_name, input) => {
    expect(
      classifyPendingFeedbackNotification({ row: row(), now: NOW, ...input }),
    ).toEqual({ action: "skip", reason: "revoked" })
  })

  it("運用者宛は、受付の履歴で、受信者が今も運用者の時だけ送る", () => {
    const op = (event: FeedbackEventSnapshot, isOperator: boolean) =>
      classifyPendingFeedbackNotification({
        row: row({ audience: "operator", recipient_id: OPERATOR }),
        event, submitterId: WIFE, currentStatus: "in_progress", recipient: { ...ok, isOperator }, now: NOW,
      })
    expect(op(submitted, true)).toEqual({ action: "send" })
    expect(op(submitted, false)).toEqual({ action: "skip", reason: "revoked" })
    expect(op(statusEvent, true)).toEqual({ action: "skip", reason: "revoked" })
  })

  it("状態変更の知らせは、今の状態が行き先と違えば superseded（差し戻し後の古い知らせ）", () => {
    const released: FeedbackEventSnapshot = { ...statusEvent, to_status: "released" }
    const at = (currentStatus: string | undefined) =>
      classifyPendingFeedbackNotification({
        row: row(), event: released, submitterId: WIFE, currentStatus, recipient: ok, now: NOW,
      })
    expect(at("released")).toEqual({ action: "send" })
    expect(at("in_progress")).toEqual({ action: "skip", reason: "superseded" })
    // 状態が読めぬ時も「反映されました」を送らぬ側へ倒す
    expect(at(undefined)).toEqual({ action: "skip", reason: "superseded" })
  })

  it("返信だけの知らせは今の状態に依らず送る", () => {
    const comment: FeedbackEventSnapshot = { ...statusEvent, kind: "commented", to_status: null }
    expect(
      classifyPendingFeedbackNotification({
        row: row(), event: comment, submitterId: WIFE, currentStatus: "declined", recipient: ok, now: NOW,
      }),
    ).toEqual({ action: "send" })
  })

  it("未知の宛先区分は送らぬ（fail-closed）", () => {
    expect(
      classifyPendingFeedbackNotification({
        row: row({ audience: "household" }), event: statusEvent, submitterId: WIFE, currentStatus: "in_progress", recipient: ok, now: NOW,
      }),
    ).toEqual({ action: "skip", reason: "revoked" })
  })
})

describe("buildFeedbackNotification — 中身を載せぬ・反映は released の時だけ", () => {
  it("運用者宛は受信箱の詳細へ着地する", () => {
    expect(buildFeedbackNotification(submitted, "operator")).toMatchObject({
      url: "/feedback/inbox/fb",
      tag: "feedback:fb",
    })
  })
  it("投稿者宛は自分の要望の詳細へ着地し、状態名を載せる", () => {
    const payload = buildFeedbackNotification(statusEvent, "submitter")
    expect(payload.url).toBe("/feedback/fb")
    expect(payload.body).toContain("「対応中」")
    expect(payload.body).not.toContain("反映")
  })
  it("「反映されました」と書くのは released への状態変更の時だけ", () => {
    expect(
      buildFeedbackNotification({ ...statusEvent, to_status: "released" }, "submitter").body,
    ).toContain("反映されました")
    for (const event of [
      statusEvent,
      { ...statusEvent, kind: "commented", to_status: null },
      { ...statusEvent, to_status: "shipped" },
    ]) {
      expect(buildFeedbackNotification(event, "submitter").body).not.toContain("反映されました")
    }
  })
  it("未知の状態は中立の文言へ退化させる", () => {
    expect(
      buildFeedbackNotification({ ...statusEvent, to_status: "shipped" }, "submitter").body,
    ).toContain("更新されました")
  })
})
