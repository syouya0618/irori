/**
 * 端末下書き（テーマ B / AC07・AC09・AC21）。jsdom を使わぬ node project ゆえ、localStorage は
 * 最小の in-memory 実装を差し込む（quota・不許可は投げる実装に差し替えて試す）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  countOwnedDrafts,
  discardDraft,
  draftStorageKey,
  draftWriteFailureMessage,
  DRAFT_TTL_MS,
  purgeDraftsNotOwnedBy,
  readDraft,
  writeDraft,
  type DraftTarget,
} from "../draft-storage"

class MemoryStorage {
  map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}

let storage: MemoryStorage
beforeEach(() => {
  storage = new MemoryStorage()
  vi.stubGlobal("localStorage", storage)
})

const A = { userId: "user-a", householdId: "house-1" }
const B = { userId: "user-b", householdId: "house-1" }
const A2 = { userId: "user-a", householdId: "house-2" }
const DIARY: DraftTarget = { kind: "diary", date: "2026-10-27" }
const isText = (v: unknown): v is string => typeof v === "string"

describe("読み書きと対象の分離（AC07）", () => {
  it("同じ利用者・世帯・日付の下書きだけを戻す（別の日・別の利用者・別の世帯には出さぬ）", () => {
    expect(writeDraft(A, DIARY, "2026-10-27T03:00:00.123456+00:00", "夜泣き 2 回")).toEqual({ ok: true })
    const found = readDraft(A, DIARY, isText)
    expect(found.status).toBe("found")
    if (found.status === "found") {
      expect(found.draft.content).toBe("夜泣き 2 回")
      // 版は表記の文字列のまま（マイクロ秒を落とさぬ）
      expect(found.draft.baseVersion).toBe("2026-10-27T03:00:00.123456+00:00")
    }
    expect(readDraft(A, { kind: "diary", date: "2026-10-26" }, isText).status).toBe("none")
    expect(readDraft(B, DIARY, isText).status).toBe("none")
    expect(readDraft(A2, DIARY, isText).status).toBe("none")
  })

  it("鍵が同じでも、中身の持ち主・対象が違えば捨てる（取り違え・手で弄られた値を復元せぬ）", () => {
    writeDraft(B, DIARY, null, "B の本文")
    // A の鍵へ B の中身を置いた形
    storage.setItem(draftStorageKey(A, DIARY), storage.getItem(draftStorageKey(B, DIARY))!)
    expect(readDraft(A, DIARY, isText)).toEqual({ status: "discarded", reason: "mismatch" })
    expect(storage.getItem(draftStorageKey(A, DIARY))).toBeNull()
  })

  it("明示の破棄・保存成功は、その対象の下書きだけを消す", () => {
    writeDraft(A, DIARY, null, "日記")
    const event: DraftTarget = { kind: "calendar-event", id: "ev-1" }
    writeDraft(A, event, "v1", { title: "健診" })
    discardDraft(A, DIARY)
    expect(readDraft(A, DIARY, isText).status).toBe("none")
    expect(readDraft(A, event, (v): v is { title: string } => typeof v === "object" && v !== null).status).toBe("found")
  })

  it("書き直しても createdAt は最初のまま、updatedAt は進む", () => {
    writeDraft(A, DIARY, null, "1", new Date("2026-10-27T03:00:00Z"))
    writeDraft(A, DIARY, null, "12", new Date("2026-10-27T03:05:00Z"))
    const r = readDraft(A, DIARY, isText, new Date("2026-10-27T03:06:00Z").getTime())
    expect(r.status).toBe("found")
    if (r.status === "found") {
      expect(r.draft.createdAt).toBe("2026-10-27T03:00:00.000Z")
      expect(r.draft.updatedAt).toBe("2026-10-27T03:05:00.000Z")
    }
  })
})

describe("端末保存の失敗と壊れた値（AC09）", () => {
  it("quota 超過は quota として返し、他の下書きを巻き込まぬ", () => {
    writeDraft(A, { kind: "diary", date: "2026-10-26" }, null, "残すべき下書き")
    storage.setItem = () => {
      throw new DOMException("full", "QuotaExceededError")
    }
    const r = writeDraft(A, DIARY, null, "新しい")
    expect(r).toEqual({ ok: false, reason: "quota" })
    expect(draftWriteFailureMessage("quota")).toContain("閉じると入力が消えます")
    expect(readDraft(A, { kind: "diary", date: "2026-10-26" }, isText).status).toBe("found")
  })

  it("保存の不許可（SecurityError）・localStorage 無しは unavailable（投げぬ）", () => {
    storage.setItem = () => {
      throw new DOMException("denied", "SecurityError")
    }
    expect(writeDraft(A, DIARY, null, "x")).toEqual({ ok: false, reason: "unavailable" })
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new DOMException("denied", "SecurityError")
      },
    })
    expect(readDraft(A, DIARY, isText)).toEqual({ status: "unavailable" })
  })

  it("壊れた JSON・旧版・期限切れ・本文の形違いは捨て、理由を返す", () => {
    const key = draftStorageKey(A, DIARY)
    storage.setItem(key, "{not json")
    expect(readDraft(A, DIARY, isText)).toEqual({ status: "discarded", reason: "corrupt" })
    expect(storage.getItem(key)).toBeNull()

    writeDraft(A, DIARY, null, "x")
    const old = JSON.parse(storage.getItem(key)!)
    storage.setItem(key, JSON.stringify({ ...old, schemaVersion: 0 }))
    expect(readDraft(A, DIARY, isText)).toEqual({ status: "discarded", reason: "old-schema" })

    writeDraft(A, DIARY, null, "x", new Date("2026-10-01T00:00:00Z"))
    expect(
      readDraft(A, DIARY, isText, new Date("2026-10-01T00:00:00Z").getTime() + DRAFT_TTL_MS + 1),
    ).toEqual({ status: "discarded", reason: "expired" })

    writeDraft(A, DIARY, null, 123 as unknown as string)
    expect(readDraft(A, DIARY, isText)).toEqual({ status: "discarded", reason: "corrupt" })
  })

  it("対照: 期限ちょうどまでは残す", () => {
    const t = new Date("2026-10-01T00:00:00Z")
    writeDraft(A, DIARY, null, "x", t)
    expect(readDraft(A, DIARY, isText, t.getTime() + DRAFT_TTL_MS).status).toBe("found")
  })

  it("長すぎる下書きは書かず too-large を返す", () => {
    expect(writeDraft(A, DIARY, null, "あ".repeat(30_000))).toEqual({ ok: false, reason: "too-large" })
  })
})

describe("利用者・世帯の交代（AC21）", () => {
  it("今の持ち主以外の下書きだけを消し、今の持ち主の下書きは残す", () => {
    writeDraft(A, DIARY, null, "A")
    writeDraft(B, DIARY, null, "B")
    writeDraft(A2, DIARY, null, "A の別世帯")
    storage.setItem("theme", "dark")
    expect(purgeDraftsNotOwnedBy(A)).toBe(2)
    expect(readDraft(A, DIARY, isText).status).toBe("found")
    expect(readDraft(B, DIARY, isText).status).toBe("none")
    expect(readDraft(A2, DIARY, isText).status).toBe("none")
    // 下書き以外の鍵には触れぬ
    expect(storage.getItem("theme")).toBe("dark")
    expect(countOwnedDrafts(A)).toBe(1)
  })
})
