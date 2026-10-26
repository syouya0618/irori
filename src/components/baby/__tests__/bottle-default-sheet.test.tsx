/**
 * いつものミルク量のシート（BottleDefaultSheet）。
 *
 * - 量の入力は Base UI Number Field（増減ボタン・数値入力）。増減は 10ml 刻み
 * - 範囲外・小数は丸めずに止める（1000 と打った量が黙って 999 で保存されぬ）。検証は送る直前に
 *   domain の isBottleDefaultMl で行い、DB CHECK・サーバと同じ 1〜999 の整数
 * - 保存は「開いた時に見ていた量」を expectedMl として送る。衝突したら入力を残して今の量を見せ、
 *   次の保存は今の量を見たうえでの変更として送る
 * - 失敗（サーバの拒否・通信断）ではシートを閉じず、保存したことにもせぬ
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"

vi.mock("@/app/(main)/baby/actions", () => ({ updateBottleDefault: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { BottleDefaultSheet, type BottleDefaultSheetIntent } from "../bottle-default-sheet"
import { updateBottleDefault } from "@/app/(main)/baby/actions"
import { toast } from "sonner"
import { BOTTLE_DEFAULT_RANGE_ERROR } from "@/lib/domain/bottle-default"

const mockedUpdate = vi.mocked(updateBottleDefault)
const mockedToast = vi.mocked(toast)
const OFFLINE_MESSAGE = "通信できませんでした。電波の良い場所でもう一度お試しください"

beforeEach(() => {
  mockedUpdate.mockReset()
  mockedToast.error.mockReset()
})
afterEach(cleanup)

function renderSheet(
  opts: {
    intent?: BottleDefaultSheetIntent
    initialAmountMl?: number | null
  } = {},
) {
  const onSaved = vi.fn()
  const onConflict = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <BottleDefaultSheet
      open
      onOpenChange={onOpenChange}
      intent={opts.intent ?? "save"}
      initialAmountMl={opts.initialAmountMl === undefined ? 120 : opts.initialAmountMl}
      onSaved={onSaved}
      onConflict={onConflict}
    />,
  )
  return { onSaved, onConflict, onOpenChange }
}

function amountInput(): HTMLInputElement {
  return screen.getByLabelText("1回の量（ml）") as HTMLInputElement
}

function typeAmount(text: string) {
  fireEvent.change(amountInput(), { target: { value: text } })
}

describe("BottleDefaultSheet の入力（Base UI Number Field）", () => {
  it("開いた時の量が入り、ラベル・増減ボタンは日本語の名前を持つ", () => {
    renderSheet({ initialAmountMl: 120 })
    expect(amountInput().value).toBe("120")
    expect(screen.getByRole("button", { name: "10ml増やす" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "10ml減らす" })).toBeInTheDocument()
  })

  it("増減ボタンは 10ml ずつ動かす", async () => {
    renderSheet({ initialAmountMl: 120 })
    fireEvent.click(screen.getByRole("button", { name: "10ml増やす" }))
    fireEvent.click(screen.getByRole("button", { name: "10ml増やす" }))
    await waitFor(() => expect(amountInput().value).toBe("140"))
    fireEvent.click(screen.getByRole("button", { name: "10ml減らす" }))
    await waitFor(() => expect(amountInput().value).toBe("130"))
  })

  it("未設定で開くと空欄（勝手な既定量を入れぬ）", () => {
    renderSheet({ initialAmountMl: null, intent: "record" })
    expect(amountInput().value).toBe("")
  })

  it("空欄から「増やす」は 10ml から数える（1, 11, 21… の半端な量にせぬ）", async () => {
    renderSheet({ initialAmountMl: null, intent: "record" })
    fireEvent.click(screen.getByRole("button", { name: "10ml増やす" }))
    await waitFor(() => expect(amountInput().value).toBe("10"))
    fireEvent.click(screen.getByRole("button", { name: "10ml増やす" }))
    await waitFor(() => expect(amountInput().value).toBe("20"))
  })
})

describe("BottleDefaultSheet の検証（DB CHECK と同じ 1〜999 の整数）", () => {
  it("空のまま保存すると止め、サーバへ送らぬ", async () => {
    const { onSaved } = renderSheet({ initialAmountMl: null, intent: "record" })
    fireEvent.click(screen.getByRole("button", { name: "保存して記録する" }))
    expect(await screen.findByText(BOTTLE_DEFAULT_RANGE_ERROR)).toBeInTheDocument()
    expect(amountInput()).toHaveAttribute("aria-invalid", "true")
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it.each(["1000", "0", "-5", "120.5"])(
    "%s は丸めず止める（打った量と保存する量を食い違わせぬ）",
    async (text) => {
      renderSheet({ initialAmountMl: 120 })
      typeAmount(text)
      fireEvent.blur(amountInput())
      fireEvent.click(screen.getByRole("button", { name: "保存する" }))
      expect(await screen.findByText(BOTTLE_DEFAULT_RANGE_ERROR)).toBeInTheDocument()
      expect(mockedUpdate).not.toHaveBeenCalled()
    },
  )

  it("対照: 境界の 1 と 999 は送る", async () => {
    mockedUpdate.mockResolvedValue({ ok: true, amountMl: 999 })
    renderSheet({ initialAmountMl: 120 })
    typeAmount("999")
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({ amountMl: 999, expectedMl: 120 }),
    )
    cleanup()
    mockedUpdate.mockReset()
    mockedUpdate.mockResolvedValue({ ok: true, amountMl: 1 })
    renderSheet({ initialAmountMl: 120 })
    typeAmount("1")
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({ amountMl: 1, expectedMl: 120 }),
    )
  })
})

describe("BottleDefaultSheet の保存", () => {
  it("120 → 160: 見ていた 120 を添えて送り、保存できた量と導線を親へ渡す", async () => {
    mockedUpdate.mockResolvedValue({ ok: true, amountMl: 160 })
    const { onSaved, onConflict } = renderSheet({ initialAmountMl: 120 })
    typeAmount("160")
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(160, "save"))
    expect(mockedUpdate).toHaveBeenCalledWith({ amountMl: 160, expectedMl: 120 })
    expect(onConflict).not.toHaveBeenCalled()
  })

  it("未設定のミルクから開いた時は「保存して記録する」で、未設定（null）を見ていたと送る", async () => {
    mockedUpdate.mockResolvedValue({ ok: true, amountMl: 120 })
    const { onSaved } = renderSheet({ initialAmountMl: null, intent: "record" })
    typeAmount("120")
    fireEvent.click(screen.getByRole("button", { name: "保存して記録する" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(120, "record"))
    expect(mockedUpdate).toHaveBeenCalledWith({ amountMl: 120, expectedMl: null })
  })

  it("保存中は「保存中...」で押せず、二度押しでも 1 回しか送らぬ", async () => {
    let resolve!: (v: { ok: true; amountMl: number }) => void
    mockedUpdate.mockReturnValue(new Promise((r) => (resolve = r)))
    const { onSaved } = renderSheet({ initialAmountMl: 120 })
    typeAmount("160")
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    const pending = await screen.findByRole("button", { name: /保存中/ })
    expect(pending).toBeDisabled()
    fireEvent.click(pending)
    fireEvent.submit(pending.closest("form")!)
    resolve({ ok: true, amountMl: 160 })
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(mockedUpdate).toHaveBeenCalledTimes(1)
  })

  it("保存中でも × で閉じる要求を親へ渡す（詰まった保存の間、モーダルに画面ごと閉じ込めぬ）", async () => {
    let resolve!: (v: { ok: true; amountMl: number }) => void
    mockedUpdate.mockReturnValue(new Promise((r) => (resolve = r)))
    const { onSaved, onOpenChange } = renderSheet({ initialAmountMl: null, intent: "record" })
    typeAmount("120")
    fireEvent.click(screen.getByRole("button", { name: "保存して記録する" }))
    await screen.findByRole("button", { name: /保存中/ })
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }))
    expect(onOpenChange.mock.calls.at(-1)?.[0]).toBe(false)
    // 保存そのものは走り続け、結果は親へ渡る（記録するかは親が閉じたことを見て決める）
    resolve({ ok: true, amountMl: 120 })
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(120, "record"))
  })

  it("保存中でなければ、もちろん × で閉じる要求を親へ渡す", async () => {
    const { onOpenChange } = renderSheet({ initialAmountMl: 120 })
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }))
    await waitFor(() => expect(onOpenChange.mock.calls.at(-1)?.[0]).toBe(false))
  })

  it("Enter（フォームの送信）でも保存できる", async () => {
    mockedUpdate.mockResolvedValue({ ok: true, amountMl: 140 })
    const { onSaved } = renderSheet({ initialAmountMl: 120 })
    typeAmount("140")
    fireEvent.submit(amountInput().closest("form")!)
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(140, "save"))
  })
})

describe("BottleDefaultSheet の衝突と失敗", () => {
  it("家族が先に 140 へ変えていた: 上書きせず今の量を見せ、入力は残し、次は 140 を見たうえで送る", async () => {
    mockedUpdate
      .mockResolvedValueOnce({
        ok: false,
        error: "先に変更されていました",
        conflict: { currentMl: 140 },
      })
      .mockResolvedValueOnce({ ok: true, amountMl: 160 })
    const { onSaved, onConflict } = renderSheet({ initialAmountMl: 120 })
    typeAmount("160")
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    expect(await screen.findByText(/先に140mlへ変更されていました/)).toBeInTheDocument()
    expect(onConflict).toHaveBeenCalledWith(140)
    expect(onSaved).not.toHaveBeenCalled()
    expect(amountInput().value).toBe("160")

    // 衝突の表示は pending が解けた後の「保存する」を待ってから押す（React 19 の transition の機序）
    fireEvent.click(await screen.findByRole("button", { name: "保存する" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(160, "save"))
    expect(mockedUpdate).toHaveBeenLastCalledWith({ amountMl: 160, expectedMl: 140 })
  })

  it("初回の保存と記録の途中で衝突したら、まだ何も記録していないと伝える", async () => {
    mockedUpdate.mockResolvedValue({
      ok: false,
      error: "先に変更されていました",
      conflict: { currentMl: 100 },
    })
    const { onSaved } = renderSheet({ initialAmountMl: null, intent: "record" })
    typeAmount("120")
    fireEvent.click(screen.getByRole("button", { name: "保存して記録する" }))
    expect(await screen.findByText(/まだ何も記録していません/)).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("サーバが拒んだら理由をシートに出し、閉じず、保存したことにもせぬ", async () => {
    mockedUpdate.mockResolvedValue({ ok: false, error: "いつものミルク量を保存できませんでした。もう一度お試しください。" })
    const { onSaved, onOpenChange } = renderSheet({ initialAmountMl: 120 })
    typeAmount("160")
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("保存できませんでした")
    expect(onSaved).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("保存中に閉じた後で返った失敗・衝突はトーストで知らせる（閉じたシートの中に出しても誰も見ぬ）", async () => {
    const pending: Array<(v: unknown) => void> = []
    mockedUpdate.mockImplementation(
      () => new Promise((r) => pending.push(r as (v: unknown) => void)) as never,
    )
    const props = {
      onOpenChange: vi.fn(),
      intent: "save" as const,
      initialAmountMl: 120,
      onSaved: vi.fn(),
      onConflict: vi.fn(),
    }
    const { rerender } = render(<BottleDefaultSheet open {...props} />)
    typeAmount("160")
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await screen.findByRole("button", { name: /保存中/ })
    rerender(<BottleDefaultSheet open={false} {...props} />)
    pending[0]({ ok: false, error: "いつものミルク量を保存できませんでした。もう一度お試しください。" })
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(
        "いつものミルク量を保存できませんでした。もう一度お試しください。",
      ),
    )
    cleanup()

    mockedToast.error.mockReset()
    const again = render(<BottleDefaultSheet open {...props} />)
    typeAmount("160")
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await screen.findByRole("button", { name: /保存中/ })
    again.rerender(<BottleDefaultSheet open={false} {...props} />)
    pending[1]({ ok: false, error: "x", conflict: { currentMl: 140 } })
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(
        "いつものミルク量は別の端末で先に140mlへ変更されていたため、保存しませんでした",
      ),
    )
    expect(props.onConflict).toHaveBeenCalledWith(140)
  })

  it("対照: 開いたままの失敗はシートの中だけに出し、トーストは重ねぬ", async () => {
    mockedUpdate.mockResolvedValue({ ok: false, error: "いつものミルク量を保存できませんでした。もう一度お試しください。" })
    renderSheet({ initialAmountMl: 120 })
    typeAmount("160")
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("保存できませんでした")
    expect(mockedToast.error).not.toHaveBeenCalled()
  })

  it("通信断（Server Action の reject）は圏外トーストへ倒し、入力を残して押し直せる", async () => {
    mockedUpdate
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ ok: true, amountMl: 160 })
    const { onSaved } = renderSheet({ initialAmountMl: 120 })
    typeAmount("160")
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))
    expect(onSaved).not.toHaveBeenCalled()
    expect(amountInput().value).toBe("160")

    fireEvent.click(await screen.findByRole("button", { name: "保存する" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(160, "save"))
    // 押し直しも開いた時に見ていた 120 を添える（応答を失った保存の再試行はサーバが成功で受ける）
    expect(mockedUpdate).toHaveBeenLastCalledWith({ amountMl: 160, expectedMl: 120 })
  })
})
