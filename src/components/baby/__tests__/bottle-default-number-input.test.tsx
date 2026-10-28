/**
 * いつものミルク量の数値入力（Base UI Number Field 1.6.0 + BottleDefaultSheet）の入力経路
 * （F2・AC25 の component 層。jsdom の範囲）。
 *
 * e2e で「単発の fill("180") の後に 160,180 が残った」実測があった（baby-bottle-default.spec.ts の
 * replaceBottleAmount）。原因が上流（Base UI）か利用側（シート）かを、入力の経路ごとに切り分ける:
 *
 * - 上流の挙動（node_modules/@base-ui/react/number-field/input/NumberFieldInput.js）:
 *   (1) 初めて focus した時にキャレットを**末尾へ動かす**（onFocus の setSelectionRange(len, len)）
 *   (2) paste は**選択範囲に**差し込む（選択が無ければキャレット位置。ネイティブと同じ）
 *   (3) blur で ja-JP の書式に整える（160180 → "160,180"）
 *   (4) 全角数字を数として読む
 *   ゆえに「focus の前に全選択 → 初回 focus で選択が末尾へ潰れる → 末尾へ 180 を差し込む」と
 *   160180 になり、blur で "160,180" と見える（e2e の実測と同じ形）。
 * - 利用側の守り: allowOutOfRange で丸めず受け、保存の前に 1〜999 の整数かを確かめて**明示的に拒む**
 *   （160180 を黙って 999 にも 160 にもせぬ）。
 *
 * jsdom はキー入力・IME の変換確定・実際の選択操作・暗黙の送信（Enter）を再現せぬ。ここで示すのは
 * 部品が受ける DOM イベントの経路まで。実機・WebKit・IME は NOT_RUN（e2e/webkit-core.spec.ts は作成のみ）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"

vi.mock("@/app/(main)/baby/actions", () => ({ updateBottleDefault: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { BottleDefaultSheet } from "../bottle-default-sheet"
import { updateBottleDefault } from "@/app/(main)/baby/actions"
import { BOTTLE_DEFAULT_RANGE_ERROR } from "@/lib/domain/bottle-default"

const mockedUpdate = vi.mocked(updateBottleDefault)

function renderSheet(initialAmountMl: number | null = 160) {
  const onSaved = vi.fn()
  render(
    <BottleDefaultSheet
      open
      onOpenChange={vi.fn()}
      intent="save"
      initialAmountMl={initialAmountMl}
      onSaved={onSaved}
      onConflict={vi.fn()}
    />,
  )
  return { onSaved }
}

const input = () => screen.getByLabelText("1回の量（ml）") as HTMLInputElement
const save = () => fireEvent.click(screen.getByRole("button", { name: "保存する" }))

function paste(text: string) {
  fireEvent.paste(input(), { clipboardData: { getData: () => text } })
}

beforeEach(() => {
  mockedUpdate.mockReset()
  mockedUpdate.mockImplementation(async ({ amountMl }) => ({ ok: true, amountMl }))
})
afterEach(cleanup)

describe("上流の挙動の確認（Base UI Number Field）", () => {
  it("初めて focus すると、事前の全選択は末尾のキャレットへ潰れる", () => {
    renderSheet(160)
    input().setSelectionRange(0, 3)
    fireEvent.focus(input())
    expect(input().selectionStart).toBe(3)
    expect(input().selectionEnd).toBe(3)
  })

  it("全選択が潰れた後の paste は末尾に足され、160180 になり、blur で ja-JP の書式 160,180 に見える", () => {
    renderSheet(160)
    input().setSelectionRange(0, 3)
    fireEvent.focus(input())
    paste("180")
    expect(input().value).toBe("160180")
    fireEvent.blur(input())
    expect(input().value).toBe("160,180")
  })
})

describe("利用側（BottleDefaultSheet）の入力経路", () => {
  it("⭐ 160→180 の選択置換（focus の後に全選択して paste）: 180 を送る", async () => {
    const { onSaved } = renderSheet(160)
    fireEvent.focus(input())
    input().setSelectionRange(0, input().value.length)
    paste("180")
    expect(input().value).toBe("180")
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(180, "save"))
    expect(mockedUpdate).toHaveBeenCalledWith({ amountMl: 180, expectedMl: 160 })
  })

  it("⭐ 結合してしまった 160180 は丸めず、保存の前に明示的に拒む（999 にも 160 にもせぬ）", async () => {
    renderSheet(160)
    fireEvent.focus(input())
    paste("180")
    fireEvent.blur(input())
    expect(input().value).toBe("160,180")
    save()
    expect(await screen.findByText(BOTTLE_DEFAULT_RANGE_ERROR)).toBeInTheDocument()
    expect(input()).toHaveAttribute("aria-invalid", "true")
    expect(mockedUpdate).not.toHaveBeenCalled()
    // 打った値は書き換えておらぬ（黙って丸めぬ）
    expect(input().value).toBe("160,180")
  })

  it("直接入力（入力欄の値の置き換え）: 180 を送る", async () => {
    const { onSaved } = renderSheet(160)
    fireEvent.change(input(), { target: { value: "180" } })
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(180, "save"))
  })

  it("全角の「１８０」は 180 として読む（上流の解析）", async () => {
    const { onSaved } = renderSheet(160)
    fireEvent.change(input(), { target: { value: "１８０" } })
    fireEvent.blur(input())
    expect(input().value).toBe("180")
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(180, "save"))
  })

  it("全角の paste（全選択の後）も 180", async () => {
    const { onSaved } = renderSheet(160)
    fireEvent.focus(input())
    input().setSelectionRange(0, input().value.length)
    paste("１８０")
    save()
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(180, "save"))
  })

  it("blur しても 180 は 180 のまま（書式で値を変えぬ）", () => {
    renderSheet(160)
    fireEvent.change(input(), { target: { value: "180" } })
    fireEvent.blur(input())
    expect(input().value).toBe("180")
  })

  it("Enter は部品が止めぬ（keyDown の既定動作を妨げず、フォームの送信へ任せる）", async () => {
    const { onSaved } = renderSheet(160)
    fireEvent.change(input(), { target: { value: "180" } })
    const notPrevented = fireEvent.keyDown(input(), { key: "Enter" })
    expect(notPrevented).toBe(true)
    // jsdom は Enter の暗黙の送信をせぬゆえ、送信は form の submit で代える
    fireEvent.submit(input().closest("form")!)
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(180, "save"))
  })

  it("数字でない文字の入力は受け付けず、直前の値を残す（160 を別の値へ化けさせぬ）", () => {
    renderSheet(160)
    fireEvent.change(input(), { target: { value: "16a" } })
    expect(input().value).toBe("160")
  })

  it("小数（160.5）は丸めずに拒む", async () => {
    renderSheet(160)
    fireEvent.change(input(), { target: { value: "160.5" } })
    fireEvent.blur(input())
    save()
    expect(await screen.findByText(BOTTLE_DEFAULT_RANGE_ERROR)).toBeInTheDocument()
    expect(mockedUpdate).not.toHaveBeenCalled()
  })
})
