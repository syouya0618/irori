import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup, within } from "@testing-library/react"
import { BabySearchResults } from "../baby-search-results"
import type { BabyLogData } from "@/lib/types/baby"

afterEach(cleanup)

function log(overrides: Partial<BabyLogData> & Pick<BabyLogData, "id" | "logged_at">): BabyLogData {
  return {
    log_type: "feeding",
    logged_by: "u1",
    feeding_type: "bottle",
    amount_ml: 80,
    breast_left_count: null,
    breast_right_count: null,
    breast_left_sec: null,
    breast_right_sec: null,
    breast_start_side: null,
    diaper_type: null,
    poop_amount: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: null,
    created_at: overrides.logged_at,
    ...overrides,
  }
}

const baseQuery = { q: "", kind: "all" as const, from: null, to: null, before: null, beforeDate: null }

describe("BabySearchResults", () => {
  it("範囲と件数を示し、日付ごとにまとめてその日の画面へ飛べる。記録者も出す", () => {
    render(
      <BabySearchResults
        query={{ ...baseQuery, q: "鼻水", kind: "memo" }}
        logs={[
          log({ id: "a", logged_at: "2026-10-18T01:00:00+00:00", log_type: "memo", feeding_type: null, amount_ml: null, memo: "朝から鼻水が出た" }),
          log({ id: "b", logged_at: "2026-10-17T23:30:00+00:00", log_type: "memo", feeding_type: null, amount_ml: null, memo: "鼻水 少し", logged_by: "u2" }),
        ]}
        logsTotal={2}
        nextLogsCursor={null}
        diaries={[]}
        diariesTotal={0}
        nextDiaryDate={null}
        recorderLabelFor={(id) => (id === "u1" ? "はな" : "たろう")}
        failed={{ logs: false, diaries: false }}
      />,
    )
    expect(screen.getByText(/全期間・メモ・「鼻水」・記録 2 件/)).toBeInTheDocument()
    // JST 10/18 10:00 と 10/18 08:30 → 同じ日にまとまる
    const section = screen.getByRole("region", { name: "記録の検索結果" })
    const dayLink = within(section).getByRole("link", { name: /2026年10月18日\(日\)/ })
    expect(dayLink).toHaveAttribute("href", "/baby?date=2026-10-18")
    expect(within(section).getByText("朝から鼻水が出た")).toBeInTheDocument()
    expect(within(section).getByText("はな")).toBeInTheDocument()
    expect(within(section).getByText("たろう")).toBeInTheDocument()
    expect(screen.queryByText("見つかりませんでした")).toBeNull()
  })

  it("次のページがあれば cursor つきのリンクを出す", () => {
    render(
      <BabySearchResults
        query={baseQuery}
        logs={[log({ id: "a", logged_at: "2026-10-18T01:00:00+00:00" })]}
        logsTotal={120}
        nextLogsCursor={{ loggedAt: "2026-10-18T01:00:00+00:00", id: "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f" }}
        diaries={[]}
        diariesTotal={0}
        nextDiaryDate={null}
        recorderLabelFor={null}
        failed={{ logs: false, diaries: false }}
      />,
    )
    const more = screen.getByRole("link", { name: /さらに古い記録を表示/ })
    expect(more.getAttribute("href")).toContain("before=")
    expect(decodeURIComponent(more.getAttribute("href") ?? "")).toContain(
      "2026-10-18T01:00:00+00:00|6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
    )
  })

  it("日記は本文の抜粋で出し、その日へ飛べる", () => {
    render(
      <BabySearchResults
        query={{ ...baseQuery, q: "散歩", kind: "diary" }}
        logs={[]}
        logsTotal={null}
        nextLogsCursor={null}
        diaries={[{ id: "d1", diary_date: "2026-10-10", content: "公園へ散歩に行った", updated_at: "x" }]}
        diariesTotal={1}
        nextDiaryDate={null}
        recorderLabelFor={null}
        failed={{ logs: false, diaries: false }}
      />,
    )
    const section = screen.getByRole("region", { name: "日記の検索結果" })
    const link = within(section).getByRole("link")
    expect(link).toHaveAttribute("href", "/baby?date=2026-10-10")
    expect(link).toHaveTextContent("公園へ散歩に行った")
    // 日記だけの検索では記録の件数は出さぬ
    expect(screen.queryByText(/記録 /)).toBeNull()
  })

  it("何も当たらねば空状態、読み込みに失敗したら失敗と言う（空と偽らぬ）", () => {
    const { rerender } = render(
      <BabySearchResults
        query={baseQuery}
        logs={[]}
        logsTotal={0}
        nextLogsCursor={null}
        diaries={[]}
        diariesTotal={0}
        nextDiaryDate={null}
        recorderLabelFor={null}
        failed={{ logs: false, diaries: false }}
      />,
    )
    expect(screen.getByText("見つかりませんでした")).toBeInTheDocument()

    rerender(
      <BabySearchResults
        query={baseQuery}
        logs={[]}
        logsTotal={null}
        nextLogsCursor={null}
        diaries={[]}
        diariesTotal={0}
        nextDiaryDate={null}
        recorderLabelFor={null}
        failed={{ logs: true, diaries: false }}
      />,
    )
    expect(screen.getByRole("alert")).toHaveTextContent("読み込めませんでした")
    expect(screen.queryByText("見つかりませんでした")).toBeNull()
    expect(screen.getByText(/記録 読み込めませんでした/)).toBeInTheDocument()
  })
})
