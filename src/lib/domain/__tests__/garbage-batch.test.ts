import { describe, expect, it } from "vitest"
import { isGarbageRequest, suggestGarbageCandidates, type GarbageEventRow } from "@/lib/domain/garbage"
import {
  buildGarbageBatch,
  finishGarbageBatch,
  GARBAGE_BATCH_MAX,
  garbageBatchSummaryText,
  initialBatchChoice,
  markGarbageBatchSending,
  nextGarbageBatchItem,
  resumeGarbageBatch,
  settleGarbageBatchItem,
  stopGarbageBatch,
  summarizeGarbageBatch,
  type GarbageBatch,
} from "@/lib/domain/garbage-batch"

const SERIES = "5e100000-0000-4000-8000-000000000010"
const A = "5e100000-0000-4000-8000-000000000001"
const B = "5e100000-0000-4000-8000-000000000002"
const C = "5e100000-0000-4000-8000-000000000003"

function native(id: string, o: Partial<GarbageEventRow> = {}): GarbageEventRow {
  return {
    id,
    title: "予定",
    is_all_day: true,
    start_date: "2026-11-15",
    end_date: o.start_date ?? "2026-11-15",
    start_at: null,
    source: "native",
    series_id: null,
    event_uid: id,
    ...o,
  }
}

/** 繰り返しの「燃えるごみ」・単発の「資源」・名称を推せぬ「ゴミ出し」の 3 候補 */
function candidates() {
  return suggestGarbageCandidates(
    [
      native(A, { title: "燃えるごみ", series_id: SERIES, start_date: "2026-11-15" }),
      native(B, { title: "資源", start_date: "2026-11-16" }),
      native(C, { title: "ゴミ出し", start_date: "2026-11-17" }),
    ],
    [],
  )
}

function started(): GarbageBatch {
  const [burnable, resource] = candidates()
  const batch = buildGarbageBatch([initialBatchChoice(burnable), initialBatchChoice(resource), { candidate: candidates()[2], kind: "粗大ごみ" }])
  if (!batch) throw new Error("batch not built")
  return batch
}

describe("まとめての分類: 送る内容を確認の時点で固める", () => {
  it("繰り返しはシリーズ全体・単発はその予定だけ、通知は常に『変えない』、見ておった版は候補のまま", () => {
    const batch = started()
    expect(batch.phase).toBe("running")
    expect(batch.items.map((item) => item.request)).toEqual([
      { op: "save", eventId: A, scope: "series", action: "garbage", garbageKind: "燃えるごみ", reminder: "keep", seen: { series: null, event: null } },
      { op: "save", eventId: B, scope: "event", action: "garbage", garbageKind: "資源", reminder: "keep", seen: { series: null, event: null } },
      { op: "save", eventId: C, scope: "event", action: "garbage", garbageKind: "粗大ごみ", reminder: "keep", seen: { series: null, event: null } },
    ])
    for (const item of batch.items) expect(isGarbageRequest(item.request)).toBe(true)
    expect(batch.items[0].label).toBe("「燃えるごみ」をごみの日（燃えるごみ）にする（シリーズ全体）")
  })
  it("名称を推せぬ候補は未選択から始め、未選択・プリセット外・重複・上限超えが 1 つでも在れば何も固めぬ", () => {
    const list = candidates()
    expect(initialBatchChoice(list[2]).kind).toBeNull()
    expect(buildGarbageBatch(list.map(initialBatchChoice))).toBeNull()
    expect(buildGarbageBatch([{ candidate: list[0], kind: "自由入力の名称" }])).toBeNull()
    expect(buildGarbageBatch([initialBatchChoice(list[0]), initialBatchChoice(list[0])])).toBeNull()
    expect(buildGarbageBatch([])).toBeNull()
    const many = Array.from({ length: GARBAGE_BATCH_MAX + 1 }, (_, i) => ({
      candidate: { ...list[1], event: { ...list[1].event, id: `5e100000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}` } },
      kind: "資源",
    }))
    expect(buildGarbageBatch(many)).toBeNull()
    expect(buildGarbageBatch(many.slice(0, GARBAGE_BATCH_MAX))?.items).toHaveLength(GARBAGE_BATCH_MAX)
  })
})

describe("まとめての分類: 1 件ずつ送り、結果を件ごとに分ける", () => {
  it("送信中の件が在る間は次を出さず、応答の後に次を出す", () => {
    let batch = started()
    expect(nextGarbageBatchItem(batch)?.eventId).toBe(A)
    batch = markGarbageBatchSending(batch, A)
    expect(nextGarbageBatchItem(batch)).toBeNull()
    batch = settleGarbageBatchItem(batch, A, { kind: "settled", status: "saved", readbackFailed: false })
    expect(nextGarbageBatchItem(batch)?.eventId).toBe(B)
  })
  it("結果不明が出たらそこで止め、残りは送らぬ。部分的な成功を『すべて』と言わぬ", () => {
    let batch = started()
    batch = settleGarbageBatchItem(markGarbageBatchSending(batch, A), A, { kind: "settled", status: "saved", readbackFailed: false })
    batch = settleGarbageBatchItem(markGarbageBatchSending(batch, B), B, { kind: "unknown" })
    expect(batch.phase).toBe("stopped")
    expect(batch.items.map((item) => item.status)).toEqual(["saved", "unknown", "stopped"])
    expect(nextGarbageBatchItem(batch)).toBeNull()
    expect(summarizeGarbageBatch(batch)).toMatchObject({ total: 3, saved: 1, unknown: 1, notSent: 1 })
    const text = garbageBatchSummaryText(batch)
    expect(text).toBe(
      "3件のうち、保存を確かめたのは1件です。1件は保存できたか確認できていません（「同じ操作で確認」で確かめてください。確認をやめた時は、一覧で保存されたかを確かめてください）。1件は送っていません。",
    )
    expect(text).not.toContain("すべて")
  })
  it("後からの『同じ操作で確認』の応答で、確認待ちの件を確かめ、止めた件だけを続けて送れる", () => {
    let batch = started()
    batch = settleGarbageBatchItem(markGarbageBatchSending(batch, A), A, { kind: "settled", status: "saved", readbackFailed: false })
    batch = settleGarbageBatchItem(markGarbageBatchSending(batch, B), B, { kind: "unknown" })
    // 同じ操作で確認した結果、先の送信が届いておった（RPC は replayed）
    batch = settleGarbageBatchItem(batch, B, { kind: "settled", status: "replayed", readbackFailed: false })
    expect(batch.items.map((item) => item.status)).toEqual(["saved", "unchanged", "stopped"])
    expect(batch.phase).toBe("stopped")
    batch = resumeGarbageBatch(batch)
    expect(batch.phase).toBe("running")
    // 結果の出た件は送り直さぬ
    expect(nextGarbageBatchItem(batch)?.eventId).toBe(C)
    batch = settleGarbageBatchItem(markGarbageBatchSending(batch, C), C, { kind: "settled", status: "saved", readbackFailed: false })
    expect(batch.phase).toBe("done")
    expect(garbageBatchSummaryText(batch)).toBe("3件すべてを、ごみの日として保存しました。")
  })
  it("衝突・拒否・読み直しの失敗は、それぞれ『保存していない』『確かめられていない』として数え、次へ進む", () => {
    let batch = started()
    batch = settleGarbageBatchItem(markGarbageBatchSending(batch, A), A, { kind: "settled", status: "conflict", readbackFailed: false })
    batch = settleGarbageBatchItem(markGarbageBatchSending(batch, B), B, { kind: "rejected", error: "この予定は分類できません。" })
    batch = settleGarbageBatchItem(markGarbageBatchSending(batch, C), C, { kind: "settled", status: "saved", readbackFailed: true })
    expect(batch.phase).toBe("done")
    expect(batch.items.map((item) => item.status)).toEqual(["conflict", "rejected", "unverified"])
    expect(batch.items[1].error).toBe("この予定は分類できません。")
    expect(summarizeGarbageBatch(batch)).toMatchObject({ saved: 0, notSaved: 2, unverified: 1 })
    expect(garbageBatchSummaryText(batch)).toBe(
      "3件のうち、保存を確かめたのは0件です。1件は保存の応答がありましたが、読み直しで確かめられていません（画面を再読込して確かめてください）。2件は保存していません。",
    )
  })
  it("止めると順番待ちだけを『送っていない』にし、結果の出た件と送信中の件には触れぬ", () => {
    let batch = started()
    batch = settleGarbageBatchItem(markGarbageBatchSending(batch, A), A, { kind: "settled", status: "saved", readbackFailed: false })
    batch = markGarbageBatchSending(batch, B)
    batch = stopGarbageBatch(batch)
    expect(batch.items.map((item) => item.status)).toEqual(["saved", "sending", "stopped"])
    // 送信中だった件の応答は、止めた後でも映す
    batch = settleGarbageBatchItem(batch, B, { kind: "settled", status: "saved", readbackFailed: false })
    expect(batch.items.map((item) => item.status)).toEqual(["saved", "saved", "stopped"])
    expect(finishGarbageBatch(batch).phase).toBe("stopped")
  })
  it("この一括に無い件・送っておらぬ件への応答は何も変えぬ", () => {
    const batch = started()
    expect(settleGarbageBatchItem(batch, "5e100000-0000-4000-8000-0000000000ff", { kind: "unknown" })).toBe(batch)
    expect(settleGarbageBatchItem(batch, C, { kind: "settled", status: "saved", readbackFailed: false })).toBe(batch)
  })
})
