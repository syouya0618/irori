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

  // 2026-10-27 D: 設定の全完了を前提にせず、最初の記録・家族の招待・ホーム画面からの開き方を案内
  it("最初に「設定が済んでいなくても記録できる」と言い、最初の記録・家族の招待・ホーム画面の手順を順に出す", () => {
    render(<OnboardingTour />)
    expect(screen.getByText(/設定がすべて済んでいなくても、すぐに記録を始められます/)).toBeInTheDocument()
    const titles: string[] = []
    for (let i = 0; i < 10; i++) {
      titles.push(document.querySelector("[data-slot=sheet-title]")?.textContent ?? "")
      const next = screen.queryByRole("button", { name: "次へ" })
      if (!next) break
      fireEvent.click(next)
    }
    expect(titles).toEqual(
      expect.arrayContaining(["最初の記録", "家族を招待", "ホーム画面から開く"]),
    )
    expect(titles.indexOf("最初の記録")).toBeLessThan(titles.indexOf("家族を招待"))
    expect(screen.getByRole("button", { name: "はじめる" })).toBeInTheDocument()
  })

  it("ブラウザで開いておればホーム画面への追加の手順を、ホーム画面から開いておればその旨を出す", () => {
    const original = window.matchMedia
    const goToHomeStep = () => {
      for (let i = 0; i < 10; i++) {
        if (screen.queryByText("ホーム画面から開く")) return
        fireEvent.click(screen.getByRole("button", { name: "次へ" }))
      }
    }
    try {
      window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia
      const browser = render(<OnboardingTour />)
      goToHomeStep()
      expect(screen.getByText(/「ホーム画面に追加」すると/)).toBeInTheDocument()
      expect(screen.getByText(/追加しなくても、このままブラウザで使えます/)).toBeInTheDocument()
      browser.unmount()
      localStorage.clear()

      window.matchMedia = ((q: string) => ({
        matches: q === "(display-mode: standalone)",
        media: q,
      })) as unknown as typeof window.matchMedia
      render(<OnboardingTour />)
      goToHomeStep()
      expect(screen.getByText(/いまはホーム画面から開いています/)).toBeInTheDocument()
    } finally {
      window.matchMedia = original
    }
  })
})
