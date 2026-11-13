// @vitest-environment jsdom
/**
 * 更新・ログアウトの確認（local-work）が、家事（ごみ・掃除・ごはん）の結果不明の控えを数える。
 * 数え漏らすと、PWA の自動再読込やログアウトで「保存を確かめておらぬ操作」を無言で置き去りにする。
 */
import { beforeEach, describe, expect, it } from "vitest"
import { describeLocalWork, hasLocalWork, summarizeLocalWork } from "../local-work"
import { CHORE_PENDING_PREFIX, putChorePending, removeChorePending, type ChoreKind, type ChorePending } from "../chore-pending"

const A = { userId: "e1000000-0000-4000-8000-00000000000a", householdId: "e1000000-0000-4000-8000-0000000000a1" }
const B = { userId: "e1000000-0000-4000-8000-00000000000b", householdId: A.householdId }
const CHILD = "e1000000-0000-4000-8000-0000000000c1"

function chore(id: string, kind: ChoreKind, owner = A): ChorePending {
  return {
    schema: 1,
    id,
    owner,
    kind,
    label: "synthetic chore",
    payload: { id },
    phase: "unknown",
    firstAttemptAt: "2026-11-11T00:00:00.000Z",
  }
}
const ID1 = "e2000000-0000-4000-8000-000000000001"
const ID2 = "e2000000-0000-4000-8000-000000000002"

beforeEach(() => localStorage.clear())

describe("local-work: 家事の控え", () => {
  it("種類をまたいで件数を数え、確認の文に出す", () => {
    putChorePending(chore(ID1, "cleaning"))
    putChorePending(chore(ID2, "meal"))
    const summary = summarizeLocalWork(A)
    expect(summary.chorePending).toBe(2)
    expect(hasLocalWork(summary)).toBe(true)
    expect(describeLocalWork(summary)).toContain("保存を確認中の家事の操作 2件")
    // 育児の記録の件数へ混ぜぬ
    expect(summary.pendingSaves).toBe(0)
  })

  it("世帯スコープゆえ、子どもを選んでいても数える", () => {
    putChorePending(chore(ID1, "garbage"))
    expect(summarizeLocalWork({ ...A, childId: CHILD }).chorePending).toBe(1)
  })

  it("対照: 控えが無い・別の持ち主の控えだけなら、何も無いと答える", () => {
    expect(summarizeLocalWork(A).chorePending).toBe(0)
    expect(hasLocalWork(summarizeLocalWork(A))).toBe(false)
    expect(describeLocalWork(summarizeLocalWork(A))).toBeNull()
    putChorePending(chore(ID1, "cleaning", B))
    expect(summarizeLocalWork(A).chorePending).toBe(0)
    expect(hasLocalWork(summarizeLocalWork(A))).toBe(false)
    // 確定して消えた控えは数えぬ
    putChorePending(chore(ID2, "cleaning"))
    removeChorePending(chore(ID2, "cleaning"))
    expect(hasLocalWork(summarizeLocalWork(A))).toBe(false)
  })

  it("読めぬ家事の控えは「何もない」と言い換えぬ（読み取れない保存控えとして伝える）", () => {
    localStorage.setItem(`${CHORE_PENDING_PREFIX}${A.userId}:${A.householdId}:meal:${ID1}`, "{not json")
    const summary = summarizeLocalWork(A)
    expect(summary.chorePending).toBe(0)
    expect(summary.unreadableSaves).toBe(true)
    expect(hasLocalWork(summary)).toBe(true)
    expect(describeLocalWork(summary)).toContain("読み取れない保存控え")
    // 対照: 別の持ち主の読めぬ控えは今の持ち主の話ではない
    expect(summarizeLocalWork(B).unreadableSaves).toBeUndefined()
  })
})
