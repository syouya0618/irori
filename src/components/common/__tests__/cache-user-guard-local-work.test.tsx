/**
 * 利用者・世帯の交代で、前の持ち主の端末作業（下書き・確認中の保存・授乳の計測）を消す
 * （2026-10-27 大型更新 §1 / AC21）。今の持ち主のものは残す（同じ人の再ログインで戻れる）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("@/lib/pwa/sw-messages", () => ({
  LAST_USER_ID_STORAGE_KEY: "irori-last-user-id",
  purgeHouseholdCaches: vi.fn(async () => true),
  setCacheOwner: vi.fn(async () => true),
}))

import { CacheUserGuard } from "../cache-user-guard"
import { readDraft, writeDraft } from "@/lib/domain/draft-storage"
import {
  listPendingSaves,
  putPendingSave,
  PENDING_SAVE_SCHEMA_VERSION,
} from "@/lib/domain/pending-saves-storage"
import { readPersistedTimer, writePersistedTimer } from "@/lib/domain/feeding-timer-storage"
import { listChorePending, putChorePending, type ChoreKind } from "@/lib/domain/chore-pending"
import { hasLocalWork, summarizeLocalWork } from "@/lib/domain/local-work"

const ID_A = "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
const ID_B = "7f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
const isText = (v: unknown): v is string => typeof v === "string"

function pending(userId: string, householdId: string, clientId: string) {
  putPendingSave({
    schemaVersion: PENDING_SAVE_SCHEMA_VERSION,
    clientId,
    owner: { userId, householdId },
    action: "recordMemo",
    payload: { memo: "x", clientId },
    summary: "メモ",
    firstAttemptAt: new Date().toISOString(),
    phase: "unknown",
  })
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("CacheUserGuard と端末の未確定作業", () => {
  it("別の利用者に替わったら、前の利用者の下書き・確認中の保存・計測を消し、今の利用者のものは残す", () => {
    writeDraft({ userId: "a", householdId: "h1" }, { kind: "diary", date: "2026-10-27" }, null, "A の日記")
    writeDraft({ userId: "b", householdId: "h1" }, { kind: "diary", date: "2026-10-27" }, null, "B の日記")
    pending("a", "h1", ID_A)
    pending("b", "h1", ID_B)
    writePersistedTimer({
      startedAt: new Date().toISOString(),
      feedingType: "breast_left",
      userId: "a",
      householdId: "h1",
      clientId: ID_A,
    })

    render(<CacheUserGuard userId="b" householdId="h1" />)

    expect(readDraft({ userId: "a", householdId: "h1" }, { kind: "diary", date: "2026-10-27" }, isText).status).toBe("none")
    expect(readDraft({ userId: "b", householdId: "h1" }, { kind: "diary", date: "2026-10-27" }, isText).status).toBe("found")
    expect(listPendingSaves({ userId: "a", householdId: "h1" })).toHaveLength(0)
    expect(listPendingSaves({ userId: "b", householdId: "h1" })).toHaveLength(1)
    expect(readPersistedTimer()).toBeNull()
  })

  it("前の持ち主の表示の好み（折り畳み）・前回見た印も消し、今の持ち主のものは残す", () => {
    localStorage.setItem("irori:home-folds:v1:a:h1", "{}")
    localStorage.setItem("irori:handoff-seen:v1:a:h1", "2026-10-27T03:00:00.123456+00:00")
    localStorage.setItem("irori:home-folds:v1:b:h1", "{}")
    localStorage.setItem("irori:handoff-seen:v1:b:h1", "x")
    // 見た予定の id と版（独立レビュー 3 周目: v2 の掃除を確かめる）
    localStorage.setItem("irori:handoff-events-seen:v2:a:h1", '{"e1":{"u":"2026-10-27T03:00:00Z","d":"2026-10-28"}}')
    localStorage.setItem("irori:handoff-events-seen:v2:b:h2", "{}")
    localStorage.setItem("irori:handoff-events-seen:v2:b:h1", "{}")
    localStorage.setItem("theme", "dark")
    render(<CacheUserGuard userId="b" householdId="h1" />)
    expect(localStorage.getItem("irori:home-folds:v1:a:h1")).toBeNull()
    expect(localStorage.getItem("irori:handoff-seen:v1:a:h1")).toBeNull()
    expect(localStorage.getItem("irori:home-folds:v1:b:h1")).toBe("{}")
    expect(localStorage.getItem("irori:handoff-seen:v1:b:h1")).toBe("x")
    expect(localStorage.getItem("irori:handoff-events-seen:v2:a:h1")).toBeNull()
    expect(localStorage.getItem("irori:handoff-events-seen:v2:b:h2")).toBeNull()
    expect(localStorage.getItem("irori:handoff-events-seen:v2:b:h1")).toBe("{}")
    expect(localStorage.getItem("theme")).toBe("dark")
  })

  it("同じ利用者が別の世帯へ移った時も、前の世帯のものは消す", () => {
    writeDraft({ userId: "a", householdId: "h1" }, { kind: "diary", date: "2026-10-27" }, null, "前の世帯")
    writePersistedTimer({
      startedAt: new Date().toISOString(),
      feedingType: "breast_left",
      userId: "a",
      householdId: "h1",
      clientId: ID_A,
    })
    render(<CacheUserGuard userId="a" householdId="h2" />)
    expect(readDraft({ userId: "a", householdId: "h1" }, { kind: "diary", date: "2026-10-27" }, isText).status).toBe("none")
    expect(readPersistedTimer()).toBeNull()
  })

  it("対照: 同じ利用者・同じ世帯（再ログイン）なら何も消さぬ", () => {
    writeDraft({ userId: "a", householdId: "h1" }, { kind: "diary", date: "2026-10-27" }, null, "残す")
    pending("a", "h1", ID_A)
    writePersistedTimer({
      startedAt: new Date().toISOString(),
      feedingType: "breast_left",
      userId: "a",
      householdId: "h1",
      clientId: ID_A,
    })
    render(<CacheUserGuard userId="a" householdId="h1" />)
    expect(readDraft({ userId: "a", householdId: "h1" }, { kind: "diary", date: "2026-10-27" }, isText).status).toBe("found")
    expect(listPendingSaves({ userId: "a", householdId: "h1" })).toHaveLength(1)
    expect(readPersistedTimer()).not.toBeNull()
  })
})

/**
 * 家事（ごみ・掃除・ごはん）の結果不明の控え（chore-pending。2026-11 家事機能）の 3 箇所配線:
 * 持ち主交代の破棄（CacheUserGuard）・更新とログアウト前の件数（local-work）・読む側の持ち主絞り込み。
 */
describe("CacheUserGuard と家事の控え", () => {
  function chore(userId: string, householdId: string, id: string, kind: ChoreKind = "cleaning") {
    expect(
      putChorePending({
        schema: 1,
        id,
        owner: { userId, householdId },
        kind,
        label: "浴室の掃除を完了",
        payload: { id: ID_A },
        phase: "unknown",
        firstAttemptAt: "2026-11-11T00:00:00.000Z",
      }),
    ).toBe(true)
  }

  it("別の利用者に替わったら前の利用者の控えを消し、今の利用者のものは残す", () => {
    chore("a", "h1", ID_A)
    chore("a", "h1", ID_B, "meal")
    chore("b", "h1", ID_B)
    render(<CacheUserGuard userId="b" householdId="h1" />)
    expect(listChorePending({ userId: "a", householdId: "h1" }).items).toHaveLength(0)
    expect(listChorePending({ userId: "b", householdId: "h1" }).items).toHaveLength(1)
    expect(Object.keys(localStorage).filter((k) => k.startsWith("irori:chore-request:v1:a:"))).toEqual([])
  })

  it("同じ利用者が別の世帯へ移った時も、前の世帯の控えは消す", () => {
    chore("a", "h1", ID_A)
    render(<CacheUserGuard userId="a" householdId="h2" />)
    expect(listChorePending({ userId: "a", householdId: "h1" }).items).toHaveLength(0)
    expect(hasLocalWork(summarizeLocalWork({ userId: "a", householdId: "h2" }))).toBe(false)
  })

  it("対照: 同じ利用者・同じ世帯なら残り、更新・ログアウト前の件数に数えられる", () => {
    chore("a", "h1", ID_A)
    render(<CacheUserGuard userId="a" householdId="h1" />)
    expect(listChorePending({ userId: "a", householdId: "h1" }).items).toHaveLength(1)
    const summary = summarizeLocalWork({ userId: "a", householdId: "h1" })
    expect(summary.chorePending).toBe(1)
    expect(hasLocalWork(summary)).toBe(true)
  })
})
