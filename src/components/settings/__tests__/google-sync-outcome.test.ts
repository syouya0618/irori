import { describe, it, expect } from "vitest"
import { interpretSyncResponse } from "../google-sync-outcome"

const sub = (status: string, upserted = 0, deleted = 0) => ({
  subscriptionId: "s",
  googleCalendarId: "g",
  status,
  upserted,
  deleted,
  skipped: 0,
  errorKind: null,
})

function body(connections: unknown[]) {
  return { ok: true, summary: { householdId: "h", connections } }
}

const conn = (connectionId: string, subscriptions: unknown[], needsReauth = false) => ({
  connectionId,
  needsReauth,
  subscriptions,
})

describe("interpretSyncResponse（同期の結果を言い分ける）", () => {
  it("全て synced なら件数つきで完了と言う", () => {
    const r = interpretSyncResponse(body([conn("c1", [sub("synced", 3, 1)])]), "c1", 1)
    expect(r).toEqual({ tone: "ok", text: "同期が完了しました（追加・更新 3件、削除 1件）" })
  })

  it("変更が無ければ「変更はありませんでした」", () => {
    const r = interpretSyncResponse(body([conn("c1", [sub("synced")])]), "c1", 1)
    expect(r.text).toBe("同期が完了しました（変更はありませんでした）")
  })

  it("一部の購読が failed なら完了と言わず件数を言う", () => {
    const r = interpretSyncResponse(
      body([conn("c1", [sub("synced", 2), sub("failed")])]),
      "c1",
      2,
    )
    expect(r.tone).toBe("warn")
    expect(r.text).toMatch(/2件中1件のカレンダーを同期できませんでした/)
  })

  it("**未知の status も同期できていない側へ数える（denylist）**", () => {
    const r = interpretSyncResponse(
      body([conn("c1", [sub("synced"), sub("throttled_from_future")])]),
      "c1",
      2,
    )
    expect(r.tone).toBe("warn")
    expect(r.text).not.toMatch(/完了/)
  })

  it("needsReauth は再接続を促す（error）", () => {
    const r = interpretSyncResponse(body([conn("c1", [], true)]), "c1", 1)
    expect(r.tone).toBe("error")
    expect(r.text).toMatch(/再接続/)
  })

  it("別の実行がリースを持っていれば「実行中」と言い、完了とは言わぬ", () => {
    const r = interpretSyncResponse(body([conn("c1", [sub("skipped_leased")])]), "c1", 1)
    expect(r.tone).toBe("warn")
    expect(r.text).toMatch(/別の同期が実行中/)
  })

  it("410 からのやり直しはその旨を言う", () => {
    const r = interpretSyncResponse(body([conn("c1", [sub("resync_required")])]), "c1", 1)
    expect(r.text).toMatch(/やり直しています/)
  })

  it("1 つも選んでいなければ「選ばれていない」と言う", () => {
    const r = interpretSyncResponse(body([conn("c1", [])]), "c1", 0)
    expect(r.tone).toBe("warn")
    expect(r.text).toMatch(/選ばれていない/)
  })

  it("**選んでおるのに内訳が空なら失敗と言う（一過性の失敗を「選択なし」と偽らぬ）**", () => {
    const r = interpretSyncResponse(body([conn("c1", [])]), "c1", 2)
    expect(r.tone).toBe("error")
    expect(r.text).not.toMatch(/選ばれていない/)
  })

  it("一覧を読めず件数が分からぬ時（null）は、空の内訳を「選ばれていない」と断定せぬ", () => {
    const r = interpretSyncResponse(body([conn("c1", [])]), "c1", null)
    expect(r.tone).toBe("error")
    expect(r.text).not.toMatch(/選ばれていない/)
  })

  it("この接続の内訳だけを見る（配偶者の接続の失敗で自分を失敗と言わぬ）", () => {
    const r = interpretSyncResponse(
      body([conn("spouse", [], true), conn("c1", [sub("synced", 1)])]),
      "c1",
      1,
    )
    expect(r.tone).toBe("ok")
  })

  it("**自分の内訳が無い時（再接続待ちで同期対象外）は、配偶者の成功を自分の完了と言わぬ**", () => {
    const r = interpretSyncResponse(body([conn("spouse", [sub("synced", 5)])]), "c1", 1)
    expect(r.tone).toBe("error")
    expect(r.text).toMatch(/この接続は同期されませんでした/)
  })

  it("形が読めない応答は「完了」へ退化させ、捏造せぬ", () => {
    expect(interpretSyncResponse({ ok: true }, "c1", 1)).toEqual({
      tone: "ok",
      text: "同期が完了しました",
    })
    expect(interpretSyncResponse({ ok: true, summary: { connections: "x" } }, "c1", 1).tone).toBe(
      "ok",
    )
    expect(interpretSyncResponse(null, "c1", 1).tone).toBe("ok")
  })
})
