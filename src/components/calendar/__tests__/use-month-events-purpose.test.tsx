/**
 * 月の予定の手元の写し（`useMonthEvents`）が、画面で解決した用途（ごみの日）を生の行へ
 * 持ち込まぬこと。失敗の復元・シリーズ削除で表示中の行を書き戻した後に、世帯の分類が
 * 0 件になっても（最後の分類を解除した）、古い「ごみ」の印を描き続けぬ。
 */
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/supabase/client", () => {
  const channel = { on: () => channel, subscribe: () => channel }
  return {
    createClient: () => ({
      channel: () => channel,
      removeChannel: () => {},
    }),
  }
})
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

import { useMonthEvents, type CalendarEventRecord } from "../use-month-events"
import type { EventPurposeRow } from "@/lib/domain/garbage"

const DAY = "2026-11-12"
const SERIES = "c9000000-0000-4000-8000-0000000000f0"
const E1 = "c9000000-0000-4000-8000-000000000001"
const E2 = "c9000000-0000-4000-8000-000000000002"

function row(id: string, o: Partial<CalendarEventRecord> = {}): CalendarEventRecord {
  return {
    id,
    title: "燃えるごみ",
    is_all_day: true,
    start_date: DAY,
    end_date: DAY,
    start_at: null,
    end_at: null,
    memo: null,
    source: "native",
    series_id: SERIES,
    updated_at: "2026-11-10T00:00:00.000000+00:00",
    event_uid: id,
    ...o,
  } as CalendarEventRecord
}

const seriesGarbage: EventPurposeRow = {
  id: "d9000000-0000-4000-8000-000000000001",
  scope: "series",
  targetKey: SERIES,
  purpose: "garbage",
  garbageKind: "燃えるごみ",
  remindDefault: "prev_day_20",
  reminderOptOut: false,
  updatedAt: "2026-11-10T00:00:00.000000+00:00",
}

function mount() {
  return renderHook(() =>
    useMonthEvents({
      initialEvents: [row(E1), row(E2, { start_date: "2026-11-19", end_date: "2026-11-19" })],
      householdId: "h1",
      initialView: { monthFirst: "2026-11-01", selectedDate: DAY },
      initialPurposes: { status: "ok", rows: [seriesGarbage] },
    }),
  )
}

describe("useMonthEvents: 書き戻した行に、解決済みの用途を残さぬ", () => {
  it("失敗の復元（upsertOptimistic）で書き戻した後に最後の分類を解除すると、ごみの印は消える", () => {
    const { result } = mount()
    const shown = result.current.events.find((e) => e.id === E1)!
    expect(shown.purpose).toMatchObject({ kind: "garbage", label: "燃えるごみ" })
    // 編集の失敗の復元: 開いた時点の行（画面で解決した用途つき）をそのまま書き戻す
    act(() => result.current.upsertOptimistic(shown))
    // 保存の後の読み戻し: 世帯の分類は 0 件になった
    act(() => result.current.acceptPurposeLoad({ status: "ok", rows: [] }))
    for (const event of result.current.events) {
      expect(event.purpose === undefined || event.purpose.kind === "normal").toBe(true)
    }
  })

  it("シリーズの一括削除（setAllEvents）で残りを書き戻した後でも、分類が無くなれば通常の予定に戻る", () => {
    const { result } = mount()
    act(() => result.current.setAllEvents(result.current.events.filter((e) => e.id !== E2)))
    act(() => result.current.acceptPurposeLoad({ status: "ok", rows: [] }))
    expect(result.current.events).toHaveLength(1)
    const [left] = result.current.events
    expect(left.purpose === undefined || left.purpose.kind === "normal").toBe(true)
  })

  it("分類が在る間は、書き戻した行も今の分類で描く（印を落とさぬ）", () => {
    const { result } = mount()
    const shown = result.current.events.find((e) => e.id === E1)!
    act(() => result.current.upsertOptimistic(shown))
    expect(result.current.events.find((e) => e.id === E1)?.purpose).toMatchObject({ kind: "garbage" })
  })
})
