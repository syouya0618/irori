// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CHORE_PENDING_LABEL_MAX,
  CHORE_PENDING_MAX_CHARS,
  CHORE_PENDING_PREFIX,
  clearChorePendingForOtherOwner,
  clipChorePendingLabel,
  countChorePending,
  discardUnreadableChorePending,
  listChorePending,
  putChorePending,
  removeChorePending,
  snapshotChorePending,
  type ChoreKind,
  type ChorePending,
} from "../chore-pending"

const A = { userId: "c1000000-0000-4000-8000-00000000000a", householdId: "c1000000-0000-4000-8000-0000000000a1" }
const B = { userId: "c1000000-0000-4000-8000-00000000000b", householdId: "c1000000-0000-4000-8000-0000000000a1" }
const A_MOVED = { userId: A.userId, householdId: "c1000000-0000-4000-8000-0000000000a2" }
const ID1 = "c2000000-0000-4000-8000-000000000001"
const ID2 = "c2000000-0000-4000-8000-000000000002"
const ROW = "c3000000-0000-4000-8000-000000000001"
const unexpected = "synthetic credential must not be copied"

function entry(id: string, over: Partial<ChorePending> = {}): ChorePending {
  return {
    schema: 1,
    id,
    owner: A,
    kind: "cleaning",
    label: "浴室の掃除を完了",
    payload: { id: ROW, version: null, doneOn: "2026-11-11" },
    phase: "sending",
    firstAttemptAt: "2026-11-11T00:00:00.000Z",
    ...over,
  }
}
const keyOf = (owner: typeof A, kind: ChoreKind | string, id: string) =>
  `${CHORE_PENDING_PREFIX}${owner.userId}:${owner.householdId}:${kind}:${id}`
const choreKeys = () => Object.keys(localStorage).filter((k) => k.startsWith(CHORE_PENDING_PREFIX))

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("chore-pending: 説明の切り詰め（R40）", () => {
  it("上限内の説明はそのまま（前後の空白だけ落とす）", () => {
    expect(clipChorePendingLabel("  浴室の掃除を完了 ")).toBe("浴室の掃除を完了")
    const exact = "あ".repeat(CHORE_PENDING_LABEL_MAX)
    expect(clipChorePendingLabel(exact)).toBe(exact)
    // 絵文字 40 字は UTF-16 でちょうど 80。切らぬ
    const emoji = "🧹".repeat(CHORE_PENDING_LABEL_MAX / 2)
    expect(clipChorePendingLabel(emoji)).toBe(emoji)
    expect(clipChorePendingLabel("   ")).toBe("")
  })

  it("上限を超える説明は UTF-16 で上限以内へ切り、代理対を割らず、省略の印を付ける", () => {
    for (const long of [
      "あ".repeat(CHORE_PENDING_LABEL_MAX + 1),
      `${"🧹".repeat(40)}の掃除を完了`,
      // 奇数の位置で上限に当たる並び（代理対の途中で切れやすい）
      `a${"🧹".repeat(60)}`,
    ]) {
      const clipped = clipChorePendingLabel(long)
      expect(clipped.length, long).toBeLessThanOrEqual(CHORE_PENDING_LABEL_MAX)
      expect(clipped.endsWith("…"), long).toBe(true)
      expect(clipped.isWellFormed(), long).toBe(true)
      expect(long.startsWith(clipped.slice(0, -1)), long).toBe(true)
      // 切り詰めた説明は、控えの検査を通る
      expect(snapshotChorePending(entry(ID1, { label: clipped }))?.label).toBe(clipped)
    }
  })

  it("対照: 切り詰めぬ長い説明は、控えの検査が今も拒む（端末へ残す形の上限は変えておらぬ）", () => {
    expect(snapshotChorePending(entry(ID1, { label: `${"🧹".repeat(40)}の掃除を完了` }))).toBeNull()
  })
})

describe("chore-pending: 書く・読む・消す", () => {
  it("鍵は 利用者:世帯:種類:操作ID。同じ持ち主の控えだけが読める", () => {
    expect(putChorePending(entry(ID1))).toBe(true)
    expect(choreKeys()).toEqual([keyOf(A, "cleaning", ID1)])
    expect(listChorePending(A)).toEqual({ items: [entry(ID1)], unreadable: 0, storageReadable: true })
    expect(countChorePending(A)).toBe(1)
    // 対照: 別の利用者・別の世帯からは読めぬ（件数にも数えぬ）
    expect(listChorePending(B)).toEqual({ items: [], unreadable: 0, storageReadable: true })
    expect(listChorePending(A_MOVED).items).toEqual([])
    expect(countChorePending(B)).toBe(0)
  })

  it("種類で絞れる。別々の操作は互いを上書きせぬ", () => {
    putChorePending(entry(ID1))
    putChorePending(entry(ID2, { kind: "meal", label: "牛乳を購入済みにする", firstAttemptAt: "2026-11-11T00:00:01.000Z" }))
    expect(listChorePending(A).items.map((p) => p.id)).toEqual([ID1, ID2])
    expect(listChorePending(A, "meal").items.map((p) => p.id)).toEqual([ID2])
    expect(listChorePending(A, "garbage").items).toEqual([])
    removeChorePending(entry(ID2, { kind: "meal" }))
    expect(listChorePending(A).items.map((p) => p.id)).toEqual([ID1])
  })

  it("同じ操作 ID の再書込みは payload・説明・最初の時刻を変えず、phase だけ進める", () => {
    putChorePending(entry(ID1))
    expect(
      putChorePending(
        entry(ID1, {
          phase: "unknown",
          label: "差し替えた説明",
          payload: { id: ROW, version: null, doneOn: "2026-11-12" },
          firstAttemptAt: "2026-11-12T00:00:00.000Z",
        }),
      ),
    ).toBe(true)
    expect(listChorePending(A).items).toEqual([entry(ID1, { phase: "unknown" })])
  })

  it("確定して消した控えを、遅れて届いた失敗が蘇らせぬ（onlyExisting）", () => {
    putChorePending(entry(ID1))
    removeChorePending(entry(ID1))
    expect(putChorePending(entry(ID1, { phase: "unknown" }), true)).toBe(false)
    expect(listChorePending(A).items).toEqual([])
    // 対照: 控えが在れば onlyExisting でも phase を進められる
    putChorePending(entry(ID2))
    expect(putChorePending(entry(ID2, { phase: "unknown" }), true)).toBe(true)
    expect(listChorePending(A).items[0].phase).toBe("unknown")
  })
})

describe("chore-pending: 読めぬ控えは読まず、消さず、件数だけ返す", () => {
  it("壊れた JSON・未知の schema・未知の種類", () => {
    const broken = keyOf(A, "cleaning", ID1)
    const future = keyOf(A, "meal", ID2)
    const unknownKind = keyOf(A, "laundry", ID1)
    localStorage.setItem(broken, "{not json")
    localStorage.setItem(future, JSON.stringify({ ...entry(ID2, { kind: "meal" }), schema: 2 }))
    localStorage.setItem(unknownKind, JSON.stringify({ ...entry(ID1), kind: "laundry" }))
    expect(listChorePending(A)).toEqual({ items: [], unreadable: 3, storageReadable: true })
    expect(countChorePending(A)).toBe(0)
    expect(localStorage.getItem(broken)).toBe("{not json")
    expect(localStorage.getItem(future)).not.toBeNull()
    // 種類で絞れば、別の種類の読めぬ控えは数えぬ（ごはんの壊れた控えが掃除を塞がぬ）
    expect(listChorePending(A, "cleaning").unreadable).toBe(1)
    expect(listChorePending(A, "meal").unreadable).toBe(1)
    expect(listChorePending(A, "garbage").unreadable).toBe(0)
  })

  it("鍵と中身の持ち主・種類・ID が食い違う控えは読まぬ（別の持ち主の内容を今の持ち主へ出さぬ）", () => {
    // B の鍵の下に A の持ち主を名乗る中身
    localStorage.setItem(keyOf(B, "cleaning", ID1), JSON.stringify(entry(ID1)))
    expect(listChorePending(B)).toEqual({ items: [], unreadable: 1, storageReadable: true })
    localStorage.clear()
    // 種類・ID の食い違い
    localStorage.setItem(keyOf(A, "meal", ID1), JSON.stringify(entry(ID1)))
    localStorage.setItem(keyOf(A, "cleaning", ID2), JSON.stringify(entry(ID1)))
    expect(listChorePending(A)).toEqual({ items: [], unreadable: 2, storageReadable: true })
    // 対照: 鍵と中身が一致すれば読める
    localStorage.setItem(keyOf(A, "cleaning", ID1), JSON.stringify(entry(ID1)))
    expect(listChorePending(A).items).toEqual([entry(ID1)])
  })

  it("読めぬ値の在る鍵へは上書きせぬ", () => {
    localStorage.setItem(keyOf(A, "cleaning", ID1), "{not json")
    expect(putChorePending(entry(ID1))).toBe(false)
    expect(localStorage.getItem(keyOf(A, "cleaning", ID1))).toBe("{not json")
  })

  it("discardUnreadableChorePending は読めぬ控えだけを捨てる", () => {
    putChorePending(entry(ID1))
    localStorage.setItem(keyOf(A, "cleaning", ID2), "{not json")
    localStorage.setItem(keyOf(A, "meal", ID2), "{not json")
    expect(discardUnreadableChorePending(A, "cleaning")).toBe(1)
    expect(listChorePending(A, "cleaning")).toEqual({ items: [entry(ID1)], unreadable: 0, storageReadable: true })
    // 種類を指定したら別の種類には触れぬ
    expect(localStorage.getItem(keyOf(A, "meal", ID2))).toBe("{not json")
    expect(discardUnreadableChorePending(A)).toBe(1)
    expect(listChorePending(A).unreadable).toBe(0)
  })

  it("端末保存を読めぬ環境では「控えが無い」と言わず storageReadable=false を返す", () => {
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    putChorePending(entry(ID1))
    expect(listChorePending(A)).toEqual({ items: [], unreadable: 0, storageReadable: false })
  })

  it("端末へ書けぬ時は false（例外を投げぬ）", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError")
    })
    expect(putChorePending(entry(ID1))).toBe(false)
  })
})

describe("chore-pending: 持ち主交代の破棄", () => {
  it("今の持ち主以外（別の利用者・別の世帯）の控えを消し、今の持ち主と他の端末保存は残す", () => {
    putChorePending(entry(ID1))
    putChorePending(entry(ID1, { owner: B }))
    putChorePending(entry(ID2, { owner: A_MOVED }))
    // 別の持ち主の読めぬ控えも残さぬ
    localStorage.setItem(keyOf(B, "meal", ID2), "{not json")
    localStorage.setItem("irori:sleep-request:v1:someone:else:child:nonce", "{}")
    localStorage.setItem("theme", "dark")

    clearChorePendingForOtherOwner(A)

    expect(choreKeys()).toEqual([keyOf(A, "cleaning", ID1)])
    expect(listChorePending(B)).toEqual({ items: [], unreadable: 0, storageReadable: true })
    expect(listChorePending(A_MOVED).items).toEqual([])
    expect(localStorage.getItem("irori:sleep-request:v1:someone:else:child:nonce")).toBe("{}")
    expect(localStorage.getItem("theme")).toBe("dark")
  })

  it("接頭辞が似た利用者 ID を今の持ち主と取り違えぬ", () => {
    const longer = { userId: `${A.userId}0`, householdId: A.householdId }
    putChorePending(entry(ID1, { owner: longer }))
    putChorePending(entry(ID2))
    clearChorePendingForOtherOwner(A)
    expect(choreKeys()).toEqual([keyOf(A, "cleaning", ID2)])
  })
})

describe("chore-pending: 端末へ残す形", () => {
  it("文書化した項目だけを残す（余分な項目・持ち主の余分な項目を写さぬ）", () => {
    const input = {
      ...entry(ID1),
      password: unexpected,
      owner: { ...A, access_token: unexpected, childId: "x" },
    }
    expect(putChorePending(input as ChorePending)).toBe(true)
    expect(localStorage.getItem(keyOf(A, "cleaning", ID1))).not.toContain(unexpected)
    expect(listChorePending(A).items).toEqual([entry(ID1)])
  })

  it("payload は素の JSON だけ。undefined の項目は落とし、入れ子は保つ", () => {
    const payload = { id: ROW, memo: undefined, items: [{ name: "牛乳", qty: 1 }, { name: "卵", qty: null }], on: true }
    const clean = snapshotChorePending(entry(ID1, { payload }))
    expect(clean?.payload).toEqual({ id: ROW, items: [{ name: "牛乳", qty: 1 }, { name: "卵", qty: null }], on: true })
    expect(Object.keys(clean!.payload)).not.toContain("memo")
  })

  it.each([
    ["toJSON を持つ object", { id: ROW, hook: { toJSON: () => ({ token: unexpected }) } }],
    ["Date", { id: ROW, at: new Date(0) }],
    ["関数", { id: ROW, fn: () => unexpected }],
    ["NaN", { id: ROW, qty: Number.NaN }],
    ["配列の中の undefined", { id: ROW, items: [undefined] }],
    ["クラスのインスタンス", { id: ROW, map: new Map([["k", unexpected]]) }],
  ])("payload に %s が混ざれば書かぬ", (_name, payload) => {
    expect(putChorePending(entry(ID1, { payload: payload as Record<string, unknown> }))).toBe(false)
    expect(choreKeys()).toEqual([])
  })

  it("形の合わぬ控えは書かぬ（ID・持ち主・種類・説明・phase・時刻・大きさ）", () => {
    const bad: Partial<ChorePending>[] = [
      { id: "not-a-uuid" },
      { owner: { userId: "", householdId: A.householdId } },
      { owner: { userId: "a:b", householdId: A.householdId } },
      { kind: "laundry" as ChoreKind },
      { label: "   " },
      { label: "あ".repeat(CHORE_PENDING_LABEL_MAX + 1) },
      { phase: "rejected" as ChorePending["phase"] },
      { firstAttemptAt: "not a time" },
      { payload: { text: "x".repeat(CHORE_PENDING_MAX_CHARS) } },
      { payload: [] as unknown as Record<string, unknown> },
    ]
    for (const over of bad) expect(putChorePending(entry(ID1, over)), JSON.stringify(over).slice(0, 60)).toBe(false)
    expect(choreKeys()).toEqual([])
    // 対照: 上限ちょうどの説明は書ける
    expect(putChorePending(entry(ID1, { label: "あ".repeat(CHORE_PENDING_LABEL_MAX) }))).toBe(true)
  })
})
