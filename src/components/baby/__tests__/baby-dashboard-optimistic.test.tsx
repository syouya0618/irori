/**
 * B-03（記録反映の Realtime 単一経路 → 楽観 append）の統合テスト。
 *
 * 背景: revalidatePath の RSC 更新は useState(initialLogs) シードに破棄されるため、
 * 記録の即時反映は事実上 Realtime 単一経路だった。#92（本番 Realtime 不達）下では
 * 記録しても timeline/回数が更新されず、feeding/diaper は UNIQUE 防御が無いため
 * 再タップで二重記録の実害が出る。本 PR は Server Action が返す id で楽観 append し、
 * 既存の Realtime echo は id 重複スキップ（baby-dashboard.tsx の INSERT append）で吸収する。
 *
 * 検証対象（計画書 §3 B-03 の fail-red 3 点）:
 * 1. Realtime を発火させずに記録アクションが解決 → logs に新行（今日のまとめ 回数 / timeline）
 * 2. Undo（取り消す）成功で logs から除去される
 * 3. 同 id の Realtime INSERT echo が来ても二重 append されない（1 件のまま）
 *
 * 時刻は実タイマー + todayJstString() の実時刻から組む
 * （記録の logged_at は client now = 当日ゆえ選択日窓に入る）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react"
import { act } from "react"
import type { BabyLogData } from "@/lib/types/baby"
import type {
  RealtimePayload,
  ViFn,
} from "@/test-utils/supabase-realtime-mock"
import {
  emitPayload,
  makePayloadFor,
  resetInlineReducerMockState,
} from "@/test-utils/supabase-realtime-mock"
import { todayJstString } from "@/lib/utils/date-jst"
import { recordDiaper, deleteLog } from "@/app/(main)/baby/actions"
import { toast } from "sonner"

const mockState = vi.hoisted(() => ({
  listeners: [] as Array<(payload: unknown) => void>,
  removeChannelMock: undefined as unknown as ViFn,
  fromMock: undefined as unknown as ViFn,
}))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  const { buildInlineReducerSupabaseMock } = await import(
    "@/test-utils/supabase-realtime-mock"
  )
  return buildInlineReducerSupabaseMock(viMod, mockState, {
    throwMessage:
      "supabase.from() should not be called in this test " +
      "(selectedDate must not change to trigger the date-change useEffect)",
  })
})

vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  deleteLog: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
  updateLog: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// vi.mock 後 import
import { BabyDashboard } from "../baby-dashboard"

const mockedRecordDiaper = vi.mocked(recordDiaper)
const mockedDeleteLog = vi.mocked(deleteLog)
const mockedToast = vi.mocked(toast)

const TODAY = todayJstString()

const makePayload = makePayloadFor<BabyLogData>("baby_logs")
const emit = (payload: RealtimePayload<BabyLogData>) =>
  emitPayload(mockState, payload)

function makeLog(
  overrides: Partial<BabyLogData> &
    Pick<BabyLogData, "id" | "log_type" | "logged_at">,
): BabyLogData {
  return {
    logged_by: "user-1",
    feeding_type: null,
    amount_ml: null,
    breast_left_count: null,
    breast_right_count: null,
    breast_left_sec: null,
    breast_right_sec: null,
    diaper_type: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: null,
    created_at: `${TODAY}T00:00:00+09:00`,
    ...overrides,
  }
}

function defaultProps(
  overrides: Partial<Parameters<typeof BabyDashboard>[0]> = {},
): Parameters<typeof BabyDashboard>[0] {
  return {
    initialLogs: [],
    initialWeeklyLogs: [],
    initialGrowthLogs: [],
    householdId: "h1",
    userId: "u1",
    initialDate: TODAY,
    initialDiary: null,
    lastFeedingFallback: null,
    babyName: null,
    babyBirthDate: null,
    pumpingIntervalMin: 180,
    ...overrides,
  }
}

/** 今日のまとめカード内スコープ */
function summary(): HTMLElement {
  return screen.getByLabelText("今日のまとめ")
}

/** 直近の toast.success に付いた undo アクション onClick を取り出す */
function lastUndoOnClick(): (() => void) | undefined {
  const call = mockedToast.success.mock.calls.at(-1)
  const opts = call?.[1] as
    | { action?: { label: string; onClick: () => void } }
    | undefined
  return opts?.action?.onClick
}

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()
  resetInlineReducerMockState(mockState)
})
afterEach(cleanup)

describe("BabyDashboard / 記録の楽観 append (B-03)", () => {
  it("Realtime を発火させずに おむつ 記録が解決すると今日のまとめの回数が 0→1・timeline に行が出る", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-opt-1" })
    render(<BabyDashboard {...defaultProps()} />)

    // 初期: timeline 空・今日のまとめ おむつ 内訳 0/0
    expect(screen.getByText("まだ記録がありません")).toBeInTheDocument()
    expect(
      within(summary()).getByText("おしっこ0・うんち0"),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))

    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalled())

    // Realtime を一切 emit していないのに、楽観 append で内訳が おしっこ1・うんち0 になる
    await waitFor(() =>
      expect(
        within(summary()).getByText("おしっこ1・うんち0"),
      ).toBeInTheDocument(),
    )
    // timeline にも新行が出る（空状態は消える）
    expect(screen.queryByText("まだ記録がありません")).not.toBeInTheDocument()
  })

  it("Undo（取り消す）成功で logs から除去され、今日のまとめが 0 に戻る", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-opt-2" })
    mockedDeleteLog.mockResolvedValue({ error: null })
    render(<BabyDashboard {...defaultProps()} />)

    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() =>
      expect(
        within(summary()).getByText("おしっこ1・うんち0"),
      ).toBeInTheDocument(),
    )

    // 記録直後トーストの「取り消す」を発火
    const undo = lastUndoOnClick()
    expect(undo).toBeTypeOf("function")
    act(() => {
      undo?.()
    })

    await waitFor(() =>
      expect(mockedDeleteLog).toHaveBeenCalledWith("diaper-opt-2"),
    )
    // Realtime DELETE echo 無しでも logs から消える
    await waitFor(() =>
      expect(screen.getByText("まだ記録がありません")).toBeInTheDocument(),
    )
    expect(
      within(summary()).getByText("おしっこ0・うんち0"),
    ).toBeInTheDocument()
  })

  it("同 id の Realtime INSERT echo が来ても二重 append されない（おしっこ1・うんち0 のまま）", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-echo" })
    render(<BabyDashboard {...defaultProps()} />)

    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() =>
      expect(
        within(summary()).getByText("おしっこ1・うんち0"),
      ).toBeInTheDocument(),
    )

    // 同じ id の INSERT echo（本番 Realtime が後追いで届くケース）
    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "diaper-echo",
            log_type: "diaper",
            logged_at: `${TODAY}T09:00:00+09:00`,
            diaper_type: "pee",
          }),
        ),
      )
    })

    // 二重に増えない
    expect(
      within(summary()).getByText("おしっこ1・うんち0"),
    ).toBeInTheDocument()
    expect(
      within(summary()).queryByText("おしっこ2・うんち0"),
    ).not.toBeInTheDocument()
  })
})
