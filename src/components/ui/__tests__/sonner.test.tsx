/**
 * Toaster（sonner の殻）の契約。
 *
 * - 位置は下端・中央。退避量はナビの変数（--bottom-nav-h / --safe-bottom）から導く。
 *   以前の top-center では、1 タップ記録の救済「取り消す」に片手の親指が届かなんだ
 * - テーマは `<html class="dark">` に追従する。以前は next-themes の useTheme を呼んで
 *   おったが Provider が無く常に "system" で、設定のダークと OS のライトが食い違うと
 *   トーストだけ白く出た
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, waitFor, act } from "@testing-library/react"
import { toast } from "sonner"

import { Toaster } from "../sonner"

beforeEach(() => {
  document.documentElement.classList.remove("dark")
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false
    },
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  cleanup()
  document.documentElement.classList.remove("dark")
  vi.restoreAllMocks()
})

async function mountWithToast() {
  render(<Toaster />)
  await act(async () => {
    toast("テスト通知", { duration: Infinity })
  })
  await screen.findByText("テスト通知")
  const list = document.querySelector("[data-sonner-toaster]") as HTMLElement
  expect(list).not.toBeNull()
  return list
}

describe("Toaster: 位置とナビの退避", () => {
  it("下端・中央に出る", async () => {
    const list = await mountWithToast()
    expect(list).toHaveAttribute("data-y-position", "bottom")
    expect(list).toHaveAttribute("data-x-position", "center")
  })

  /**
   * 退避量そのものは globals.css の `--toast-clearance`（ナビ + safe-area、FAB が在れば FAB の上）
   * が持つ。部品は値を知らず変数名だけを渡す — FAB の有無を React で観測せぬための設計。
   * 変数の中身は `src/app/__tests__/globals-css-contract.test.ts` が固定する。
   */
  it("退避量は --toast-clearance を参照する（PC 幅・モバイル幅の両方）", async () => {
    const list = await mountWithToast()
    const style = list.getAttribute("style") ?? ""
    expect(style).toMatch(/--offset-bottom:\s*var\(--toast-clearance\)/)
    expect(style).toMatch(/--mobile-offset-bottom:\s*var\(--toast-clearance\)/)
  })
})

describe("Toaster: 下シートが開いておる間は上端へ逃がす", () => {
  /**
   * 記録フォーム等の下シートは検証エラーをトーストで出してシートを閉じぬ経路を多く持つ。
   * 下端のままだとシートの下帯（削除の行・メモ欄）を覆うため、`[data-slot="sheet-content"]`
   * が DOM に在る間は top-center、消えれば bottom-center に戻る。
   */
  it("sheet-content が現れたら top、消えたら bottom（対で確かめる）", async () => {
    const list = await mountWithToast()
    expect(list).toHaveAttribute("data-y-position", "bottom")

    const sheet = document.createElement("div")
    sheet.setAttribute("data-slot", "sheet-content")
    document.body.appendChild(sheet)
    await waitFor(() =>
      expect(document.querySelector("[data-sonner-toaster]")).toHaveAttribute("data-y-position", "top"),
    )

    sheet.remove()
    await waitFor(() =>
      expect(document.querySelector("[data-sonner-toaster]")).toHaveAttribute("data-y-position", "bottom"),
    )
  })

  it("対照 — sheet-content 以外の要素が増えても位置は変わらぬ", async () => {
    const list = await mountWithToast()
    const other = document.createElement("div")
    other.setAttribute("data-slot", "card")
    document.body.appendChild(other)
    await act(async () => {})
    expect(list).toHaveAttribute("data-y-position", "bottom")
    other.remove()
  })
})

describe("Toaster: テーマは html.dark に追従する", () => {
  it("ライト（.dark 無し）では light", async () => {
    const list = await mountWithToast()
    expect(list).toHaveAttribute("data-sonner-theme", "light")
  })

  it(".dark が付けば dark へ、外せば light へ戻る（MutationObserver 経由）", async () => {
    const list = await mountWithToast()
    document.documentElement.classList.add("dark")
    await waitFor(() => expect(list).toHaveAttribute("data-sonner-theme", "dark"))
    document.documentElement.classList.remove("dark")
    await waitFor(() => expect(list).toHaveAttribute("data-sonner-theme", "light"))
  })

  it("最初から .dark が付いておれば mount 直後から dark（OS がライトでも）", async () => {
    document.documentElement.classList.add("dark")
    const list = await mountWithToast()
    expect(list).toHaveAttribute("data-sonner-theme", "dark")
  })
})
