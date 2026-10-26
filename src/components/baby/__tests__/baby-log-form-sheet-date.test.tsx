/**
 * BabyLogFormSheet の日付（機能 C: 過去日の追記と日時修正）。
 *
 * - 新規: 親が渡す createDate（過去日）で作り、見出し直下に「その日の記録として保存する」
 *   と示す。時刻と合わせた ISO を record* へ渡す
 * - 編集: 日付を変えると loggedAt を送る（深夜を跨いだ授乳の開始時刻を前日へ直せる）。
 *   日付も時刻も触らねば loggedAt は送らぬ（秒の無言喪失を防ぐ既存契約）
 * - 未来の日付は record* へ届く前に拒む
 * - おむつも過去日の追記で記録できる（クイック記録とは別経路）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"

vi.mock("@/app/(main)/baby/actions", () => ({
  updateLog: vi.fn(),
  deleteLog: vi.fn(),
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BabyLogFormSheet } from "../baby-log-form-sheet"
import { recordMemo, recordDiaper, updateLog } from "@/app/(main)/baby/actions"
import { toast } from "sonner"
import { FUTURE_LOG_TIME_ERROR } from "@/lib/domain/baby-log-time"
import { toJstDateString, formatJstTimeInput } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"

const mockedRecordMemo = vi.mocked(recordMemo)
const mockedRecordDiaper = vi.mocked(recordDiaper)
const mockedUpdateLog = vi.mocked(updateLog)

// JST 2026-07-19 13:00 に固定（日跨ぎの影響を受けぬ日中）
const FIXED_NOW = new Date("2026-07-19T04:00:00.000Z")
const TODAY = "2026-07-19"
const YESTERDAY = "2026-07-18"

function feedingLog(overrides: Partial<BabyLogData> = {}): BabyLogData {
  return {
    id: "log-1",
    log_type: "feeding",
    // JST 7/19 00:10 開始（実は前日 23:50 開始じゃった、という修正を想定）
    logged_at: "2026-07-18T15:10:00.000Z",
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
    created_at: "2026-07-18T15:10:00.000Z",
    // 開いた時点の版（保存はこの版を第 3 引数で送る。P2-07）
    updated_at: "2026-07-18T15:10:00.123456+00:00",
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("BabyLogFormSheet / 過去日の追記（createDate）", () => {
  it("createDate の日付で開き、その日の記録として保存することを示し、ISO にも反映する", async () => {
    mockedRecordMemo.mockResolvedValue({ error: null, id: "memo-1" })
    render(
      <BabyLogFormSheet
        open
        onOpenChange={vi.fn()}
        log={null}
        createLogType="memo"
        createDate={YESTERDAY}
        userId="u1"
      />,
    )
    const date = screen.getByLabelText("日付") as HTMLInputElement
    expect(date.value).toBe(YESTERDAY)
    expect(date.max).toBe(TODAY)
    expect(screen.getByText(/2026年7月18日\(土\) の記録として保存します/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText("時刻"), { target: { value: "09:30" } })
    fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "よく寝た" } })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))

    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(1))
    const payload = mockedRecordMemo.mock.calls[0][0]
    expect(payload.loggedAt).toBe("2026-07-18T00:30:00.000Z") // JST 7/18 09:30
    expect(toJstDateString(payload.loggedAt as string)).toBe(YESTERDAY)
  })

  it("createDate が今日なら従来どおり（過去日の注記は出ない）", () => {
    render(
      <BabyLogFormSheet
        open
        onOpenChange={vi.fn()}
        log={null}
        createLogType="memo"
        createDate={TODAY}
        userId="u1"
      />,
    )
    expect((screen.getByLabelText("日付") as HTMLInputElement).value).toBe(TODAY)
    expect(screen.queryByText(/の記録として保存します/)).toBeNull()
  })

  it("未来の日付は record* へ届く前に拒む", async () => {
    render(
      <BabyLogFormSheet
        open
        onOpenChange={vi.fn()}
        log={null}
        createLogType="memo"
        createDate={YESTERDAY}
        userId="u1"
      />,
    )
    fireEvent.change(screen.getByLabelText("日付"), { target: { value: "2026-07-20" } })
    fireEvent.change(screen.getByLabelText("メモ"), { target: { value: "x" } })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(FUTURE_LOG_TIME_ERROR))
    expect(mockedRecordMemo).not.toHaveBeenCalled()
  })

  it("おむつも過去日に追記できる（種類と量を選び、日付つきで recordDiaper へ）", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-1" })
    const onLogRecorded = vi.fn()
    render(
      <BabyLogFormSheet
        open
        onOpenChange={vi.fn()}
        log={null}
        createLogType="diaper"
        createDate={YESTERDAY}
        userId="u1"
        onLogRecorded={onLogRecorded}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "うんち" }))
    fireEvent.click(screen.getByRole("button", { name: "大量" }))
    fireEvent.change(screen.getByLabelText("時刻"), { target: { value: "21:00" } })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))

    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(1))
    expect(mockedRecordDiaper).toHaveBeenCalledWith({
      diaperType: "poop",
      poopAmount: "large",
      loggedAt: "2026-07-18T12:00:00.000Z",
      memo: undefined,
      clientId: expect.any(String),
    })
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(onLogRecorded.mock.calls[0][0]).toMatchObject({
      id: "diaper-1",
      log_type: "diaper",
      diaper_type: "poop",
      poop_amount: "large",
      logged_at: "2026-07-18T12:00:00.000Z",
    })
  })
})

describe("BabyLogFormSheet / 編集で日付を直す（深夜を跨いだ授乳の開始時刻）", () => {
  it("日付だけを前日に変えると、同じ時刻のまま前日の ISO を loggedAt に送る", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    const log = feedingLog()
    render(
      <BabyLogFormSheet open onOpenChange={vi.fn()} log={log} userId="u1" />,
    )
    const date = screen.getByLabelText("日付") as HTMLInputElement
    expect(date.value).toBe(TODAY) // JST 7/19 00:10
    expect((screen.getByLabelText("開始時刻") as HTMLInputElement).value).toBe(
      formatJstTimeInput(log.logged_at),
    )

    fireEvent.change(date, { target: { value: YESTERDAY } })
    fireEvent.change(screen.getByLabelText("開始時刻"), { target: { value: "23:50" } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalledTimes(1))
    expect(mockedUpdateLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ loggedAt: "2026-07-18T14:50:00.000Z" }), // JST 7/18 23:50
      "2026-07-18T15:10:00.123456+00:00",
    )
  })

  it("日付だけを前日に変えると、時刻は秒・ミリ秒まで元のまま前日へ動かす（HH:mm 丸めで秒を落とさぬ）", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    // JST 7/19 00:10:31.123（DB の表記のまま）
    const log = feedingLog({ logged_at: "2026-07-18T15:10:31.123456+00:00" })
    render(<BabyLogFormSheet open onOpenChange={vi.fn()} log={log} userId="u1" />)

    fireEvent.change(screen.getByLabelText("日付"), { target: { value: YESTERDAY } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalledTimes(1))
    expect(mockedUpdateLog.mock.calls[0][1].loggedAt).toBe("2026-07-17T15:10:31.123Z")
  })

  it("日付を変えて時刻も変えたら、打った時刻（秒は 0）で送る（対照）", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    const log = feedingLog({ logged_at: "2026-07-18T15:10:31.123456+00:00" })
    render(<BabyLogFormSheet open onOpenChange={vi.fn()} log={log} userId="u1" />)

    fireEvent.change(screen.getByLabelText("日付"), { target: { value: YESTERDAY } })
    fireEvent.change(screen.getByLabelText("開始時刻"), { target: { value: "00:11" } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalledTimes(1))
    expect(mockedUpdateLog.mock.calls[0][1].loggedAt).toBe("2026-07-17T15:11:00.000Z")
  })

  it("日付だけを未来の日へ変えると updateLog を呼ばずに拒む", async () => {
    render(<BabyLogFormSheet open onOpenChange={vi.fn()} log={feedingLog()} userId="u1" />)
    fireEvent.change(screen.getByLabelText("日付"), { target: { value: "2026-07-20" } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(FUTURE_LOG_TIME_ERROR))
    expect(mockedUpdateLog).not.toHaveBeenCalled()
  })

  it("日付も時刻も触らねば loggedAt は送らない（秒の無言喪失を防ぐ既存契約）", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet open onOpenChange={vi.fn()} log={feedingLog()} userId="u1" />,
    )
    fireEvent.change(screen.getByLabelText("量 (ml)"), { target: { value: "90" } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalledTimes(1))
    const updates = mockedUpdateLog.mock.calls[0][1]
    expect("loggedAt" in updates).toBe(false)
  })

  it("日付を変えてから元に戻せば loggedAt は送らない（dirty 判定は seed との比較）", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet open onOpenChange={vi.fn()} log={feedingLog()} userId="u1" />,
    )
    const date = screen.getByLabelText("日付")
    fireEvent.change(date, { target: { value: YESTERDAY } })
    fireEvent.change(date, { target: { value: TODAY } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalledTimes(1))
    expect("loggedAt" in mockedUpdateLog.mock.calls[0][1]).toBe(false)
  })
})
