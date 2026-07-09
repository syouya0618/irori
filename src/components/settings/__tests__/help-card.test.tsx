/**
 * HelpCard → OnboardingTour の再表示結線を end-to-end で検証する。
 * 両者は (main)/layout 配下に同居するため、HelpCard のボタンで
 * マウント済みツアーが開くことを、両コンポーネントを同時 render して確認する。
 */

import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"

import { HelpCard } from "../help-card"
import { OnboardingTour } from "@/components/common/onboarding-tour"

beforeEach(() => {
  cleanup()
  localStorage.clear()
})

describe("HelpCard", () => {
  it("既読後でも「もう一度見る」でツアーが再表示される", () => {
    // 既読状態にして自動表示を抑止
    localStorage.setItem("irori:tour-seen:v1", "1")
    render(
      <>
        <OnboardingTour />
        <HelpCard />
      </>,
    )
    expect(screen.queryByText(/ようこそ/)).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("button", { name: "使い方ツアーをもう一度見る" }),
    )
    expect(screen.getByText(/ようこそ/)).toBeInTheDocument()
  })
})
