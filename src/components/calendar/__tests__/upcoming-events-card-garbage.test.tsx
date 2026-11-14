/**
 * 育児ホームの「今日・明日の予定」カードでの、ごみの日の表示（家事機能 A: A-01）。
 *
 * - ごみの予定はアイコン + 「ごみ・名称」で区別する。通常の予定の行は従来のまま
 * - 分類を読めなんだ時・取り直しに失敗した時も、予定の表示を倒さぬ
 * - 取り直し（復帰時）で分類も読み直す。予定の SELECT は鍵つき（既存の列だけ）
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react"
import { act } from "react"

import type { RefetchRealtimeMockState, ViFn } from "@/test-utils/supabase-realtime-mock"
import { resetRefetchMockState, setRefetchData } from "@/test-utils/supabase-realtime-mock"
import type { CalendarEventRecord } from "@/components/calendar/use-month-events"
import type { EventPurposeLoad, EventPurposeRow } from "@/lib/domain/garbage"
import { CALENDAR_EVENT_COLUMNS, CALENDAR_EVENT_COLUMNS_WITH_KEYS } from "@/lib/domain/calendar-event-columns"
import { shiftYmd, todayJstString } from "@/lib/utils/date-jst"

const mockState = vi.hoisted(
  () =>
    ({
      listeners: [],
      removeChannelMock: undefined,
      channelNameMock: undefined,
      fromMock: undefined,
      selectMock: undefined,
      eqMock: undefined,
      gteMock: undefined,
      lteMock: undefined,
      orderMock: undefined,
      abortSignalMock: undefined,
      currentResolveData: [],
      purposeRows: undefined,
      purposeError: null,
    }) as RefetchRealtimeMockState<CalendarEventRecord>,
)

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  const { buildRefetchSupabaseMock } = await import("@/test-utils/supabase-realtime-mock")
  return buildRefetchSupabaseMock<CalendarEventRecord>(viMod, mockState)
})
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

import { UpcomingEventsCard } from "../upcoming-events-card"

// 実時計から導く（固定リテラルにすると、翌日以降に取り直しのテストが恒常的に落ちる）
const TODAY = todayJstString()
const TOMORROW = shiftYmd(TODAY, 1)
const GARBAGE = "c8000000-0000-4000-8000-000000000001"
const NORMAL = "c8000000-0000-4000-8000-000000000002"

function event(over: Partial<CalendarEventRecord> & Pick<CalendarEventRecord, "id" | "title">): CalendarEventRecord {
  return {
    is_all_day: true,
    start_date: TODAY,
    end_date: over.start_date ?? TODAY,
    start_at: null,
    end_at: null,
    memo: null,
    source: "native",
    series_id: null,
    updated_at: "2026-07-01T00:00:00.000000+00:00",
    event_uid: over.id,
    ...over,
  }
}

function purposeRow(over: Partial<EventPurposeRow> = {}): EventPurposeRow {
  return {
    id: "d8000000-0000-4000-8000-000000000001",
    scope: "event",
    targetKey: GARBAGE,
    purpose: "garbage",
    garbageKind: "燃えるごみ",
    remindDefault: null,
    reminderOptOut: false,
    updatedAt: null,
    ...over,
  }
}
const ok = (...rows: EventPurposeRow[]): EventPurposeLoad => ({ status: "ok", rows })

const events = [
  event({ id: GARBAGE, title: "収集の日", start_date: TOMORROW }),
  event({ id: NORMAL, title: "保育園の面談", start_date: TOMORROW }),
]

beforeEach(() => {
  cleanup()
  resetRefetchMockState(mockState)
})

describe("UpcomingEventsCard: ごみの日", () => {
  it("同じ日の通常の予定とごみの予定を、アイコン + 名称で区別する", () => {
    render(
      <UpcomingEventsCard
        initialEvents={events}
        initialPurposes={ok(purposeRow())}
        householdId="h1"
        initialToday={TODAY}
      />,
    )
    const garbageRow = screen.getByText("収集の日").closest("li")!
    const normalRow = screen.getByText("保育園の面談").closest("li")!
    expect(garbageRow).toHaveTextContent("ごみ・燃えるごみ")
    expect(garbageRow.querySelector("[data-garbage-kind='燃えるごみ'] svg")).not.toBeNull()
    // 通常の予定は従来のまま（ごみと言わぬ）
    expect(normalRow.textContent).not.toContain("ごみ")
    expect(normalRow.querySelector("[data-garbage-kind]")).toBeNull()
  })

  it("分類を渡さぬ呼び出し元（従来）では、どの行にも印を出さぬ", () => {
    render(<UpcomingEventsCard initialEvents={events} householdId="h1" initialToday={TODAY} />)
    expect(screen.getByText("収集の日")).toBeInTheDocument()
    expect(document.querySelector("[data-garbage-kind]")).toBeNull()
  })

  it("分類を読めなんだ時も予定は描く（印は出さぬ。ごみとも通常とも言い切らぬ）", () => {
    render(
      <UpcomingEventsCard
        initialEvents={events}
        initialPurposes={{ status: "failed" }}
        householdId="h1"
        initialToday={TODAY}
      />,
    )
    expect(screen.getByText("収集の日")).toBeInTheDocument()
    expect(screen.getByText("保育園の面談")).toBeInTheDocument()
    expect(document.querySelector("[data-garbage-kind]")).toBeNull()
    // 予定の取得は失敗しておらぬゆえ、失敗の表示も出さぬ
    expect(screen.queryByText(/予定を読み込めませんでした/)).toBeNull()
  })

  it("分類を読めておらぬ時は、その旨を文で言う（印の無い行を「ごみの日ではない」と読ませぬ。R13）", () => {
    render(
      <UpcomingEventsCard
        initialEvents={events}
        initialPurposes={{ status: "failed" }}
        householdId="h1"
        initialToday={TODAY}
      />,
    )
    const notice = screen.getByTestId("upcoming-purpose-unknown")
    expect(notice).toHaveAttribute("role", "status")
    expect(notice).toHaveTextContent("ごみの日の分類を読み込めていません（印のない予定が、ごみの日ではないとは限りません）")
    // 読み直せる（44px の押下対象）。カード全体のリンクの外に置く（リンクの中に釦を入れぬ）
    const retry = screen.getByRole("button", { name: "ごみの日の分類をもう一度読み込む" })
    expect(retry.className).toContain("touch-target")
    expect(retry.closest("a")).toBeNull()
    // 予定の取得の失敗（「最新を確認できません」）とは別の表示
    expect(screen.queryByText(/最新を確認できません/)).toBeNull()
  })

  it("対照: 分類を読めておる時・分類を渡さぬ呼び出し元では、その文を出さぬ", () => {
    render(
      <UpcomingEventsCard initialEvents={events} initialPurposes={ok(purposeRow())} householdId="h1" initialToday={TODAY} />,
    )
    expect(screen.queryByTestId("upcoming-purpose-unknown")).toBeNull()
    cleanup()
    // 読めて 0 行（分類が無い世帯）も「読めておらぬ」ではない
    render(<UpcomingEventsCard initialEvents={events} initialPurposes={ok()} householdId="h1" initialToday={TODAY} />)
    expect(screen.queryByTestId("upcoming-purpose-unknown")).toBeNull()
    cleanup()
    render(<UpcomingEventsCard initialEvents={events} householdId="h1" initialToday={TODAY} />)
    expect(screen.queryByTestId("upcoming-purpose-unknown")).toBeNull()
  })

  it("読み直しで分類を読めれば、文が消えて印が出る。読めぬままなら文は残る", async () => {
    const user = () => fireEvent.click(screen.getByRole("button", { name: "ごみの日の分類をもう一度読み込む" }))
    render(
      <UpcomingEventsCard
        initialEvents={events}
        initialPurposes={{ status: "failed" }}
        householdId="h1"
        initialToday={TODAY}
      />,
    )
    // 1 回目: まだ読めぬ（予定の取得は成功）
    setRefetchData(mockState, events)
    mockState.purposeError = { message: "synthetic" }
    await act(async () => {
      user()
    })
    await waitFor(() => expect(screen.getByRole("button", { name: "ごみの日の分類をもう一度読み込む" })).not.toBeDisabled())
    expect(screen.getByTestId("upcoming-purpose-unknown")).toBeInTheDocument()
    expect(document.querySelector("[data-garbage-kind]")).toBeNull()
    // 2 回目: 読めた
    mockState.purposeError = null
    mockState.purposeRows = [
      { id: "d8000000-0000-4000-8000-000000000001", scope: "event", target_key: GARBAGE, purpose: "garbage", garbage_kind: "古紙", remind_default: null, reminder_opt_out: false, updated_at: null },
    ]
    await act(async () => {
      user()
    })
    await waitFor(() => expect(screen.queryByTestId("upcoming-purpose-unknown")).toBeNull())
    expect(screen.getByText("収集の日").closest("li")).toHaveTextContent("ごみ・古紙")
  })

  it("復帰の取り直しで分類も読み直し、鍵つきの列で予定を引く", async () => {
    render(
      <UpcomingEventsCard
        initialEvents={events}
        initialPurposes={{ status: "failed" }}
        householdId="h1"
        initialToday={TODAY}
      />,
    )
    setRefetchData(mockState, events)
    mockState.purposeRows = [
      { id: "d8000000-0000-4000-8000-000000000001", scope: "event", target_key: GARBAGE, purpose: "garbage", garbage_kind: "古紙", remind_default: null, reminder_opt_out: false, updated_at: null },
    ]
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await waitFor(() => expect(screen.getByText("収集の日").closest("li")).toHaveTextContent("ごみ・古紙"))
    expect((mockState.fromMock as ViFn).mock.calls.map(([t]) => t).sort()).toEqual(["calendar_events", "event_purposes"])
    // 足したのは既存の列だけ（元の一式を全て含む）
    expect(mockState.selectMock).toHaveBeenLastCalledWith(CALENDAR_EVENT_COLUMNS_WITH_KEYS)
    expect(CALENDAR_EVENT_COLUMNS_WITH_KEYS.startsWith(`${CALENDAR_EVENT_COLUMNS}, `)).toBe(true)
  })

  it("分類の取り直しだけが失敗しても、予定は更新し、前に読めた分類を保つ", async () => {
    render(
      <UpcomingEventsCard
        initialEvents={events}
        initialPurposes={ok(purposeRow())}
        householdId="h1"
        initialToday={TODAY}
      />,
    )
    setRefetchData(mockState, [...events, event({ id: "c8000000-0000-4000-8000-000000000003", title: "歯医者" })])
    mockState.purposeError = { message: "synthetic" }
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await waitFor(() => expect(screen.getByText("歯医者")).toBeInTheDocument())
    expect(screen.getByText("収集の日").closest("li")).toHaveTextContent("ごみ・燃えるごみ")
    expect(screen.queryByText(/最新を確認できません/)).toBeNull()
    // 前に読めた分類で描いておることを、カレンダーと同じく文で言う（家族の新しい分類が映っておらぬかもしれぬ）
    await waitFor(() =>
      expect(screen.getByTestId("upcoming-purpose-unknown")).toHaveTextContent("ごみの日の分類が最新でない可能性があります"),
    )
    // 次の取り直しで読めれば消える
    mockState.purposeError = null
    mockState.purposeRows = [
      { id: "d8000000-0000-4000-8000-000000000001", scope: "event", target_key: GARBAGE, purpose: "garbage", garbage_kind: "燃えるごみ", remind_default: null, reminder_opt_out: false, updated_at: null },
    ]
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await waitFor(() => expect(screen.queryByTestId("upcoming-purpose-unknown")).toBeNull())
    expect(screen.getByText("収集の日").closest("li")).toHaveTextContent("ごみ・燃えるごみ")
  })
})
