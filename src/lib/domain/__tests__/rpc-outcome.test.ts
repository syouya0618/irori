import { describe, it, expect } from "vitest"
import {
  failureOfRpcError,
  isChoreSaveFailure,
  isChoreSaveSuccess,
  parseRpcOutcome,
  parseRpcStatus,
  rejectedResult,
  unknownResult,
} from "../rpc-outcome"

describe("parseRpcOutcome", () => {
  it.each(["saved", "replayed", "conflict"] as const)("status=%s と行を読む", (status) => {
    const row = { id: "r1", updated_at: "2026-11-11T00:00:00.123456+00:00" }
    expect(parseRpcOutcome({ status, routine: row }, "routine")).toEqual({ status, entity: row })
  })

  it("形が合わねば null（成功と偽らぬ）", () => {
    const row = { id: "r1" }
    expect(parseRpcOutcome(null, "routine")).toBeNull()
    expect(parseRpcOutcome("saved", "routine")).toBeNull()
    expect(parseRpcOutcome([{ status: "saved", routine: row }], "routine")).toBeNull()
    // 未知の status
    expect(parseRpcOutcome({ status: "ok", routine: row }, "routine")).toBeNull()
    expect(parseRpcOutcome({ status: 1, routine: row }, "routine")).toBeNull()
    // 行が無い・別のキー・object でない
    expect(parseRpcOutcome({ status: "saved" }, "routine")).toBeNull()
    expect(parseRpcOutcome({ status: "saved", log: row }, "routine")).toBeNull()
    expect(parseRpcOutcome({ status: "saved", routine: null }, "routine")).toBeNull()
    expect(parseRpcOutcome({ status: "saved", routine: [row] }, "routine")).toBeNull()
    expect(parseRpcOutcome({ status: "saved", routine: "r1" }, "routine")).toBeNull()
  })

  it("継承プロパティを行と取り違えぬ", () => {
    expect(parseRpcOutcome({ status: "saved" }, "constructor")).toBeNull()
    expect(parseRpcOutcome({ status: "saved" }, "__proto__")).toBeNull()
  })
})

describe("parseRpcStatus", () => {
  it("既知の 3 値だけを読む", () => {
    expect(parseRpcStatus({ status: "replayed" })).toBe("replayed")
    expect(parseRpcStatus({ status: "deleted" })).toBeNull()
    expect(parseRpcStatus(undefined)).toBeNull()
  })
})

describe("Action の失敗の分類", () => {
  it("SQLSTATE / PGRST を持つ失敗は rejected、code の無い失敗は unknown（failureKindOfDbError と同じ）", () => {
    expect(failureOfRpcError({ code: "42501" }, "権限がありません")).toEqual({
      error: "権限がありません",
      failure: "rejected",
    })
    expect(failureOfRpcError({ code: "22023" }, "x").failure).toBe("rejected")
    expect(failureOfRpcError({ code: "23505" }, "x").failure).toBe("rejected")
    expect(failureOfRpcError({ code: "PGRST301" }, "x").failure).toBe("rejected")
    // fetch 失敗・timeout（postgrest-js は code: ""）は、書かれたかもしれぬ
    expect(failureOfRpcError({ code: "" }, "x").failure).toBe("unknown")
    expect(failureOfRpcError({}, "x").failure).toBe("unknown")
    expect(failureOfRpcError({ code: null }, "x").failure).toBe("unknown")
    // 接続系（08xxx）・内部エラー（XX000）は行が書かれておらぬと断定できぬ
    expect(failureOfRpcError({ code: "08006" }, "x").failure).toBe("unknown")
  })

  it("rejectedResult / unknownResult は分類つきの失敗応答を作る", () => {
    expect(rejectedResult("入力を確認してください")).toEqual({ error: "入力を確認してください", failure: "rejected" })
    expect(unknownResult().failure).toBe("unknown")
    expect(unknownResult().error).toContain("確認")
  })
})

describe("応答の形の判定（Server の応答を信用せぬ）", () => {
  it("成功応答: status が既知で error を持たぬ", () => {
    expect(isChoreSaveSuccess({ status: "saved" })).toBe(true)
    expect(isChoreSaveSuccess({ status: "conflict", routine: {} })).toBe(true)
    expect(isChoreSaveSuccess({ status: "done" })).toBe(false)
    expect(isChoreSaveSuccess({ status: "saved", error: "x" })).toBe(false)
    expect(isChoreSaveSuccess(undefined)).toBe(false)
    expect(isChoreSaveSuccess("saved")).toBe(false)
  })

  it("失敗応答: 文言と既知の分類を持つ（分類なし・未知の分類は失敗応答と認めぬ = 結果不明）", () => {
    expect(isChoreSaveFailure({ error: "x", failure: "rejected" })).toBe(true)
    expect(isChoreSaveFailure({ error: "x", failure: "unknown" })).toBe(true)
    expect(isChoreSaveFailure({ error: "x", failure: "conflict" })).toBe(true)
    expect(isChoreSaveFailure({ error: "x" })).toBe(false)
    expect(isChoreSaveFailure({ error: "x", failure: "denied" })).toBe(false)
    expect(isChoreSaveFailure({ failure: "rejected" })).toBe(false)
    expect(isChoreSaveFailure(null)).toBe(false)
  })
})
