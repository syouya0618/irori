import { describe, it, expect, vi } from "vitest"
import { babyLogKeysetFilter, withBabyLogKeyset } from "../baby-log-keyset"

const cursor = {
  // マイクロ秒つきの PostgREST 表記。丸めずに運ぶことが要
  loggedAt: "2026-07-22T03:00:00.123456+00:00",
  id: "0d3c1c7e-3c1a-4f7e-9a51-6b8f1f2a9c10",
}

describe("babyLogKeysetFilter", () => {
  it("昇順は「この行より後」: logged_at が大きいか、同時刻で id が大きい", () => {
    expect(babyLogKeysetFilter(cursor, "asc")).toBe(
      'logged_at.gt."2026-07-22T03:00:00.123456+00:00",' +
        'and(logged_at.eq."2026-07-22T03:00:00.123456+00:00",id.gt."0d3c1c7e-3c1a-4f7e-9a51-6b8f1f2a9c10")',
    )
  })

  it("降順は「この行より前」: logged_at が小さいか、同時刻で id が小さい", () => {
    expect(babyLogKeysetFilter(cursor, "desc")).toBe(
      'logged_at.lt."2026-07-22T03:00:00.123456+00:00",' +
        'and(logged_at.eq."2026-07-22T03:00:00.123456+00:00",id.lt."0d3c1c7e-3c1a-4f7e-9a51-6b8f1f2a9c10")',
    )
  })

  it("向きで比較演算子だけが入れ替わる（同時刻の行の扱いが向きと食い違わぬ）", () => {
    const asc = babyLogKeysetFilter(cursor, "asc")
    const desc = babyLogKeysetFilter(cursor, "desc")
    expect(asc.replaceAll(".gt.", ".lt.")).toBe(desc)
    expect(asc).not.toContain(".lt.")
    expect(desc).not.toContain(".gt.")
  })

  it("logged_at を Date に通さぬ（秒未満 6 桁がそのまま残る）", () => {
    expect(babyLogKeysetFilter(cursor, "asc")).toContain(".123456+00:00")
    expect(babyLogKeysetFilter(cursor, "asc")).not.toContain(".123Z")
  })
})

describe("withBabyLogKeyset", () => {
  it("cursor が無い最初のページでは条件を足さぬ", () => {
    const query = { or: vi.fn() }
    expect(withBabyLogKeyset(query, null, "asc")).toBe(query)
    expect(query.or).not.toHaveBeenCalled()
  })

  it("cursor があれば向きに合った条件を 1 本だけ足す", () => {
    const next = { or: vi.fn() }
    const query = { or: vi.fn(() => next) }
    expect(withBabyLogKeyset(query, cursor, "desc")).toBe(next)
    expect(query.or).toHaveBeenCalledTimes(1)
    expect(query.or).toHaveBeenCalledWith(babyLogKeysetFilter(cursor, "desc"))
  })
})
