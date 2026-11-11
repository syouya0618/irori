import { describe, expect, it } from "vitest"

import {
  describePreferenceReason,
  latestFeedbackByProfile,
  PREFERENCE_WEIGHTS,
  scoreRecipePreference,
} from "../preferences"
import type { DishFeedback, FoodPreference } from "../types"
import { CATALOG, recipeById } from "./fixtures"

const CURRY = recipeById("pork_curry")
const SALMON = recipeById("salmon_grill")

function feedback(id: string, profileId: string, overrides: Partial<DishFeedback> = {}): DishFeedback {
  return {
    id,
    profileId,
    recipeId: "pork_curry",
    eatenOn: "2026-11-01",
    taste: null,
    effort: null,
    again: null,
    excludeFromLearning: false,
    ...overrides,
  }
}

function preference(id: string, overrides: Partial<FoodPreference> = {}): FoodPreference {
  return {
    id,
    scope: "personal",
    profileId: "papa",
    target: { kind: "recipe", id: "pork_curry" },
    sentiment: "like",
    ...overrides,
  }
}

const NAMES: Record<string, string> = { papa: "パパ", mama: "ママ" }
const nameOf = (profileId: string) => NAMES[profileId] ?? null

describe("何も無ければ影響しない", () => {
  it("好みも評価も無い料理は 0 点・理由なし", () => {
    expect(scoreRecipePreference(CURRY, { preferences: [], feedback: [] })).toEqual({
      total: 0,
      explicit: 0,
      taste: 0,
      effort: 0,
      again: 0,
      reasons: [],
      dislikedBy: [],
    })
  })

  it("他の料理への評価は影響しない", () => {
    const score = scoreRecipePreference(SALMON, { preferences: [], feedback: [feedback("f1", "papa", { taste: 3 })] })
    expect(score.total).toBe(0)
  })
})

describe("旧欠陥 (c) の回帰: 評価者を失わない", () => {
  const input = {
    preferences: [],
    feedback: [feedback("f1", "papa", { taste: 3 }), feedback("f2", "mama", { taste: 1 })],
  }

  it("パパ「おいしい」とママ「苦手」を相殺して 0 にしない", () => {
    const score = scoreRecipePreference(CURRY, input)
    expect(score.taste).toBe(PREFERENCE_WEIGHTS.taste[3] + PREFERENCE_WEIGHTS.taste[1])
    expect(score.taste).toBeLessThan(0)
    expect(score.dislikedBy).toEqual(["mama"])
  })

  it("理由は本人ごとに残り、実記録の ID と profileId を持つ", () => {
    const score = scoreRecipePreference(CURRY, input)
    expect(score.reasons).toEqual([
      { kind: "taste", feedbackId: "f2", profileId: "mama", eatenOn: "2026-11-01", value: 1, points: -4 },
      { kind: "taste", feedbackId: "f1", profileId: "papa", eatenOn: "2026-11-01", value: 3, points: 3 },
    ])
  })

  it("理由の文は「◯◯さんが前回『おいしい』」の形で、評価した本人の名前になる", () => {
    const score = scoreRecipePreference(CURRY, input)
    expect(score.reasons.map((r) => describePreferenceReason(r, nameOf))).toEqual([
      "ママさんが前回「苦手」",
      "パパさんが前回「おいしい」",
    ])
  })

  it("件数の多い人の声を強くしない: 同じ人の評価は最新の 1 件だけを使う", () => {
    const many = [
      feedback("a1", "papa", { taste: 3, eatenOn: "2026-10-01" }),
      feedback("a2", "papa", { taste: 3, eatenOn: "2026-10-08" }),
      feedback("a3", "papa", { taste: 3, eatenOn: "2026-10-15" }),
      feedback("b1", "mama", { taste: 1, eatenOn: "2026-10-15" }),
    ]
    const score = scoreRecipePreference(CURRY, { preferences: [], feedback: many })
    expect(score.reasons.filter((r) => r.kind === "taste")).toHaveLength(2)
    expect(score.taste).toBe(-1)
  })

  it("前回の評価 = 最新の日付の記録（同じ日は ID の大きい方）", () => {
    const rows = [
      feedback("f1", "papa", { taste: 1, eatenOn: "2026-10-01" }),
      feedback("f2", "papa", { taste: 3, eatenOn: "2026-11-01" }),
      feedback("f0", "papa", { taste: 2, eatenOn: "2026-11-01" }),
    ]
    expect(latestFeedbackByProfile(rows, "pork_curry", "taste").map((r) => r.id)).toEqual(["f2"])
  })
})

describe("C-73 味・手間・また食べたいを別々に扱う", () => {
  it("3 つの軸は別の内訳に入る", () => {
    const score = scoreRecipePreference(CURRY, {
      preferences: [],
      feedback: [feedback("f1", "papa", { taste: 3, effort: 1, again: true })],
    })
    expect(score).toMatchObject({ taste: 3, effort: -1, again: 2, total: 4 })
    expect(score.reasons.map((r) => r.kind)).toEqual(["taste", "effort", "again"])
  })

  it("後から手間だけを記録しても、前回の味の評価は消えない（軸ごとに最新を使う）", () => {
    const score = scoreRecipePreference(CURRY, {
      preferences: [],
      feedback: [
        feedback("f1", "papa", { taste: 3, eatenOn: "2026-10-01" }),
        feedback("f2", "papa", { effort: 3, eatenOn: "2026-11-01" }),
      ],
    })
    expect(score).toMatchObject({ taste: 3, effort: 1 })
  })

  it("「おいしいが大変」は味を上げ、手間を下げる（混ぜて 1 つの点にしない）", () => {
    const score = scoreRecipePreference(CURRY, {
      preferences: [],
      feedback: [feedback("f1", "mama", { taste: 3, effort: 1 })],
    })
    expect(score.taste).toBeGreaterThan(0)
    expect(score.effort).toBeLessThan(0)
    expect(describePreferenceReason(score.reasons[1], nameOf)).toBe("ママさんが前回「大変」")
  })

  it("「ふつう」は点にも文にもしない", () => {
    const score = scoreRecipePreference(CURRY, { preferences: [], feedback: [feedback("f1", "papa", { taste: 2 })] })
    expect(score.total).toBe(0)
    expect(describePreferenceReason(score.reasons[0], nameOf)).toBeNull()
  })
})

describe("C-74 その日の気分や「作らなかった」を長期の低評価にしない", () => {
  it("excludeFromLearning の評価は反映しない", () => {
    const score = scoreRecipePreference(CURRY, {
      preferences: [],
      feedback: [feedback("f1", "papa", { taste: 1, again: false, excludeFromLearning: true })],
    })
    expect(score.total).toBe(0)
    expect(score.reasons).toEqual([])
    expect(score.dislikedBy).toEqual([])
  })

  it("対照: 同じ評価でも excludeFromLearning でなければ反映する", () => {
    const score = scoreRecipePreference(CURRY, {
      preferences: [],
      feedback: [feedback("f1", "papa", { taste: 1, again: false })],
    })
    expect(score.total).toBe(-7)
    expect(score.dislikedBy).toEqual(["papa"])
  })

  it("気分の記録が最新でも、その前の通常の評価を使う", () => {
    const score = scoreRecipePreference(CURRY, {
      preferences: [],
      feedback: [
        feedback("f1", "papa", { taste: 3, eatenOn: "2026-10-01" }),
        feedback("f2", "papa", { taste: 1, eatenOn: "2026-11-01", excludeFromLearning: true }),
      ],
    })
    expect(score.taste).toBe(3)
  })

  it("「作らなかった」は評価ではない: 何も入力されていない記録（全て null）は点にしない", () => {
    const score = scoreRecipePreference(CURRY, { preferences: [], feedback: [feedback("f1", "papa")] })
    expect(score.total).toBe(0)
    expect(score.reasons).toEqual([])
  })

  it("料理に結び付かない評価（recipeId が null）は使わない", () => {
    const score = scoreRecipePreference(CURRY, {
      preferences: [],
      feedback: [feedback("f1", "papa", { recipeId: null, taste: 1 })],
    })
    expect(score.total).toBe(0)
  })
})

describe("明示の好み（家族共通／個人）", () => {
  it("料理・タグ・食材の好みを当てる", () => {
    const score = scoreRecipePreference(
      CURRY,
      {
        preferences: [
          preference("p1"),
          preference("p2", { target: { kind: "tag", id: "curry" }, scope: "household", profileId: null }),
          preference("p3", { target: { kind: "ingredient", id: "carrot" }, sentiment: "dislike", profileId: "mama" }),
        ],
        feedback: [],
      },
      CATALOG.index,
    )
    expect(score.explicit).toBe(4 + 2 - 3)
    expect(score.reasons.map((r) => (r.kind === "explicit" ? [r.preferenceId, r.profileId] : null))).toEqual([
      ["p1", "papa"],
      ["p2", null],
      ["p3", "mama"],
    ])
    expect(score.dislikedBy).toEqual(["mama"])
  })

  it("家族共通の設定と個人の設定を文で区別する", () => {
    const score = scoreRecipePreference(CURRY, {
      preferences: [
        preference("p1"),
        preference("p2", { scope: "household", profileId: null, sentiment: "dislike" }),
      ],
      feedback: [],
    })
    expect(score.reasons.map((r) => describePreferenceReason(r, nameOf))).toEqual([
      "パパさんの設定で「好き」",
      "家族共通の設定で「苦手」",
    ])
  })

  it("食材の好みは派生食材にも当てる（豚肉が好き → 豚バラの料理）。辞書を渡さなければ ID の一致だけ", () => {
    const likePork = preference("p1", { target: { kind: "ingredient", id: "pork" } })
    const belly = recipeById("pork_belly_cabbage")
    expect(scoreRecipePreference(belly, { preferences: [likePork], feedback: [] }, CATALOG.index).explicit).toBe(2)
    expect(scoreRecipePreference(belly, { preferences: [likePork], feedback: [] }).explicit).toBe(0)
  })

  it("対照: 当てはまらない好みは点にしない", () => {
    const score = scoreRecipePreference(SALMON, { preferences: [preference("p1")], feedback: [] }, CATALOG.index)
    expect(score.total).toBe(0)
  })
})

describe("C-75 削除した好み・評価は再利用されない（内部に状態を持たない）", () => {
  it("評価を渡した後、同じ料理を評価なしで採点すると 0 に戻る", () => {
    const withFeedback = scoreRecipePreference(CURRY, {
      preferences: [preference("p1")],
      feedback: [feedback("f1", "papa", { taste: 3 })],
    })
    expect(withFeedback.total).toBe(7)
    const afterDelete = scoreRecipePreference(CURRY, { preferences: [], feedback: [] })
    expect(afterDelete.total).toBe(0)
    expect(afterDelete.reasons).toEqual([])
  })

  it("同じ入力からは同じ結果（入力の順序にも依らない）", () => {
    const rows = [feedback("f1", "papa", { taste: 3 }), feedback("f2", "mama", { taste: 1, again: false })]
    const a = scoreRecipePreference(CURRY, { preferences: [], feedback: rows })
    const b = scoreRecipePreference(CURRY, { preferences: [], feedback: [...rows].reverse() })
    expect(a).toEqual(b)
  })

  it("名前を引けない評価者でも、実記録の理由は「家族」として残す（別人の名前にしない）", () => {
    const score = scoreRecipePreference(CURRY, { preferences: [], feedback: [feedback("f1", "left-member", { taste: 3 })] })
    expect(describePreferenceReason(score.reasons[0], nameOf)).toBe("家族が前回「おいしい」")
  })
})
