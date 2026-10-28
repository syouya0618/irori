/**
 * クイック記録の「ミルク」といつものミルク量。
 *
 * 目的: 量を変えたあと、迷わず 1 タップで正確に記録できること。
 * - 決まっている量は釦に出し、押せばその量で記録する（送信値・楽観行・トースト・帯が同じ量）
 * - 釦の名前は「ミルク」のまま（e2e・単体テストの exact 契約）。量は aria-describedby で読み上げる
 * - 未設定なら量を決めるシートを開き、保存が通ってから記録する（勝手な既定量で記録せぬ）
 * - 読めなかった時は量の分からぬまま記録せず、取り直す。だめなら量を手で入れる記録シートへ
 * - 量の変更は次の記録から。既に記録した行の量は変わらぬ
 * - 冪等 id（量を key に含めぬ）・2 分の再試行・取り消しは従来どおり
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"
import { useState } from "react"

vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  deleteLog: vi.fn(),
  updateBottleDefault: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

import { BabyQuickActions } from "../baby-quick-actions"
import {
  recordFeeding,
  deleteLog,
  updateBottleDefault,
} from "@/app/(main)/baby/actions"
import { toast } from "sonner"
import type { BabyLogData } from "@/lib/types/baby"
import type { FeedingType } from "@/lib/types/database"
import type { BottleDefaultState } from "@/lib/domain/bottle-default"
import type { BottleDefaultController } from "@/lib/hooks/use-bottle-default"

const mockedRecordFeeding = vi.mocked(recordFeeding)
const mockedDeleteLog = vi.mocked(deleteLog)
const mockedUpdate = vi.mocked(updateBottleDefault)
const mockedToast = vi.mocked(toast)

const CREATED_VERSION = "2026-10-25T03:00:00.123456+00:00"
// reject は結果不明（2026-10-27 A2）。保存されておらぬとは言わず、同じ内容での押し直しを伝える
const OFFLINE_MESSAGE = expect.stringContaining("保存できたか確認できていません")
// いつもの量の保存（設定の書き換え）の通信断は従来の文言のまま（値の CAS で再送は吸収される）
const SETTING_OFFLINE_MESSAGE = "通信できませんでした。電波の良い場所でもう一度お試しください"

const refetchSpy = vi.fn<() => void>()
const applySpy = vi.fn<(next: BottleDefaultState) => void>()

beforeEach(() => {
  vi.clearAllMocks()
  // Once の待ち行列を次のテストへ漏らさぬ（clearAllMocks は消さぬ）
  mockedRecordFeeding.mockReset()
  mockedDeleteLog.mockReset()
  mockedUpdate.mockReset()
})
afterEach(cleanup)

/**
 * 親（ダッシュボードの useBottleDefault）の代わり。apply・refetch で実際に state を動かし、
 * 量の変更が次のタップへ届く筋を本物の再描画で確かめる。
 */
function Harness({
  initial,
  refetchResult = null,
  onCreateFeeding = () => {},
  onLogRecorded,
  onLogRemoved,
}: {
  initial: BottleDefaultState
  refetchResult?: BottleDefaultState | null
  onCreateFeeding?: (type: FeedingType) => void
  onLogRecorded?: (log: BabyLogData) => void
  onLogRemoved?: (id: string) => void
}) {
  const [state, setState] = useState<BottleDefaultState>(initial)
  const controller: BottleDefaultController = {
    state,
    refetch: async () => {
      refetchSpy()
      if (refetchResult) setState(refetchResult)
      return refetchResult
    },
    apply: (next) => {
      applySpy(next)
      setState(next)
    },
  }
  return (
    <BabyQuickActions
      userId="u1"
      onCreateLog={() => {}}
      onStartTimer={() => {}}
      onCreateFeeding={onCreateFeeding}
      onLogRecorded={onLogRecorded}
      onLogRemoved={onLogRemoved}
      bottleDefault={controller}
    />
  )
}

/** 押せるようになってから押す（React 19 の async transition の機序。memory の記録どおり） */
async function clickWhenEnabled(name: string | RegExp) {
  const button = screen.getByRole("button", { name })
  await waitFor(() => expect(button).not.toBeDisabled())
  fireEvent.click(button)
}

function milkButton() {
  return screen.getByRole("button", { name: "ミルク" })
}

function amountText() {
  return screen.getByTestId("bottle-default-amount").textContent
}

function sentInput(index: number) {
  return mockedRecordFeeding.mock.calls[index]?.[0] as {
    feedingType: string
    clientId: string
    amountMl?: number
  }
}

describe("いつもの量が決まっている時のミルク（1 タップ）", () => {
  it("釦に量を出し、名前は「ミルク」のまま、量は説明として読み上げる", () => {
    render(<Harness initial={{ status: "set", amountMl: 120 }} />)
    expect(milkButton()).toHaveAccessibleName("ミルク")
    expect(milkButton()).toHaveAccessibleDescription("押すと120mlで記録します")
    expect(amountText()).toBe("120ml")
  })

  it("1 タップで 120ml を送り、楽観行・トーストも同じ 120ml（送信値と画面を一致させる）", async () => {
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "log-1", updatedAt: CREATED_VERSION, loggedAt: CREATED_VERSION })
    const onLogRecorded = vi.fn<(log: BabyLogData) => void>()
    render(<Harness initial={{ status: "set", amountMl: 120 }} onLogRecorded={onLogRecorded} />)

    fireEvent.click(milkButton())
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(mockedRecordFeeding).toHaveBeenCalledWith({
      feedingType: "bottle",
      clientId: expect.any(String),
      // 記録時刻は送らず DB の受信時刻（2026-10-28 N3。完全一致ゆえ loggedAt が在れば落ちる）
      amountMl: 120,
    })
    expect(onLogRecorded.mock.calls[0][0]).toMatchObject({
      id: "log-1",
      feeding_type: "bottle",
      amount_ml: 120,
      updated_at: CREATED_VERSION,
      // 量（A）と記録時刻（B）の両方が DB に書かれた値と一致する（統合の契約）
      logged_at: CREATED_VERSION,
    })
    expect(mockedToast.success.mock.calls.at(-1)?.[0]).toBe("授乳を記録しました（ミルク 120ml）")
    // シートは開かぬ（1 タップ）
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it("対照: 離乳食は従来どおり量を送らぬ（送る形を変えぬ）", async () => {
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "log-s" })
    render(<Harness initial={{ status: "set", amountMl: 120 }} />)
    fireEvent.click(screen.getByRole("button", { name: "離乳食" }))
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(1))
    expect(mockedRecordFeeding).toHaveBeenCalledWith({
      feedingType: "solid",
      clientId: expect.any(String),
      // 記録時刻は送らず DB の受信時刻（2026-10-28 N3。完全一致ゆえ loggedAt が在れば落ちる）
    })
    expect(mockedToast.success.mock.calls.at(-1)?.[0]).toBe("授乳を記録しました")
  })

  it("二重タップでも記録は 1 回（処理中は全釦が押せぬ）", async () => {
    let resolve!: (v: Awaited<ReturnType<typeof recordFeeding>>) => void
    mockedRecordFeeding.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<Harness initial={{ status: "set", amountMl: 120 }} />)
    fireEvent.click(milkButton())
    fireEvent.click(milkButton())
    await waitFor(() => expect(milkButton()).toBeDisabled())
    fireEvent.click(milkButton())
    resolve({ error: null, id: "log-1", updatedAt: CREATED_VERSION, loggedAt: CREATED_VERSION })
    await waitFor(() => expect(milkButton()).not.toBeDisabled())
    expect(mockedRecordFeeding).toHaveBeenCalledTimes(1)
  })

  it("取り消しは作成時の版で消す（ミルクの記録でも従来どおり）", async () => {
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "log-u", updatedAt: CREATED_VERSION, loggedAt: CREATED_VERSION })
    mockedDeleteLog.mockResolvedValue({ error: null })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(<Harness initial={{ status: "set", amountMl: 120 }} onLogRemoved={onLogRemoved} />)
    fireEvent.click(milkButton())
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    const opts = mockedToast.success.mock.calls.at(-1)?.[1] as {
      action?: { onClick: () => void }
    }
    opts.action?.onClick()
    await waitFor(() => expect(onLogRemoved).toHaveBeenCalledWith("log-u"))
    expect(mockedDeleteLog).toHaveBeenCalledWith("log-u", CREATED_VERSION)
  })
})

describe("量の変更（120 → 160 は次の記録から。過去の記録は変わらぬ）", () => {
  it("「ミルクの量を変更」で 160 を保存すると釦が 160ml になり、次のタップは 160 を送る。先の行は 120 のまま", async () => {
    mockedRecordFeeding
      .mockResolvedValueOnce({ error: null, id: "log-120", updatedAt: CREATED_VERSION, loggedAt: CREATED_VERSION })
      .mockResolvedValueOnce({ error: null, id: "log-160", updatedAt: CREATED_VERSION, loggedAt: CREATED_VERSION })
    mockedUpdate.mockResolvedValue({ ok: true, amountMl: 160 })
    const recorded: BabyLogData[] = []
    render(
      <Harness
        initial={{ status: "set", amountMl: 120 }}
        onLogRecorded={(log) => recorded.push(log)}
      />,
    )

    fireEvent.click(milkButton())
    await waitFor(() => expect(recorded).toHaveLength(1))

    await clickWhenEnabled("ミルクの量を変更")
    const input = (await screen.findByLabelText("1回の量（ml）")) as HTMLInputElement
    expect(input.value).toBe("120")
    // 保存だけの導線（記録はせぬ）
    expect(screen.getByRole("button", { name: "保存する" })).toBeInTheDocument()
    fireEvent.change(input, { target: { value: "160" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() => expect(amountText()).toBe("160ml"))
    expect(mockedUpdate).toHaveBeenCalledWith({ amountMl: 160, expectedMl: 120 })
    expect(applySpy).toHaveBeenCalledWith({ status: "set", amountMl: 160 })
    // 量の変更そのものは記録を作らぬ
    expect(mockedRecordFeeding).toHaveBeenCalledTimes(1)
    expect(mockedToast.success).toHaveBeenLastCalledWith(
      "いつものミルク量を160mlにしました。次の記録から使います",
    )

    await clickWhenEnabled("ミルク")
    await waitFor(() => expect(recorded).toHaveLength(2))
    expect(sentInput(1).amountMl).toBe(160)
    expect(recorded[1].amount_ml).toBe(160)
    // 先に記録した行（楽観行）の量は変えぬ
    expect(recorded[0].amount_ml).toBe(120)
  })

  it("量の口は、決まっていれば「変更」、未設定なら「設定」。読めていない時は出さぬ（知らぬ量を上書きさせぬ）", () => {
    render(<Harness initial={{ status: "set", amountMl: 120 }} />)
    expect(screen.getByRole("button", { name: "ミルクの量を変更" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "ミルクの量を設定" })).toBeNull()
    cleanup()
    render(<Harness initial={{ status: "unset" }} />)
    expect(screen.getByRole("button", { name: "ミルクの量を設定" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "ミルクの量を変更" })).toBeNull()
    cleanup()
    render(<Harness initial={{ status: "error" }} />)
    expect(screen.queryByRole("button", { name: "ミルクの量を変更" })).toBeNull()
    expect(screen.queryByRole("button", { name: "ミルクの量を設定" })).toBeNull()
  })

  it("通信断の後に量を 160 へ変えて押し直すと、同じ冪等 id・別の量で送る（サーバが別内容として止め、二重記録にせぬ）", async () => {
    // サーバは同じ id の既存行（先に成立していた 120ml）を衝突として返す（actions.ts insertBabyLog）
    const stored120 = {
      id: "x",
      log_type: "feeding" as const,
      logged_at: "2026-10-27T03:00:00+00:00",
      logged_by: "u1",
      feeding_type: "bottle" as const,
      amount_ml: 120,
      updated_at: "2026-10-27T03:00:00.123456+00:00",
    } as unknown as BabyLogData
    mockedRecordFeeding
      .mockRejectedValueOnce(new Error("network down"))
      .mockImplementationOnce(async (input) => ({
        error: "この操作は少し前に別の内容で記録済みです。画面を更新して記録を確かめてください。",
        id: null,
        failure: "conflict" as const,
        conflict: { current: { ...stored120, id: input.clientId! } },
      }))
    mockedUpdate.mockResolvedValue({ ok: true, amountMl: 160 })
    const onLogRecorded = vi.fn<(log: BabyLogData) => void>()
    render(<Harness initial={{ status: "set", amountMl: 120 }} onLogRecorded={onLogRecorded} />)

    fireEvent.click(milkButton())
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))

    await clickWhenEnabled("ミルクの量を変更")
    fireEvent.change(await screen.findByLabelText("1回の量（ml）"), { target: { value: "160" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await waitFor(() => expect(amountText()).toBe("160ml"))

    await clickWhenEnabled("ミルク")
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
    expect(sentInput(1).clientId).toBe(sentInput(0).clientId)
    expect(sentInput(0).amountMl).toBe(120)
    expect(sentInput(1).amountMl).toBe(160)
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenLastCalledWith(
        expect.stringContaining("別の内容で記録済み"),
      ),
    )
    // 記録は在る（先に成立した 120ml）。160ml の架空の行は出さず、DB の確定行だけを画面へ出す
    expect(onLogRecorded).toHaveBeenCalledTimes(1)
    expect(onLogRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ id: sentInput(0).clientId, amount_ml: 120 }),
    )
  })

  it("対照: 通信断の後に同じ量で押し直すと同じ id・同じ量（応答を失った保存はサーバが replayed で吸収）", async () => {
    mockedRecordFeeding
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: null, id: "log-r", replayed: true })
    render(<Harness initial={{ status: "set", amountMl: 120 }} />)
    fireEvent.click(milkButton())
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))
    await clickWhenEnabled("ミルク")
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
    expect(sentInput(1)).toEqual(sentInput(0))
  })
})

describe("いつもの量が未設定の時のミルク（初回設定）", () => {
  it("釦は「量を設定」を出し、押すと量を決めるシートを開く。記録はせぬ", async () => {
    render(<Harness initial={{ status: "unset" }} />)
    expect(amountText()).toBe("量を設定")
    expect(milkButton()).toHaveAccessibleName("ミルク")
    expect(milkButton()).toHaveAccessibleDescription(
      "いつもの量が未設定です。押すと量を決めて記録します",
    )
    fireEvent.click(milkButton())
    expect(await screen.findByRole("button", { name: "保存して記録する" })).toBeInTheDocument()
    expect((screen.getByLabelText("1回の量（ml）") as HTMLInputElement).value).toBe("")
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
  })

  it("120 を入れて「保存して記録する」: 保存が通ってから 120ml で記録し、以後は 1 タップ", async () => {
    const order: string[] = []
    mockedUpdate.mockImplementation(async () => {
      order.push("save")
      return { ok: true, amountMl: 120 }
    })
    mockedRecordFeeding.mockImplementation(async () => {
      order.push("record")
      return { error: null, id: `log-${order.length}`, updatedAt: CREATED_VERSION, loggedAt: CREATED_VERSION }
    })
    const onLogRecorded = vi.fn<(log: BabyLogData) => void>()
    render(<Harness initial={{ status: "unset" }} onLogRecorded={onLogRecorded} />)

    fireEvent.click(milkButton())
    fireEvent.change(await screen.findByLabelText("1回の量（ml）"), { target: { value: "120" } })
    fireEvent.click(screen.getByRole("button", { name: "保存して記録する" }))

    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(order).toEqual(["save", "record"])
    expect(mockedUpdate).toHaveBeenCalledWith({ amountMl: 120, expectedMl: null })
    expect(sentInput(0)).toMatchObject({ feedingType: "bottle", amountMl: 120 })
    expect(onLogRecorded.mock.calls[0][0].amount_ml).toBe(120)
    expect(amountText()).toBe("120ml")

    // 2 回目からは 1 タップ（シートを開かぬ）
    await clickWhenEnabled("ミルク")
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
    expect(mockedUpdate).toHaveBeenCalledTimes(1)
    expect(sentInput(1).amountMl).toBe(120)
  })

  it("「ミルクの量を設定」からは量だけ決める（記録はせぬ）。以後はミルクの 1 タップ", async () => {
    mockedUpdate.mockResolvedValue({ ok: true, amountMl: 120 })
    render(<Harness initial={{ status: "unset" }} />)
    fireEvent.click(screen.getByRole("button", { name: "ミルクの量を設定" }))
    fireEvent.change(await screen.findByLabelText("1回の量（ml）"), { target: { value: "120" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await waitFor(() => expect(amountText()).toBe("120ml"))
    expect(mockedUpdate).toHaveBeenCalledWith({ amountMl: 120, expectedMl: null })
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
    expect(mockedToast.success).toHaveBeenLastCalledWith(
      "いつものミルク量を120mlにしました。次の記録から使います",
    )
  })

  it("保存の通信中に閉じたら、保存が通っても量だけ反映して記録はせぬ（取り消したつもりで記録されぬ）", async () => {
    let resolve!: (v: { ok: true; amountMl: number }) => void
    mockedUpdate.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<Harness initial={{ status: "unset" }} />)
    fireEvent.click(milkButton())
    fireEvent.change(await screen.findByLabelText("1回の量（ml）"), { target: { value: "120" } })
    fireEvent.click(screen.getByRole("button", { name: "保存して記録する" }))
    await screen.findByRole("button", { name: /保存中/ })
    // 詰まった保存の間でも閉じられる（モーダルに閉じ込めぬ）
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }))
    resolve({ ok: true, amountMl: 120 })

    await waitFor(() => expect(amountText()).toBe("120ml"))
    expect(mockedToast.success).toHaveBeenLastCalledWith(
      "いつものミルク量を120mlにしました。今回のミルクは記録していません",
    )
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
  })

  it("閉じて別のシートを開き直した後に古い保存が通っても、新しいシートは閉じず記録もせぬ", async () => {
    let resolve!: (v: { ok: true; amountMl: number }) => void
    mockedUpdate.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    render(<Harness initial={{ status: "unset" }} />)
    fireEvent.click(milkButton())
    fireEvent.change(await screen.findByLabelText("1回の量（ml）"), { target: { value: "120" } })
    fireEvent.click(screen.getByRole("button", { name: "保存して記録する" }))
    await screen.findByRole("button", { name: /保存中/ })
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }))

    // 開き直す（量だけ決める口から）
    fireEvent.click(screen.getByRole("button", { name: "ミルクの量を設定" }))
    expect(await screen.findByRole("button", { name: "保存する" })).toBeInTheDocument()

    resolve({ ok: true, amountMl: 120 })
    await waitFor(() => expect(applySpy).toHaveBeenCalledWith({ status: "set", amountMl: 120 }))
    // 新しいシートは開いたまま、記録は無し
    expect(screen.getByRole("button", { name: "保存する" })).toBeInTheDocument()
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
  })

  it("閉じたシートの保存の応答が、後で開いたシートの保存より遅れて届いても、新しい量を古い量で上書きせぬ", async () => {
    let resolveOld!: (v: { ok: true; amountMl: number }) => void
    mockedUpdate
      .mockReturnValueOnce(new Promise((r) => (resolveOld = r)))
      .mockResolvedValueOnce({ ok: true, amountMl: 140 })
    render(<Harness initial={{ status: "set", amountMl: 100 }} />)

    // シート 1: 120 を保存（応答が遅れる）→ 閉じる
    fireEvent.click(screen.getByRole("button", { name: "ミルクの量を変更" }))
    fireEvent.change(await screen.findByLabelText("1回の量（ml）"), { target: { value: "120" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await screen.findByRole("button", { name: /保存中/ })
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }))

    // シート 2: 140 を保存して反映
    fireEvent.click(screen.getByRole("button", { name: "ミルクの量を変更" }))
    await waitFor(() =>
      expect(
        (screen.getByLabelText("1回の量（ml）") as HTMLInputElement).value,
      ).toBe("100"),
    )
    fireEvent.change(screen.getByLabelText("1回の量（ml）"), { target: { value: "140" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await waitFor(() => expect(amountText()).toBe("140ml"))

    // シート 1 の応答が今ごろ届く → 捨てる（140 のまま、古い量のトーストも出さぬ）
    mockedToast.success.mockClear()
    resolveOld({ ok: true, amountMl: 120 })
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 0))
    expect(amountText()).toBe("140ml")
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("保存が衝突（家族が先に 100 を決めていた）なら何も記録せず、釦は 100ml へ揃う", async () => {
    mockedUpdate.mockResolvedValue({
      ok: false,
      error: "先に変更されていました",
      conflict: { currentMl: 100 },
    })
    render(<Harness initial={{ status: "unset" }} />)
    fireEvent.click(milkButton())
    fireEvent.change(await screen.findByLabelText("1回の量（ml）"), { target: { value: "120" } })
    fireEvent.click(screen.getByRole("button", { name: "保存して記録する" }))

    expect(await screen.findByText(/まだ何も記録していません/)).toBeInTheDocument()
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
    expect(amountText()).toBe("100ml")
  })

  it("保存がサーバに拒まれた・通信断なら何も記録せぬ", async () => {
    mockedUpdate
      .mockResolvedValueOnce({ ok: false, error: "いつものミルク量を保存できませんでした。もう一度お試しください。" })
      .mockRejectedValueOnce(new Error("network down"))
    render(<Harness initial={{ status: "unset" }} />)
    fireEvent.click(milkButton())
    fireEvent.change(await screen.findByLabelText("1回の量（ml）"), { target: { value: "120" } })
    fireEvent.click(screen.getByRole("button", { name: "保存して記録する" }))
    expect(await screen.findByText(/保存できませんでした/)).toBeInTheDocument()

    fireEvent.click(await screen.findByRole("button", { name: "保存して記録する" }))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(SETTING_OFFLINE_MESSAGE))
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
    expect(amountText()).toBe("量を設定")
  })

  it("保存は通ったが記録が通信断: 圏外トースト。量は保存済みゆえ次のミルクは 1 タップで同じ id の再試行", async () => {
    mockedUpdate.mockResolvedValue({ ok: true, amountMl: 120 })
    mockedRecordFeeding
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: null, id: "log-ok", updatedAt: CREATED_VERSION, loggedAt: CREATED_VERSION })
    render(<Harness initial={{ status: "unset" }} />)
    fireEvent.click(milkButton())
    fireEvent.change(await screen.findByLabelText("1回の量（ml）"), { target: { value: "120" } })
    fireEvent.click(screen.getByRole("button", { name: "保存して記録する" }))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))
    expect(amountText()).toBe("120ml")

    await clickWhenEnabled("ミルク")
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
    expect(sentInput(1)).toEqual(sentInput(0))
    expect(mockedUpdate).toHaveBeenCalledTimes(1)
  })
})

describe("いつもの量を読めなかった時のミルク（未設定とは区別する）", () => {
  it("釦は「量を再読込」。押すと取り直し、だめなら量を手で入れる記録シートへ。量の分からぬまま記録せぬ", async () => {
    const onCreateFeeding = vi.fn<(type: FeedingType) => void>()
    render(<Harness initial={{ status: "error" }} onCreateFeeding={onCreateFeeding} />)
    expect(amountText()).toBe("量を再読込")
    expect(milkButton()).toHaveAccessibleDescription(
      "いつもの量を読み込めていません。押すと読み込み直します",
    )
    fireEvent.click(milkButton())
    await waitFor(() => expect(onCreateFeeding).toHaveBeenCalledWith("bottle"))
    expect(refetchSpy).toHaveBeenCalledTimes(1)
    expect(mockedToast.error).toHaveBeenCalledWith(
      "いつものミルク量を読み込めませんでした。量を入力して記録してください",
    )
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
    // 未設定のシート（量を決める導線）は開かぬ — 決めてある量を上書きさせぬ
    expect(screen.queryByRole("button", { name: "保存して記録する" })).toBeNull()
  })

  it("取り直して 140ml と分かったら釦に出すが、見せる前に記録はせぬ（もう一度押してもらう）", async () => {
    render(
      <Harness initial={{ status: "error" }} refetchResult={{ status: "set", amountMl: 140 }} />,
    )
    fireEvent.click(milkButton())
    await waitFor(() => expect(amountText()).toBe("140ml"))
    expect(mockedToast.info).toHaveBeenCalledWith(
      "いつものミルク量（140ml）を読み込みました。もう一度押すと記録します",
    )
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
  })

  it("取り直して未設定と分かったら、量を決めるシートを開く", async () => {
    render(<Harness initial={{ status: "error" }} refetchResult={{ status: "unset" }} />)
    fireEvent.click(milkButton())
    expect(await screen.findByRole("button", { name: "保存して記録する" })).toBeInTheDocument()
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
  })
})
