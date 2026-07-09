/**
 * OnboardingTour（使い方ツアー）の回帰テスト。
 *
 * 仕様:
 * - 初回（localStorage フラグ未設定）はマウント時に自動表示される
 * - 「スキップ」または最後の「はじめる」で閉じ、localStorage に既読フラグが立つ
 * - 既読なら自動表示しない
 * - reopenOnboardingTour()（設定からの再表示）で再度開く
 *
 * localStorage は jsdom が提供するためモック不要。effect で読むため
 * render は act で包まれ、useEffect の setState が反映される。
 */

import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react"

import { OnboardingTour, reopenOnboardingTour } from "../onboarding-tour"

beforeEach(() => {
  cleanup()
  localStorage.clear()
})

describe("OnboardingTour", () => {
  it("初回（フラグ未設定）はマウント時に自動表示される", () => {
    render(<OnboardingTour />)
    expect(screen.getByText(/ようこそ/)).toBeInTheDocument()
  })

  it("既読フラグがあれば自動表示しない", () => {
    localStorage.setItem("irori:tour-seen:v1", "1")
    render(<OnboardingTour />)
    expect(screen.queryByText(/ようこそ/)).not.toBeInTheDocument()
  })

  it("「スキップ」で閉じ、既読フラグが立つ", () => {
    render(<OnboardingTour />)
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }))
    expect(localStorage.getItem("irori:tour-seen:v1")).toBe("1")
    expect(screen.queryByText(/ようこそ/)).not.toBeInTheDocument()
  })

  it("最後まで進んで「はじめる」で閉じ、既読フラグが立つ", () => {
    render(<OnboardingTour />)
    // 「次へ」を辿り、最終ステップの「はじめる」に到達する
    for (let i = 0; i < 20; i++) {
      const next = screen.queryByRole("button", { name: "次へ" })
      if (!next) break
      fireEvent.click(next)
    }
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }))
    expect(localStorage.getItem("irori:tour-seen:v1")).toBe("1")
    expect(screen.queryByText(/ようこそ/)).not.toBeInTheDocument()
  })

  it("reopenOnboardingTour() で既読後も再表示できる", () => {
    localStorage.setItem("irori:tour-seen:v1", "1")
    render(<OnboardingTour />)
    expect(screen.queryByText(/ようこそ/)).not.toBeInTheDocument()

    act(() => {
      reopenOnboardingTour()
    })
    expect(screen.getByText(/ようこそ/)).toBeInTheDocument()
  })
})
