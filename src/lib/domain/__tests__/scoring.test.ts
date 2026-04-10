import { describe, it, expect } from "vitest"
import {
  calculateExpiryBonus,
  calculateReactionScore,
  daysUntilExpiry,
} from "../scoring"
import { DEFAULT_SCORING_CONFIG } from "../types"
import { mkStock, mkMatched } from "./helpers"

const TODAY = new Date("2026-04-09T00:00:00Z")

describe("daysUntilExpiry", () => {
  it("期限切れは負の値", () => {
    expect(daysUntilExpiry("2026-04-08", TODAY)).toBe(-1)
  })

  it("当日は0", () => {
    expect(daysUntilExpiry("2026-04-09", TODAY)).toBe(0)
  })

  it("未来は正の値", () => {
    expect(daysUntilExpiry("2026-04-12", TODAY)).toBe(3)
  })

  it("nullはnullを返す", () => {
    expect(daysUntilExpiry(null, TODAY)).toBe(null)
  })
})

describe("calculateExpiryBonus", () => {
  it("マッチなしは0", () => {
    expect(
      calculateExpiryBonus([], DEFAULT_SCORING_CONFIG, TODAY),
    ).toBe(0)
  })

  it("期限なしの食材はボーナスなし", () => {
    const matched = mkMatched([mkStock("トマト")])
    expect(
      calculateExpiryBonus(matched, DEFAULT_SCORING_CONFIG, TODAY),
    ).toBe(0)
  })

  it("期限3日以内の食材にボーナス付与", () => {
    const matched = mkMatched([
      mkStock("トマト", { expires_at: "2026-04-11" }),
    ]) // 2日後
    const bonus = calculateExpiryBonus(matched, DEFAULT_SCORING_CONFIG, TODAY)
    expect(bonus).toBeGreaterThan(0)
  })

  it("期限7日後の食材はボーナスなし", () => {
    const matched = mkMatched([
      mkStock("トマト", { expires_at: "2026-04-16" }),
    ]) // 7日後
    expect(
      calculateExpiryBonus(matched, DEFAULT_SCORING_CONFIG, TODAY),
    ).toBe(0)
  })

  it("期限切れ食材もボーナス対象（使い切りたい）", () => {
    const matched = mkMatched([
      mkStock("トマト", { expires_at: "2026-04-07" }),
    ]) // 2日前
    const bonus = calculateExpiryBonus(matched, DEFAULT_SCORING_CONFIG, TODAY)
    expect(bonus).toBeGreaterThan(0)
  })

  it("ボーナスは上限を超えない", () => {
    const matched = mkMatched([
      mkStock("A", { expires_at: "2026-04-10" }),
      mkStock("B", { expires_at: "2026-04-10" }),
      mkStock("C", { expires_at: "2026-04-10" }),
      mkStock("D", { expires_at: "2026-04-10" }),
      mkStock("E", { expires_at: "2026-04-10" }),
    ])
    const bonus = calculateExpiryBonus(matched, DEFAULT_SCORING_CONFIG, TODAY)
    expect(bonus).toBeLessThanOrEqual(DEFAULT_SCORING_CONFIG.expiryBonusMax)
  })
})

describe("calculateReactionScore", () => {
  it("リアクションなしは0", () => {
    expect(calculateReactionScore([], DEFAULT_SCORING_CONFIG)).toBe(0)
  })

  it("good のみは正の値", () => {
    const score = calculateReactionScore(
      ["good", "good"],
      DEFAULT_SCORING_CONFIG,
    )
    expect(score).toBeGreaterThan(0)
  })

  it("bad のみは負の値", () => {
    const score = calculateReactionScore(["bad"], DEFAULT_SCORING_CONFIG)
    expect(score).toBeLessThan(0)
  })

  it("ok のみは0", () => {
    expect(
      calculateReactionScore(["ok", "ok"], DEFAULT_SCORING_CONFIG),
    ).toBe(0)
  })

  it("スコアは上限下限でクランプされる", () => {
    const manyGood = Array(100).fill("good") as ("good" | "ok" | "bad")[]
    const score = calculateReactionScore(manyGood, DEFAULT_SCORING_CONFIG)
    expect(score).toBeLessThanOrEqual(DEFAULT_SCORING_CONFIG.reactionScoreMax)

    const manyBad = Array(100).fill("bad") as ("good" | "ok" | "bad")[]
    const badScore = calculateReactionScore(manyBad, DEFAULT_SCORING_CONFIG)
    expect(badScore).toBeGreaterThanOrEqual(
      DEFAULT_SCORING_CONFIG.reactionScoreMin,
    )
  })
})

