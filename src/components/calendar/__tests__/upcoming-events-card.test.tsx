/**
 * UpcomingEventsCard（CAL-4「今日・明日の予定」アプリ内カード）のテスト。
 *
 * refetch style の chain mock（`.from → .select → .eq → .gte → .lte → .order`）を
 * test-utils/supabase-realtime-mock.ts の buildRefetchSupabaseMock で組む。
 * 本コンポーネントは Realtime を購読せず visibilitychange/focus refetch のみだが、
 * refetch で createClient() を呼ぶため mock は必要。置き場は /baby（BabyDashboard）。
 *
 * 時刻語彙は CalendarAgenda（CAL-2）と共有する agendaTimeDisplay に委ねるため、
 * 「→」表記の期待値は agenda 側の表示分岐表と一致させる。
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import { act } from "react"

import type { ViFn } from "@/test-utils/supabase-realtime-mock"
import {
  resetRefetchMockState,
  setRefetchData,
  setRefetchErrorOnce,
} from "@/test-utils/supabase-realtime-mock"
import * as React from "react"
import type { CalendarEventRecord } from "@/components/calendar/use-month-events"
import { shiftYmd, todayJstString } from "@/lib/utils/date-jst"

const mockState = vi.hoisted(() => ({
  listeners: [] as Array<(payload: unknown) => void>,
  removeChannelMock: undefined as unknown as ViFn,
  channelNameMock: undefined as unknown as ViFn,
  fromMock: undefined as unknown as ViFn,
  selectMock: undefined as unknown as ViFn,
  eqMock: undefined as unknown as ViFn,
  gteMock: undefined as unknown as ViFn,
  lteMock: undefined as unknown as ViFn,
  orderMock: undefined as unknown as ViFn,
  abortSignalMock: undefined as ViFn | undefined,
  currentResolveData: [] as CalendarEventRecord[],
}))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  const { buildRefetchSupabaseMock } = await import(
    "@/test-utils/supabase-realtime-mock"
  )
  return buildRefetchSupabaseMock<CalendarEventRecord>(viMod, mockState)
})

import { UpcomingEventsCard } from "../upcoming-events-card"

// 実時計から導出する（固定リテラル禁止）。コンポーネントの refetch 経路は
// todayJstString()（実時計）で「今日」を再計算するため、日付を固定すると
// 翌日以降「タブ復帰で refetch」テストが恒常的に落ちる（2026-07-27 に実際に発生）。
const TODAY = todayJstString()
const TOMORROW = shiftYmd(TODAY, 1)
const YESTERDAY = shiftYmd(TODAY, -1)

/** 時刻付き予定。start_at/end_at は ISO（UTC 表記）で渡す。 */
function timedEvent(
  over: Partial<CalendarEventRecord> & Pick<CalendarEventRecord, "id" | "title">,
): CalendarEventRecord {
  return {
    is_all_day: false,
    start_date: TODAY,
    end_date: TODAY,
    start_at: `${TODAY}T05:00:00Z`, // JST 14:00
    end_at: null,
    memo: null,
    source: "native",
    series_id: null,
    updated_at: "2026-07-01T00:00:00.000000+00:00",
    ...over,
  }
}

/** 終日予定。 */
function allDayEvent(
  over: Partial<CalendarEventRecord> & Pick<CalendarEventRecord, "id" | "title">,
): CalendarEventRecord {
  return {
    is_all_day: true,
    start_date: TODAY,
    end_date: TODAY,
    start_at: null,
    end_at: null,
    memo: null,
    source: "native",
    series_id: null,
    updated_at: "2026-07-01T00:00:00.000000+00:00",
    ...over,
  }
}

beforeEach(() => {
  cleanup()
  mockState.currentResolveData = []
})

describe("UpcomingEventsCard", () => {
  it("当日の時刻付き予定を JST 時刻とタイトルで表示する", () => {
    render(
      <UpcomingEventsCard
        initialEvents={[timedEvent({ id: "e1", title: "小児科の検診" })]}
        householdId="h1"
        initialToday={TODAY}
      />,
    )

    expect(screen.getByText("小児科の検診")).toBeInTheDocument()
    expect(screen.getByText("14:00")).toBeInTheDocument()
  })

  it("カード全体が /calendar へのリンクになっている", () => {
    render(
      <UpcomingEventsCard
        initialEvents={[timedEvent({ id: "e1", title: "小児科の検診" })]}
        householdId="h1"
        initialToday={TODAY}
      />,
    )

    // 「カード全体を Link 化」ゆえリンクは 1 本（イベント毎ではない）。
    const link = screen.getByRole("link")
    expect(link).toHaveAttribute("href", "/calendar")
    expect(link).toHaveTextContent("小児科の検診")
  })

  it("今日・明日とも予定が無い時は何も描画しない(null)", () => {
    const { container } = render(
      <UpcomingEventsCard
        initialEvents={[]}
        householdId="h1"
        initialToday={TODAY}
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it("翌日の予定だけがある時は「明日」見出しのみを出す", () => {
    render(
      <UpcomingEventsCard
        initialEvents={[
          timedEvent({
            id: "e2",
            title: "予防接種",
            start_date: TOMORROW,
            end_date: TOMORROW,
            start_at: `${TOMORROW}T05:00:00Z`,
          }),
        ]}
        householdId="h1"
        initialToday={TODAY}
      />,
    )

    expect(screen.getByText("明日")).toBeInTheDocument()
    expect(screen.queryByText("今日")).not.toBeInTheDocument()
    expect(screen.getByText("予防接種")).toBeInTheDocument()
  })

  // 以下 2 本は eventsForDate(sortDayEvents) / agendaTimeDisplay への委譲を固定する
  // 回帰テスト。独自ロジックへ差し替えられたら落ちる。
  it("終日 → 時刻順の並びで表示する", () => {
    render(
      <UpcomingEventsCard
        initialEvents={[
          timedEvent({ id: "t2", title: "夕方の用事", start_at: `${TODAY}T09:00:00Z` }), // JST 18:00
          allDayEvent({ id: "a1", title: "終日の用事" }),
          timedEvent({ id: "t1", title: "朝の用事", start_at: `${TODAY}T00:00:00Z` }), // JST 09:00
        ]}
        householdId="h1"
        initialToday={TODAY}
      />,
    )

    const titles = screen
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "")
    expect(titles[0]).toContain("終日の用事")
    expect(titles[1]).toContain("朝の用事")
    expect(titles[2]).toContain("夕方の用事")
  })

  it("前日から継続中の予定を CalendarAgenda と同じ「→」で表す", () => {
    render(
      <UpcomingEventsCard
        initialEvents={[
          timedEvent({
            id: "c1",
            title: "旅行",
            start_date: YESTERDAY, // 前日開始
            end_date: TODAY,
            start_at: `${YESTERDAY}T09:00:00Z`,
            end_at: null, // 継続中扱いフォールバック
          }),
        ]}
        householdId="h1"
        initialToday={TODAY}
      />,
    )

    expect(screen.getByText("→")).toBeInTheDocument()
    expect(screen.getByText("旅行")).toBeInTheDocument()
  })

  it("0 件で mount した後もタブ復帰で refetch して表示に反映する", async () => {
    // 「朝 0 件で開いたまま → 配偶者が予定追加 → 復帰しても出ない」の回帰防止。
    // 0 件 = null 描画でも hooks が生きていなければ refetch は永久に走らない。
    render(
      <UpcomingEventsCard
        initialEvents={[]}
        householdId="h1"
        initialToday={TODAY}
      />,
    )
    expect(screen.queryByText("あとから入った予定")).not.toBeInTheDocument()

    setRefetchData(mockState, [
      timedEvent({ id: "e9", title: "あとから入った予定" }),
    ])

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })

    await waitFor(() =>
      expect(screen.getByText("あとから入った予定")).toBeInTheDocument(),
    )
  })
})

// 2026-10-27 C1: 取得失敗を「予定なし」と区別する / C4: 前回の確認の後の追加・更新 / C3: 畳む
describe("UpcomingEventsCard / 取得失敗・引き継ぎの印・折り畳み", () => {
  beforeEach(() => {
    cleanup()
    resetRefetchMockState(mockState)
  })

  it("初回の取得に失敗していれば、0 件の null ではなく失敗と再試行を出す（予定がないとは言わぬ）", async () => {
    render(
      <UpcomingEventsCard initialEvents={[]} householdId="h1" initialToday={TODAY} initialLoadFailed />,
    )
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("予定を読み込めませんでした（予定がないとは限りません）")

    // 再試行が通って空なら、空として null に戻る（対照）
    setRefetchData(mockState, [])
    await act(async () => {
      screen.getByRole("button", { name: "予定をもう一度読み込む" }).click()
    })
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
  })

  it("表示中の予定がある時の取り直しの失敗は、予定を残したまま「最新を確認できません」と出す", async () => {
    render(
      <UpcomingEventsCard
        initialEvents={[timedEvent({ id: "e1", title: "健診" })]}
        householdId="h1"
        initialToday={TODAY}
      />,
    )
    setRefetchErrorOnce(mockState, { message: "upstream 503" })
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await waitFor(() => expect(screen.getByText(/最新を確認できません/)).toBeInTheDocument())
    expect(screen.getByText("健診")).toBeInTheDocument()
  })

  it("持ち主を渡すと、この端末で見た予定の id と版で印を出す（時刻の閾値で前後を断定せぬ。独立レビュー 2 周）", async () => {
    localStorage.clear()
    const owner = { userId: "u1", householdId: "h1" }
    const KEY = "irori:handoff-events-seen:v2:u1:h1"
    // 前回この端末で見たのは o1（版 06-30）と u1（版 06-20）。育児ログの印は無関係
    localStorage.setItem(
      KEY,
      JSON.stringify({
        o1: { u: "2026-06-30T00:00:00Z", d: TODAY },
        u1: { u: "2026-06-20T00:00:00Z", d: TODAY },
      }),
    )
    localStorage.setItem("irori:handoff-seen:v1:u1:h1", "2026-06-01T00:00:00Z")
    const view = render(
      <UpcomingEventsCard
        initialEvents={[
          // 前回の閲覧より前に作られたが、窓の外にいて見ておらぬ予定。時刻の前後は言わず「初めて表示」
          timedEvent({ id: "n1", title: "窓に入った予定", updated_at: "2026-06-01T00:00:00Z" }),
          timedEvent({ id: "o1", title: "前からの予定", updated_at: "2026-06-30T00:00:00Z" }),
          timedEvent({ id: "u1", title: "直された予定", updated_at: "2026-07-02T00:00:00Z" }),
          timedEvent({ id: "g1", title: "Google の予定", source: "google", updated_at: "2026-07-03T00:00:00Z" }),
        ]}
        householdId="h1"
        initialToday={TODAY}
        seenOwner={owner}
      />,
    )
    await waitFor(() => expect(screen.getByText("この端末で初めて表示")).toBeInTheDocument())
    expect(screen.getByText("この端末で初めて表示").closest("li")).toHaveTextContent("窓に入った予定")
    expect(screen.getByText("前回の確認後に更新").closest("li")).toHaveTextContent("直された予定")
    expect(screen.queryByText(/前回の確認後に追加/)).toBeNull()
    view.unmount()
    // 離れる時に、見えておる irori の予定（id と版）を足して残す（Google は数えぬ・育児ログの印には触れぬ）
    const saved = JSON.parse(localStorage.getItem(KEY)!)
    expect(Object.keys(saved).sort()).toEqual(["n1", "o1", "u1"])
    expect(saved.u1.u).toBe("2026-07-02T00:00:00Z")
    expect(localStorage.getItem("irori:handoff-seen:v1:u1:h1")).toBe("2026-06-01T00:00:00Z")
  })

  it("初めての確認（記録が無い）では印を出さず、畳んでおる間は「見た」と残さぬ", async () => {
    localStorage.clear()
    const owner = { userId: "u1", householdId: "h1" }
    const view = render(
      <UpcomingEventsCard
        initialEvents={[timedEvent({ id: "n1", title: "予定", updated_at: "2026-07-02T00:00:00Z" })]}
        householdId="h1"
        initialToday={TODAY}
        seenOwner={owner}
        folded
        onFoldChange={() => {}}
      />,
    )
    expect(screen.queryByText(/この端末で初めて表示|前回の確認後に更新/)).toBeNull()
    view.unmount()
    expect(localStorage.getItem("irori:handoff-events-seen:v2:u1:h1")).toBeNull()
  })

  it("畳むと件数だけの一行になり、開けば戻る（リンクは 1 本のまま）", () => {
    function Harness() {
      const [folded, setFolded] = React.useState(false)
      return (
        <UpcomingEventsCard
          initialEvents={[timedEvent({ id: "e1", title: "健診" })]}
          householdId="h1"
          initialToday={TODAY}
          folded={folded}
          onFoldChange={setFolded}
        />
      )
    }
    render(<Harness />)
    expect(screen.getAllByRole("link")).toHaveLength(1)
    act(() => {
      screen.getByRole("button", { name: "今日・明日の予定を畳む" }).click()
    })
    expect(screen.queryByText("健診")).not.toBeInTheDocument()
    const row = screen.getByRole("button", { name: /今日・明日の予定/ })
    expect(row).toHaveAttribute("aria-expanded", "false")
    expect(row).toHaveTextContent("1件")
    act(() => {
      row.click()
    })
    expect(screen.getByText("健診")).toBeInTheDocument()
  })
})

// 日跨ぎ後の作り直し（BabyDashboard が key={today} で作り直し、initialEvents を空で渡す）。
describe("UpcomingEventsCard / refetchOnMount", () => {
  // 呼び出し回数を数えるゆえ、前のテストの呼び出し記録を消す（cleanup → reset の順が要）
  beforeEach(() => {
    cleanup()
    resetRefetchMockState(mockState)
  })

  it("既定（読込日のまま）はマウント時に取りに行かぬ — サーバが渡した予定で足りる", async () => {
    render(
      <UpcomingEventsCard
        initialEvents={[allDayEvent({ id: "e1", title: "サーバの予定" })]}
        householdId="h1"
        initialToday={TODAY}
      />,
    )
    await act(async () => {})
    expect(mockState.fromMock).not.toHaveBeenCalled()
    expect(screen.getByText("サーバの予定")).toBeInTheDocument()
  })

  it("立てるとマウント直後に取り直し、取得した予定を出す", async () => {
    setRefetchData(mockState, [
      allDayEvent({ id: "e2", title: "取り直した予定" }),
    ])
    render(
      <UpcomingEventsCard
        initialEvents={[]}
        householdId="h1"
        initialToday={TODAY}
        refetchOnMount
      />,
    )
    await waitFor(() =>
      expect(screen.getByText("取り直した予定")).toBeInTheDocument(),
    )
    expect(mockState.fromMock).toHaveBeenCalledWith("calendar_events")
  })

  // 日跨ぎ後に作り直された直後、Server Action の revalidatePath で親の initialDate が今日へ
  // 追いつくと、親が渡す refetchOnMount は true → false に反転する（key は変わらぬ）。
  // prop に追従すると cleanup が取り直しを abort し、カードが空のまま残る。
  it("取り直しの途中で refetchOnMount が false へ反転しても、取り直しを abort せず予定を出す", async () => {
    setRefetchData(mockState, [
      allDayEvent({ id: "e4", title: "反転後も出る予定" }),
    ])
    const props = { initialEvents: [], householdId: "h1", initialToday: TODAY }
    const { rerender } = render(<UpcomingEventsCard {...props} refetchOnMount />)
    const signal = mockState.abortSignalMock?.mock.calls[0]?.[0] as
      | AbortSignal
      | undefined

    rerender(<UpcomingEventsCard {...props} refetchOnMount={false} />)
    expect(signal?.aborted).toBe(false)

    await waitFor(() =>
      expect(screen.getByText("反転後も出る予定")).toBeInTheDocument(),
    )
  })

  it("取り直しの途中でアンマウントしたら、そのクエリの signal を abort する", async () => {
    const { unmount } = render(
      <UpcomingEventsCard
        initialEvents={[]}
        householdId="h1"
        initialToday={TODAY}
        refetchOnMount
      />,
    )
    const signal = mockState.abortSignalMock?.mock.calls[0]?.[0] as
      | AbortSignal
      | undefined
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})
