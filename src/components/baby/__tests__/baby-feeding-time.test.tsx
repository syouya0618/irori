/**
 * クイック記録の行の時刻が「入力していないのに変わる / 打った時刻と違う」不具合の回帰
 * （2026-10-25、ミルクの記録時刻の報告）。
 *
 * 経路: クイック記録（loggedAt を送らず DB の now() に委ねる）→ タイムラインの行を開いて
 * 量・時刻を直す → 更新する。
 *
 * 時計が二つあった。DB の行は INSERT した瞬間の now()、画面の行（楽観行）は応答が届いた
 * 瞬間の端末時計で組まれておった。応答は revalidatePath の再描画と通信の後に届くゆえ、
 * 両者は数百 ms〜数秒（端末の時計がずれておればそれ以上）食い違い、分を跨ぐと HH:mm が
 * 変わる。編集シートはその画面の行で seed するゆえ、量だけの更新でも・見えておった時刻を
 * 打ち直しての更新でも、保存後に表示が DB 側の時刻へ飛ぶ。Realtime の INSERT echo は同じ
 * id の行を捨てるため、再取得かリロードまで画面の時刻は直らぬ。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"
import { act } from "react"
import { toast } from "sonner"
import type { BabyLogData } from "@/lib/types/baby"
import type { ViFn } from "@/test-utils/supabase-realtime-mock"
import { resetInlineReducerMockState } from "@/test-utils/supabase-realtime-mock"
import { recordFeeding, recordDiaper, updateLog } from "@/app/(main)/baby/actions"

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
  const base = buildInlineReducerSupabaseMock(viMod, mockState, {
    throwMessage: "supabase.from() should not be called in this test",
  })
  // マウント時の再取得は保留のまま止める（楽観行と編集の応答だけを見る）
  return {
    createClient: () => ({
      ...(base.createClient() as object),
      auth: { getSession: () => new Promise(() => {}) },
    }),
  }
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))

import { BabyDashboard } from "../baby-dashboard"

const mockedRecordFeeding = vi.mocked(recordFeeding)
const mockedRecordDiaper = vi.mocked(recordDiaper)
const mockedUpdateLog = vi.mocked(updateLog)

const TODAY = "2026-10-25"
// 押した瞬間（JST 14:20:58）
const TAP_AT = new Date("2026-10-25T05:20:58.000Z")
// DB が INSERT した瞬間の now()（JST 14:20:59.4）。PostgREST の表記のまま
const DB_LOGGED_AT = "2026-10-25T05:20:59.400123+00:00"
const DB_VERSION = "2026-10-25T05:20:59.400123+00:00"
// 応答が届いた瞬間の端末時計（JST 14:21:00.6 — 分を跨いだ）
const RESPONSE_AT = new Date("2026-10-25T05:21:00.600Z")
const EDITED_VERSION = "2026-10-25T05:25:00.000001+00:00"

function dbRow(overrides: Partial<BabyLogData> = {}): BabyLogData {
  return {
    id: "milk-1",
    log_type: "feeding",
    logged_at: DB_LOGGED_AT,
    logged_by: "u1",
    feeding_type: "bottle",
    // クイック記録はいつものミルク量（120ml）で書く
    amount_ml: 120,
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
    created_at: DB_LOGGED_AT,
    updated_at: DB_VERSION,
    ...overrides,
  }
}

function props(): Parameters<typeof BabyDashboard>[0] {
  return {
    initialLogs: [],
    initialWeeklyLogs: [],
    initialGrowthLogs: [],
    householdId: "h1",
    userId: "u1",
    initialDate: TODAY,
    initialDiary: null,
    lastFeedingFallback: null,
    lastNursingFallback: null,
    babyName: null,
    babyBirthDate: null,
    feedingIntervalMin: 180,
    // いつものミルク量が決まっている世帯。未設定だと「ミルク」は量を決めるシートを開き、
    // 1 タップで記録されぬ（この回帰の前提が崩れる）
    initialBottleDefault: { status: "set", amountMl: 120 },
  }
}

/** タイムラインの行（時刻と要約を持つボタン）。シート表示中は背面が aria-hidden ゆえ hidden も含める */
function timelineRows(time: string, summary: string): HTMLElement[] {
  return screen
    .getAllByRole("button", { hidden: true })
    .filter((b) => b.textContent?.includes(time) && b.textContent?.includes(summary))
}

/** タイムラインのミルクの行（時刻で絞らぬ。クイック記録の釦「ミルク」は時刻を持たぬゆえ外れる） */
function milkRow(): HTMLElement {
  const rows = screen
    .getAllByRole("button", { hidden: true })
    .filter((b) => b.textContent?.includes("ミルク") && /\d\d:\d\d/.test(b.textContent))
  expect(rows).toHaveLength(1)
  return rows[0]
}

/** 編集の応答: サーバは送られた列だけを書き、残りは DB の行のまま返す */
function answerUpdateFromDb(base: BabyLogData) {
  mockedUpdateLog.mockImplementation(async (_id, updates) => ({
    error: null,
    log: {
      ...base,
      ...(updates.amountMl !== undefined && { amount_ml: updates.amountMl }),
      ...(updates.loggedAt !== undefined && { logged_at: updates.loggedAt }),
      updated_at: EDITED_VERSION,
    },
  }))
}

/**
 * 「ミルク」をクイック記録する。サーバは DB の now() で書き（応答に記録時刻を載せる）、
 * 応答は `respondAt` の端末時計で届く。
 */
async function quickRecordMilk(respondAt: Date = RESPONSE_AT, loggedAt = DB_LOGGED_AT) {
  mockedRecordFeeding.mockImplementation(async () => {
    vi.setSystemTime(respondAt)
    return { error: null, id: "milk-1", updatedAt: loggedAt, loggedAt }
  })
  render(<BabyDashboard {...props()} />)
  fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
  await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(1))
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("button", { hidden: true })
        .filter((b) => b.textContent?.includes("ミルク") && /\d\d:\d\d/.test(b.textContent)),
    ).toHaveLength(1),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks は実装・Once の待ち行列を消さぬ（前のテストの実装が漏れぬよう個別に戻す）
  mockedRecordFeeding.mockReset()
  mockedRecordDiaper.mockReset()
  mockedUpdateLog.mockReset()
  cleanup()
  resetInlineReducerMockState(mockState)
  vi.useFakeTimers({ now: TAP_AT, toFake: ["Date"] })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("クイック記録の行は DB の記録時刻で画面に出る", () => {
  it("ミルク: 応答が分を跨いで届いても、タイムラインは DB の記録時刻（14:20）を示す", async () => {
    await quickRecordMilk()
    expect(timelineRows("14:20", "ミルク")).toHaveLength(1)
    expect(timelineRows("14:21", "ミルク")).toHaveLength(0)
  })

  it("おむつ: 同じ経路（loggedAt を送らぬクイック記録）も DB の記録時刻を示す", async () => {
    mockedRecordDiaper.mockImplementation(async () => {
      vi.setSystemTime(RESPONSE_AT)
      return { error: null, id: "pee-1", updatedAt: DB_VERSION, loggedAt: DB_LOGGED_AT }
    })
    render(<BabyDashboard {...props()} />)
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(
        timelineRows("14:20", "おしっこ").length + timelineRows("14:21", "おしっこ").length,
      ).toBe(1),
    )
    expect(timelineRows("14:20", "おしっこ")).toHaveLength(1)
  })

  it("取り消しの帯も DB の記録時刻（14:20）を示し、タイムラインの行と食い違わぬ", async () => {
    await quickRecordMilk()
    // トーストが消えた後に帯が出る（sonner は mock ゆえ onAutoClose を手で呼ぶ）
    const opts = vi.mocked(toast).success.mock.calls.at(-1)?.[1] as
      | { onAutoClose?: () => void }
      | undefined
    act(() => opts?.onAutoClose?.())
    expect(
      screen.getByRole("button", { name: "直前の記録（14:20）を取り消す" }),
    ).toBeInTheDocument()
    expect(screen.getByTestId("inline-undo").textContent).toContain("14:20 ミルク 120mlを記録しました")
  })

  it("対照: 応答が同じ分のうちに届けば、修正前から 14:20 のまま（分の跨ぎだけが表示を変える）", async () => {
    await quickRecordMilk(new Date("2026-10-25T05:20:59.900Z"))
    expect(timelineRows("14:20", "ミルク")).toHaveLength(1)
  })
})

describe("クイック記録したミルクを編集しても、記録時刻は利用者の意図のまま", () => {
  it("量だけを入れて更新しても、タイムラインの時刻は変わらぬ", async () => {
    await quickRecordMilk()
    answerUpdateFromDb(dbRow())
    // 時刻で絞らずに行を開く（修正前は 14:21 の行。保存の後に時刻が飛ぶことを下の assert で見る）
    const row = milkRow()
    const shownBefore = row.textContent!.match(/\d\d:\d\d/)![0]

    fireEvent.click(row)
    fireEvent.click(await screen.findByRole("button", { name: "100" }))
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalledTimes(1))
    // 時刻に触れておらぬゆえ loggedAt は送らぬ（既存の秒精度の契約）
    expect("loggedAt" in mockedUpdateLog.mock.calls[0][1]).toBe(false)

    await waitFor(() => expect(screen.queryByRole("button", { name: "更新する" })).toBeNull())
    expect(milkRow().textContent).toContain("100ml")
    expect(milkRow().textContent).toContain(shownBefore)
    expect(shownBefore).toBe("14:20")
  })

  it("編集シートの開始時刻は DB の記録時刻（14:20）で開く", async () => {
    await quickRecordMilk()
    fireEvent.click(timelineRows("14:20", "ミルク")[0])
    expect(((await screen.findByLabelText("開始時刻")) as HTMLInputElement).value).toBe("14:20")
  })

  it("記録の後に開始時刻を 14:00 へ直すと、取り消しの帯も 14:00 を指す（行と帯の時刻が食い違わぬ）", async () => {
    await quickRecordMilk()
    const opts = vi.mocked(toast).success.mock.calls.at(-1)?.[1] as
      | { onAutoClose?: () => void }
      | undefined
    act(() => opts?.onAutoClose?.())
    expect(screen.getByRole("button", { name: "直前の記録（14:20）を取り消す" })).toBeInTheDocument()

    answerUpdateFromDb(dbRow())
    fireEvent.click(milkRow())
    fireEvent.change(await screen.findByLabelText("開始時刻"), { target: { value: "14:00" } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole("button", { name: "更新する" })).toBeNull())

    expect(milkRow().textContent).toContain("14:00")
    expect(screen.getByRole("button", { name: "直前の記録（14:00）を取り消す" })).toBeInTheDocument()
    expect(screen.getByTestId("inline-undo").textContent).toContain("14:00 ミルク 120mlを記録しました")
  })

  it("記録の後に量を 100 へ直すと、取り消しの帯も 100ml を指す（行と帯の量が食い違わぬ。時刻は 14:20 のまま）", async () => {
    await quickRecordMilk()
    const opts = vi.mocked(toast).success.mock.calls.at(-1)?.[1] as
      | { onAutoClose?: () => void }
      | undefined
    act(() => opts?.onAutoClose?.())
    expect(screen.getByTestId("inline-undo").textContent).toContain("14:20 ミルク 120mlを記録しました")

    answerUpdateFromDb(dbRow())
    fireEvent.click(milkRow())
    fireEvent.click(await screen.findByRole("button", { name: "100" }))
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole("button", { name: "更新する" })).toBeNull())

    expect(milkRow().textContent).toContain("100ml")
    expect(screen.getByTestId("inline-undo").textContent).toContain("14:20 ミルク 100mlを記録しました")
  })

  it("画面に見えておる時刻を打ち直して更新すると、打った時刻のまま残る（打った時刻と違う時刻へ飛ばぬ）", async () => {
    await quickRecordMilk()
    answerUpdateFromDb(dbRow())
    // 利用者は画面の行を見て、その時刻を打ち直す（seed を確かめずに直接観測する）
    const row = milkRow()
    const shown = row.textContent!.match(/\d\d:\d\d/)![0]
    fireEvent.click(row)
    fireEvent.change(await screen.findByLabelText("開始時刻"), { target: { value: shown } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole("button", { name: "更新する" })).toBeNull())
    expect(timelineRows(shown, "ミルク")).toHaveLength(1)
  })
})
