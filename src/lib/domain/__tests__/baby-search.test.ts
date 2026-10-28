import { describe, it, expect } from "vitest"
import {
  decodeCursor,
  encodeCursor,
  excerptAround,
  logTypeFor,
  searchPresets,
  parseBabySearchParams,
  searchHref,
  toIlikePattern,
} from "../baby-search"

const TODAY = "2026-10-19"

describe("parseBabySearchParams", () => {
  it("検索語は trim して上限で切り、種類・期間・cursor を読む", () => {
    const q = parseBabySearchParams(
      {
        q: "  鼻水 ",
        kind: "feeding",
        from: "2026-10-01",
        to: "2026-10-10",
        before: "2026-10-05T01:02:03.123456+00:00|6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
        before_date: "2026-10-03",
      },
      TODAY,
    )
    expect(q).toEqual({
      q: "鼻水",
      kind: "feeding",
      from: "2026-10-01",
      to: "2026-10-10",
      before: {
        loggedAt: "2026-10-05T01:02:03.123456+00:00",
        id: "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
      },
      beforeDate: "2026-10-03",
    })
    expect(parseBabySearchParams({ q: "a".repeat(200) }, TODAY).q).toHaveLength(100)
  })

  it("不正な種類・日付・cursor・配列は既定へ倒す。未来の to は今日へ、from > to は入れ替える", () => {
    const q = parseBabySearchParams(
      {
        kind: "sleep",
        from: "2026-10-20",
        to: "2026-02-30",
        before: "garbage",
        before_date: ["a", "b"],
      },
      TODAY,
    )
    expect(q.kind).toBe("all")
    expect(q.from).toBe("2026-10-20")
    expect(q.to).toBeNull()
    expect(q.before).toBeNull()
    expect(q.beforeDate).toBeNull()

    const swapped = parseBabySearchParams({ from: "2026-10-10", to: "2026-10-01" }, TODAY)
    expect(swapped).toMatchObject({ from: "2026-10-01", to: "2026-10-10" })
    const future = parseBabySearchParams({ to: "2027-01-01" }, TODAY)
    expect(future.to).toBe(TODAY)
  })
})

describe("cursor", () => {
  it("PostgREST の表記のまま往復し、壊れた値は null", () => {
    const cursor = {
      loggedAt: "2026-10-05T01:02:03.123456+00:00",
      id: "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
    }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
    expect(decodeCursor("2026-10-05|not-a-uuid")).toBeNull()
    expect(decodeCursor("")).toBeNull()
    expect(decodeCursor(null)).toBeNull()
  })
})

describe("searchHref", () => {
  it("既定値は省き、cursor は上書きで足す（読む側と往復できる）", () => {
    expect(searchHref({ q: "", kind: "all", from: null, to: null })).toBe("/baby/search")
    const href = searchHref(
      { q: "鼻水", kind: "memo", from: "2026-10-01", to: null },
      { before: { loggedAt: "2026-10-05T01:02:03+00:00", id: "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f" } },
    )
    const url = new URL(href, "http://localhost")
    const params = Object.fromEntries(url.searchParams.entries())
    const parsed = parseBabySearchParams(params, TODAY)
    expect(parsed).toMatchObject({
      q: "鼻水",
      kind: "memo",
      from: "2026-10-01",
      to: null,
      before: { loggedAt: "2026-10-05T01:02:03+00:00" },
    })
  })
})

describe("toIlikePattern", () => {
  it("% _ \\ を文字どおりにし、前後に % を付ける", () => {
    expect(toIlikePattern("50%")).toBe("%50\\%%")
    expect(toIlikePattern("a_b\\c")).toBe("%a\\_b\\\\c%")
  })
  it("* は PostgREST が % の別名にするため検索語から落とす", () => {
    expect(toIlikePattern("a*b")).toBe("%ab%")
  })
})

describe("excerptAround", () => {
  it("当たった箇所の前後を切り出し、省略を … で示す", () => {
    const text = `${"あ".repeat(50)}鼻水${"い".repeat(50)}`
    const excerpt = excerptAround(text, "鼻水", 5)
    expect(excerpt).toBe("…あああああ鼻水いいいいい…")
  })
  it("検索語が無い・当たらぬ時は先頭を出す", () => {
    expect(excerptAround("短い", "")).toBe("短い")
    expect(excerptAround("a".repeat(100), "zzz", 10)).toBe(`${"a".repeat(20)}…`)
  })
})

describe("searchPresets（よく使う条件の入口・2026-10-27 D）", () => {
  const TODAY = "2026-10-27"
  const q = (o: Partial<Parameters<typeof searchPresets>[0]> = {}) => ({
    q: "",
    kind: "all" as const,
    from: null,
    to: null,
    before: null,
    beforeDate: null,
    ...o,
  })

  it("「直近7日」は今日を含む 7 暦日（JST）で、今の種類と検索語を保つ。cursor は引き継がぬ", () => {
    const presets = searchPresets(
      q({ q: "鼻水", kind: "diary", before: { loggedAt: "2026-10-20T00:00:00+00:00", id: "00000000-0000-4000-8000-000000000000" } }),
      TODAY,
    )
    const week = presets.find((p) => p.label === "直近7日")!
    expect(week.href).toBe("/baby/search?q=%E9%BC%BB%E6%B0%B4&kind=diary&from=2026-10-21&to=2026-10-27")
    expect(week.href).not.toContain("before")
    expect(week.active).toBe(false)
  })

  it("種類の入口は今の期間を保ち、選択中の種類をもう一度押すと「すべて」へ戻す", () => {
    const presets = searchPresets(q({ kind: "feeding", from: "2026-10-21", to: TODAY }), TODAY)
    const feeding = presets.find((p) => p.label === "授乳")!
    expect(feeding.active).toBe(true)
    expect(feeding.href).toBe("/baby/search?from=2026-10-21&to=2026-10-27")
    const diaper = presets.find((p) => p.label === "おむつ")!
    expect(diaper.href).toBe("/baby/search?kind=diaper&from=2026-10-21&to=2026-10-27")
    expect(presets.find((p) => p.label === "直近7日")!.active).toBe(true)
    expect(presets.find((p) => p.label === "全期間")!.active).toBe(false)
  })
})

describe("logTypeFor", () => {
  it("記録の種類だけ log_type へ写し、all / diary は null", () => {
    expect(logTypeFor("feeding")).toBe("feeding")
    expect(logTypeFor("all")).toBeNull()
    expect(logTypeFor("diary")).toBeNull()
  })
})
