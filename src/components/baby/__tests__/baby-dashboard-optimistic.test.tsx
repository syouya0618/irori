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
import { todayJstString, formatTimeJst, shiftYmd } from "@/lib/utils/date-jst"
import { recordDiaper, deleteLog, updateLog } from "@/app/(main)/baby/actions"
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
  const base = buildInlineReducerSupabaseMock(viMod, mockState, {
    throwMessage:
      "supabase.from() should not be called in this test " +
      "(selectedDate must not change to trigger the date-change useEffect)",
  })
  // マウント時の再取得（P1-04）は session を確かめてから問い合わせる。本ファイルは
  // 楽観更新の検証ゆえ、getSession を解決させずに再取得を保留のまま止める
  // （再取得との合流は baby-dashboard-resync.test.tsx が持つ）。
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

// vi.mock 後 import
import { BabyDashboard } from "../baby-dashboard"

const mockedRecordDiaper = vi.mocked(recordDiaper)
const mockedDeleteLog = vi.mocked(deleteLog)
const mockedUpdateLog = vi.mocked(updateLog)
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
    breast_start_side: null,
    diaper_type: null,
    poop_amount: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: null,
    created_at: `${TODAY}T00:00:00+09:00`,
    // DB の行は必ず版を持つ（編集の保存はこの版を送る。P2-07）。下の v1 / v2 より古い
    updated_at: "2026-10-01T03:00:00.000Z",
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
    lastNursingFallback: null,
    babyName: null,
    babyBirthDate: null,
    feedingIntervalMin: 180,
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
  // clearAllMocks は mockResolvedValueOnce の待ち行列を消さぬ。途中で落ちたテストの
  // 未消費の応答が次のテストへ漏れ、無関係の失敗を連鎖させぬよう個別に戻す
  mockedRecordDiaper.mockReset()
  mockedDeleteLog.mockReset()
  mockedUpdateLog.mockReset()
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
    // 取り消しは作成に成功した時の版でしか消せぬ（版の無い応答には「取り消す」を出さぬ）
    const createdVersion = "2026-10-21T03:00:00.123456+00:00"
    mockedRecordDiaper.mockResolvedValue({
      error: null,
      id: "diaper-opt-2",
      updatedAt: createdVersion,
    })
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
      expect(mockedDeleteLog).toHaveBeenCalledWith("diaper-opt-2", createdVersion),
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

describe("BabyDashboard / シートの再マウント key", () => {
  // 日記シートと記録シートはどちらも 0 から数える数値 key を持つ兄弟ゆえ、素の数値だと
  // 初期状態から重複 key になる（React が fiber を取り違えうる）。名前空間で分ける。
  it("初期描画で重複 key の警告を出さぬ", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    render(<BabyDashboard {...defaultProps()} />)
    const duplicateKey = error.mock.calls.some((args) =>
      String(args[0]).includes("two children with the same key"),
    )
    error.mockRestore()
    expect(duplicateKey).toBe(false)
  })
})

/**
 * 編集（updateLog）の楽観反映。作成・削除は B-03 で Realtime 非依存にしたが、編集だけが
 * Realtime UPDATE の到達に依存しておった — 不達の間は「ログを更新しました」と出るのに
 * 時刻が旧値のまま、開き直しても旧時刻で seed され「時刻が編集できぬ」に見えた。
 *
 * 時刻は「今日 00:20 → 00:01」へ動かす。00:01 は今日のどの時点でも +5 分許容の
 * 未来判定に掛からぬ（実時刻で走らせても揺れぬ）。
 */
describe("BabyDashboard / 編集の楽観反映", () => {
  const OLD_AT = `${TODAY}T00:20:00+09:00`
  const NEW_AT = new Date(`${TODAY}T00:01:00+09:00`).toISOString()

  const original = makeLog({
    id: "diaper-edit",
    log_type: "diaper",
    logged_at: OLD_AT,
    diaper_type: "pee",
  })

  /**
   * タイムライン行（記録時刻を末尾に持つボタン）を時刻表記で引く。シートが開いて
   * おる間は base-ui が背面を aria-hidden にするゆえ hidden も含めて探す。
   */
  function rowsWithTime(time: string): HTMLElement[] {
    return screen
      .getAllByRole("button", { hidden: true })
      .filter((b) => b.textContent?.includes(time))
  }

  function timelineRow(time: string): HTMLElement {
    const row = rowsWithTime(time)[0]
    if (!row) throw new Error(`timeline row ${time} not found`)
    return row
  }

  async function editTimeTo(hm: string) {
    fireEvent.click(timelineRow(formatTimeJst(OLD_AT)))
    fireEvent.change(await screen.findByLabelText("時刻"), {
      target: { value: hm },
    })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
  }

  it("Realtime を発火させずに時刻編集が解決すると、タイムラインの時刻が新値になる", async () => {
    mockedUpdateLog.mockResolvedValue({
      error: null,
      log: { ...original, logged_at: NEW_AT },
    })
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await editTimeTo("00:01")

    // シートが閉じ、タイムラインの行が新しい時刻へ置き換わる（旧時刻は残らぬ）
    await waitFor(() =>
      expect(
        screen.queryByText(formatTimeJst(OLD_AT)),
      ).not.toBeInTheDocument(),
    )
    expect(timelineRow(formatTimeJst(NEW_AT))).toBeInTheDocument()
  })

  it("編集後に同じ行を開き直すと、新しい時刻で seed される", async () => {
    mockedUpdateLog.mockResolvedValue({
      error: null,
      log: { ...original, logged_at: NEW_AT },
    })
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await editTimeTo("00:01")
    await waitFor(() =>
      expect(
        screen.queryByText(formatTimeJst(OLD_AT)),
      ).not.toBeInTheDocument(),
    )

    fireEvent.click(timelineRow(formatTimeJst(NEW_AT)))
    expect(
      ((await screen.findByLabelText("時刻")) as HTMLInputElement).value,
    ).toBe("00:01")
  })

  it("同 id の Realtime UPDATE echo が後から来ても行は 1 つのまま（冪等）", async () => {
    const updated = { ...original, logged_at: NEW_AT }
    mockedUpdateLog.mockResolvedValue({ error: null, log: updated })
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await editTimeTo("00:01")
    await waitFor(() =>
      expect(
        screen.queryByText(formatTimeJst(OLD_AT)),
      ).not.toBeInTheDocument(),
    )

    act(() => {
      emit(makePayload("UPDATE", updated))
    })

    expect(rowsWithTime(formatTimeJst(NEW_AT))).toHaveLength(1)
  })

  // 応答と echo の到着順は保証されぬ。別端末 B が同じ行を後から編集した場合、B の echo
  // （新しい版）が先に届き、自分の古い応答が後から着きうる。版（updated_at）で比べねば、
  // DB は B の値なのに画面は自分の古い値で固まる（以後この行の echo は来ない）。
  it("新しい版の echo の後に古い版の応答が着いても、新しい版が残る", async () => {
    const V1_AT = new Date(`${TODAY}T00:01:00+09:00`).toISOString()
    const V2_AT = new Date(`${TODAY}T00:02:00+09:00`).toISOString()
    const v1 = {
      ...original,
      logged_at: V1_AT,
      updated_at: "2026-10-01T03:00:01.000Z",
    }
    const v2 = {
      ...original,
      logged_at: V2_AT,
      updated_at: "2026-10-01T03:00:02.000Z",
    }
    let resolveUpdate: (v: Awaited<ReturnType<typeof updateLog>>) => void = () => {}
    mockedUpdateLog.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve
      }),
    )
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await editTimeTo("00:01")
    // 応答より先に、別端末の新しい版の echo が届く
    act(() => {
      emit(makePayload("UPDATE", v2))
    })
    // その後に自分の古い版の応答が着く
    await act(async () => {
      resolveUpdate({ error: null, log: v1 })
    })

    await waitFor(() =>
      expect(rowsWithTime(formatTimeJst(V2_AT))).toHaveLength(1),
    )
    expect(rowsWithTime(formatTimeJst(V1_AT))).toHaveLength(0)
  })

  it("古い版の echo の後に新しい版の応答が着けば、新しい版になる（対照）", async () => {
    const V1_AT = new Date(`${TODAY}T00:01:00+09:00`).toISOString()
    const V2_AT = new Date(`${TODAY}T00:02:00+09:00`).toISOString()
    const v1 = {
      ...original,
      logged_at: V1_AT,
      updated_at: "2026-10-01T03:00:01.000Z",
    }
    const v2 = {
      ...original,
      logged_at: V2_AT,
      updated_at: "2026-10-01T03:00:02.000Z",
    }
    let resolveUpdate: (v: Awaited<ReturnType<typeof updateLog>>) => void = () => {}
    mockedUpdateLog.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve
      }),
    )
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await editTimeTo("00:02")
    act(() => {
      emit(makePayload("UPDATE", v1))
    })
    await act(async () => {
      resolveUpdate({ error: null, log: v2 })
    })

    await waitFor(() =>
      expect(rowsWithTime(formatTimeJst(V2_AT))).toHaveLength(1),
    )
    expect(rowsWithTime(formatTimeJst(V1_AT))).toHaveLength(0)
  })

  it("新しい版が行を別日へ動かして除去した後に、古い版の応答が着いても復活させぬ", async () => {
    const YESTERDAY_AT = `${shiftYmd(TODAY, -1)}T00:30:00+09:00`
    const V1_AT = new Date(`${TODAY}T00:01:00+09:00`).toISOString()
    const v1 = { ...original, logged_at: V1_AT, updated_at: "2026-10-01T03:00:01.000Z" }
    const v2 = { ...original, logged_at: YESTERDAY_AT, updated_at: "2026-10-01T03:00:02.000Z" }
    let resolveUpdate: (v: Awaited<ReturnType<typeof updateLog>>) => void = () => {}
    mockedUpdateLog.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve
      }),
    )
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await editTimeTo("00:01")
    // 別端末が同じ行を昨日へ動かした echo が先に届く → 今日のタイムラインから外れる
    act(() => {
      emit(makePayload("UPDATE", v2))
    })
    await waitFor(() =>
      expect(rowsWithTime(formatTimeJst(OLD_AT))).toHaveLength(0),
    )
    // 自分の古い版の応答が後から着いても、今日のタイムラインへ戻さぬ
    await act(async () => {
      resolveUpdate({ error: null, log: v1 })
    })
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    expect(rowsWithTime(formatTimeJst(V1_AT))).toHaveLength(0)
  })

  it("古い版の echo が別日を指して届いても、新しい版の行を消さぬ", async () => {
    const V2_AT = new Date(`${TODAY}T00:02:00+09:00`).toISOString()
    const v2 = { ...original, logged_at: V2_AT, updated_at: "2026-10-01T03:00:02.000Z" }
    const staleOtherDay = {
      ...original,
      logged_at: "2020-01-01T09:00:00+09:00",
      updated_at: "2026-10-01T03:00:01.000Z",
    }
    mockedUpdateLog.mockResolvedValue({ error: null, log: v2 })
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await editTimeTo("00:02")
    await waitFor(() =>
      expect(rowsWithTime(formatTimeJst(V2_AT))).toHaveLength(1),
    )

    act(() => {
      emit(makePayload("UPDATE", staleOtherDay))
    })
    expect(rowsWithTime(formatTimeJst(V2_AT))).toHaveLength(1)
  })

  it("更新が失敗したら画面の行は書き換えぬ（対照）", async () => {
    mockedUpdateLog.mockResolvedValue({ error: "ログの更新に失敗しました。" })
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await editTimeTo("00:01")

    expect(timelineRow(formatTimeJst(OLD_AT))).toBeInTheDocument()
    expect(rowsWithTime(formatTimeJst(NEW_AT))).toHaveLength(0)
  })
})

/**
 * 編集の衝突（P2-07）。A（家族・自分の別端末）と B が同じ記録を開き、A が先に保存した後で
 * B が開いた時点の版のまま保存した場面を、B の画面で固定する。サーバの判定（版で絞った
 * 1 本の UPDATE が 0 行 → 読み直し）は actions.test.ts と pgTAP が持つ。ここはその応答を
 * 受けた画面が「入力を捨てず・成功と言わず・最新へ揃え・編集し直せる」ことを見る。
 */
describe("BabyDashboard / 編集の衝突（P2-07）", () => {
  const OPENED_AT = `${TODAY}T00:20:00+09:00`
  const V0 = "2026-10-01T03:00:00.000Z"
  const V1 = "2026-10-01T03:00:05.123456+00:00"
  const original = makeLog({
    id: "conflict-log",
    log_type: "diaper",
    logged_at: OPENED_AT,
    diaper_type: "pee",
    updated_at: V0,
  })
  // A が先に保存した後の行（版は V1 へ進んでおる）
  const savedByA: BabyLogData = {
    ...original,
    diaper_type: "poop",
    poop_amount: "large",
    memo: "Aが直したメモ",
    updated_at: V1,
  }

  function buttonsWithText(text: string): HTMLElement[] {
    return screen
      .getAllByRole("button", { hidden: true })
      .filter((b) => b.textContent?.includes(text))
  }

  async function openAndTypeMemo(memo: string) {
    fireEvent.click(buttonsWithText(formatTimeJst(OPENED_AT))[0])
    fireEvent.change(await screen.findByLabelText("メモ"), {
      target: { value: memo },
    })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
  }

  /**
   * 保存の transition が閉じるのを待つ。衝突の反映（setConflict 等）は await の後ゆえ
   * transition の外の通常の更新として先に描かれ、isPending は遅れて解ける（日記シートの
   * 衝突テストと同じ）。通知が出た直後に同期で引くと、負荷しだいで「更新中...」のままの
   * 画面を掴む（CI と負荷下のローカルで観測）。送信ボタンの名前が「更新する」へ戻った
   * ことで isPending の解除を直接見る — 以後の disabled は衝突だけに由来する。
   */
  function saveSettled(): Promise<HTMLElement> {
    return screen.findByRole("button", { name: "更新する" })
  }

  it("単独の編集は開いた時点の版を送り、従来どおり保存して閉じる（対照）", async () => {
    mockedUpdateLog.mockResolvedValue({
      error: null,
      log: { ...original, memo: "Bのメモ", updated_at: V1 },
    })
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await openAndTypeMemo("Bのメモ")

    expect(mockedUpdateLog).toHaveBeenCalledWith(
      "conflict-log",
      expect.objectContaining({ memo: "Bのメモ" }),
      V0,
    )
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith("ログを更新しました"),
    )
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("古い版の保存が衝突したら、入力を残し・成功と言わず・背後を A の内容へ揃え・保存と削除を止める", async () => {
    mockedUpdateLog.mockResolvedValue({
      error: "この記録は別の端末で先に更新されていました（家族またはご自身）。",
      conflict: { current: savedByA },
    })
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await openAndTypeMemo("Bのメモ")

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("別の端末で先に更新されていました")
    // 先に保存された内容（A の内容）を見せる
    expect(alert).toHaveTextContent("うんち（大量）")
    expect(alert).toHaveTextContent("Aが直したメモ")
    // B の未保存の入力は残る
    expect((screen.getByLabelText("メモ") as HTMLTextAreaElement).value).toBe("Bのメモ")
    // 成功とは言わぬ・閉じぬ。通知の枠がスクロールの外でも理由が見えるようトーストでも示す
    expect(mockedToast.success).not.toHaveBeenCalled()
    expect(mockedToast.error).toHaveBeenCalledWith(
      "この記録は別の端末で先に更新されていました（家族またはご自身）。",
    )
    // 同じ版での再送も、版を見ぬ削除も止める（家族の変更を巻き戻さぬ）。送信中ゆえの
    // disabled と取り違えぬよう、transition の完了後に見る
    expect(await saveSettled()).toBeDisabled()
    expect(screen.getByRole("button", { name: "この記録を削除" })).toBeDisabled()
    // 背後のタイムラインは A の内容へ揃う（B の画面に古い行を残さぬ）
    await waitFor(() =>
      expect(
        buttonsWithText("うんち（大量）").some(
          (b) => !alert.contains(b) && b.textContent?.includes(formatTimeJst(OPENED_AT)),
        ),
      ).toBe(true),
    )
  })

  it("「最新の内容で編集し直す」で A の内容と版から開き直り、再編集は新しい版で保存できる", async () => {
    mockedUpdateLog
      .mockResolvedValueOnce({
        error: "この記録は別の端末で先に更新されていました（家族またはご自身）。",
        conflict: { current: savedByA },
      })
      .mockResolvedValueOnce({
        error: null,
        log: { ...savedByA, memo: "Aの後にBが足したメモ", updated_at: "2026-10-01T03:00:09.000000+00:00" },
      })
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await openAndTypeMemo("Bのメモ")
    await screen.findByRole("alert")
    // 送信中は「編集し直す」も押せぬ（disabled への click は無視される）。transition の
    // 完了を待ち、押せることを確かめてから押す
    await saveSettled()
    const reload = screen.getByRole("button", { name: "最新の内容で編集し直す" })
    expect(reload).toBeEnabled()
    fireEvent.click(reload)

    // A の内容で seed し直される（衝突の表示は消え、保存できる）
    await waitFor(() =>
      expect((screen.getByLabelText("メモ") as HTMLTextAreaElement).value).toBe(
        "Aが直したメモ",
      ),
    )
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("メモ"), {
      target: { value: "Aの後にBが足したメモ" },
    })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalledTimes(2))
    // 再編集は A の版（V1）で送る = A の変更（うんち・大量）を巻き戻さぬ
    expect(mockedUpdateLog).toHaveBeenLastCalledWith(
      "conflict-log",
      expect.objectContaining({
        diaperType: "poop",
        poopAmount: "large",
        memo: "Aの後にBが足したメモ",
      }),
      V1,
    )
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith("ログを更新しました"),
    )
  })

  it("削除の確認を開いたまま保存して衝突したら、確認を閉じて古い画面からの削除をさせぬ", async () => {
    mockedUpdateLog.mockResolvedValue({
      error: "この記録は別の端末で先に更新されていました（家族またはご自身）。",
      conflict: { current: savedByA },
    })
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    fireEvent.click(buttonsWithText(formatTimeJst(OPENED_AT))[0])
    fireEvent.click(await screen.findByRole("button", { name: "この記録を削除" }))
    expect(screen.getByRole("button", { name: "削除する" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    // 保存は開いた時点の版で 1 回だけ送られる
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalledTimes(1))
    expect(mockedUpdateLog).toHaveBeenCalledWith("conflict-log", expect.any(Object), V0)
    // 応答の処理（成否どちらでもトーストが出る）を待ち、成功して閉じたのではなく衝突として
    // 返ったことを見る
    await waitFor(() =>
      expect(
        mockedToast.success.mock.calls.length + mockedToast.error.mock.calls.length,
      ).toBeGreaterThan(0),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
    await screen.findByRole("alert")
    expect(await saveSettled()).toBeDisabled()
    expect(screen.getByRole("dialog", { name: "おむつを編集" })).toBeInTheDocument()
    // 確認は閉じ、削除の入口も止まる
    expect(screen.queryByRole("button", { name: "削除する" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "この記録を削除" })).toBeDisabled()
    expect(mockedDeleteLog).not.toHaveBeenCalled()
  })

  it("他端末で削除済みなら、行を画面から外し、入力は残し、保存できぬ", async () => {
    mockedUpdateLog.mockResolvedValue({
      error: "この記録は他の端末で削除されていました。",
      conflict: { current: null },
    })
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await openAndTypeMemo("Bのメモ")

    expect(await screen.findByRole("alert")).toHaveTextContent("削除されていました")
    expect((screen.getByLabelText("メモ") as HTMLTextAreaElement).value).toBe("Bのメモ")
    expect(await saveSettled()).toBeDisabled()
    expect(
      screen.queryByRole("button", { name: "最新の内容で編集し直す" }),
    ).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        buttonsWithText(formatTimeJst(OPENED_AT)).filter(
          (b) => b.textContent?.includes("おしっこ"),
        ),
      ).toHaveLength(0),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("衝突と断定できぬ失敗（読み直しの失敗）は成功と表示せず、閉じずに再試行できる（0 行を成功にせぬ）", async () => {
    mockedUpdateLog.mockResolvedValue({
      error: "記録を更新できたか確かめられませんでした。画面を更新して記録を確かめてください。",
    })
    render(<BabyDashboard {...defaultProps({ initialLogs: [original] })} />)

    await openAndTypeMemo("Bのメモ")

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(
        "記録を更新できたか確かめられませんでした。画面を更新して記録を確かめてください。",
      ),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
    expect((screen.getByLabelText("メモ") as HTMLTextAreaElement).value).toBe("Bのメモ")
    expect(await saveSettled()).toBeEnabled()
  })
})

describe("BabyDashboard / 取り消しと Realtime 通知の競合", () => {
  const createdVersion = "2026-10-21T03:00:00.123456+00:00"

  // 帯はトーストが閉じた後に出る。実物の sonner と同じく、出したトーストは自動で閉じる
  beforeEach(() => {
    mockedToast.success.mockImplementation(((
      _message: unknown,
      opts?: { onAutoClose?: () => void },
    ) => {
      setTimeout(() => act(() => opts?.onAutoClose?.()), 0)
      return 1
    }) as never)
  })
  afterEach(() => {
    mockedToast.success.mockReset()
  })

  async function recordPeeThenUndoInline(id: string) {
    mockedRecordDiaper.mockResolvedValue({ error: null, id, updatedAt: createdVersion })
    mockedDeleteLog.mockResolvedValue({ error: null })
    render(<BabyDashboard {...defaultProps()} />)
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    const undo = await screen.findByRole("button", { name: /^直前の記録（\d\d:\d\d）を取り消す$/ })
    await waitFor(() => expect(undo).not.toBeDisabled())
    fireEvent.click(undo)
    await waitFor(() => expect(mockedDeleteLog).toHaveBeenCalledWith(id, createdVersion))
    await waitFor(() =>
      expect(within(summary()).getByText("おしっこ0・うんち0")).toBeInTheDocument(),
    )
  }

  it("取り消しに成功した後で同じ行の INSERT 通知が遅れて届いても、行を蘇らせぬ", async () => {
    await recordPeeThenUndoInline("diaper-late-insert")
    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "diaper-late-insert",
            log_type: "diaper",
            logged_at: new Date().toISOString(),
            diaper_type: "pee",
            updated_at: createdVersion,
          }),
        ),
      )
    })
    expect(within(summary()).getByText("おしっこ0・うんち0")).toBeInTheDocument()
    expect(screen.getByText("まだ記録がありません")).toBeInTheDocument()
    // 消えた行の取り消しの帯も戻らぬ
    expect(screen.queryByRole("button", { name: /^直前の記録/ })).toBeNull()
  })

  it("取り消しに成功した後で同じ行の古い UPDATE 通知が届いても、行を蘇らせぬ", async () => {
    await recordPeeThenUndoInline("diaper-late-update")
    act(() => {
      emit(
        makePayload(
          "UPDATE",
          makeLog({
            id: "diaper-late-update",
            log_type: "diaper",
            logged_at: new Date().toISOString(),
            diaper_type: "pee",
            updated_at: createdVersion,
          }),
        ),
      )
    })
    expect(within(summary()).getByText("おしっこ0・うんち0")).toBeInTheDocument()
  })

  it("消した後に同じ id で作り直された行（冪等 id の再試行）は、以後の更新通知を弾かぬ", async () => {
    await recordPeeThenUndoInline("diaper-recreated")
    // 同じ冪等 id での再試行がサーバで新しい行として作られた（作成の応答が届く）
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() =>
      expect(within(summary()).getByText("おしっこ1・うんち0")).toBeInTheDocument(),
    )
    // 家族が種類を直した UPDATE 通知は、作り直された行へ届く
    act(() => {
      emit(
        makePayload(
          "UPDATE",
          makeLog({
            id: "diaper-recreated",
            log_type: "diaper",
            logged_at: new Date().toISOString(),
            diaper_type: "poop",
            updated_at: "2099-01-01T00:00:00.000000+00:00",
          }),
        ),
      )
    })
    expect(within(summary()).getByText("おしっこ0・うんち1")).toBeInTheDocument()
  })

  it("対照: 別の id の INSERT 通知は従来どおり入る（消した行だけを弾く）", async () => {
    await recordPeeThenUndoInline("diaper-removed")
    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeLog({
            id: "diaper-other",
            log_type: "diaper",
            logged_at: new Date().toISOString(),
            diaper_type: "pee",
          }),
        ),
      )
    })
    expect(within(summary()).getByText("おしっこ1・うんち0")).toBeInTheDocument()
  })
})
