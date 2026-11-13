import { describe, expect, it } from "vitest"
import { isDinnerRequest, isDinnerServingsRequest, isGroceryRequest } from "../plan-requests"

const ID = "b1000000-0000-4000-8000-000000000001"
const VERSION = "2026-11-11T01:02:03.123456+00:00"
const checks = [isDinnerRequest, isDinnerServingsRequest, isGroceryRequest]

describe("操作名の安全な振り分け", () => {
  it.each(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "__defineSetter__", "unknown"])(
    "不明・特殊な操作名 %s は拒否する",
    (op) => {
      for (const check of checks) {
        expect(() => check({ op })).not.toThrow()
        expect(check({ op })).toBe(false)
      }
    },
  )
  it("正しい操作は受け付ける", () => {
    expect(isDinnerRequest({ op: "cooked", entryId: ID, version: VERSION })).toBe(true)
    expect(isDinnerServingsRequest({ op: "servings_upcoming", servings: 2 })).toBe(true)
    expect(isGroceryRequest({ op: "purchase", id: ID, version: VERSION, purchase: { kind: "check", checked: true } })).toBe(true)
  })
  it("正しい操作名でも不正な引数は拒否する", () => {
    expect(isDinnerRequest({ op: "cooked" })).toBe(false)
    expect(isDinnerServingsRequest({ op: "servings_upcoming", servings: -1 })).toBe(false)
    expect(isGroceryRequest({ op: "purchase", id: ID, version: VERSION, purchase: { kind: "check" } })).toBe(false)
  })
})
