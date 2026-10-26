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

describe("HelpCard — 要望・改善提案への導線", () => {
  it("誰にでも要望を送る導線を出し、未読の更新を文字で添える", () => {
    render(
      <HelpCard feedback={{ unseenUpdates: 2, isAppOperator: false, inboxUnread: null }} />,
    )
    const link = screen.getByRole("link", { name: /要望・改善提案を送る/ })
    expect(link).toHaveAttribute("href", "/feedback")
    expect(link).toHaveTextContent("更新 2")
  })

  it("運用者でなければ受信箱の導線を出さぬ（世帯 owner であっても）", () => {
    render(
      <HelpCard feedback={{ unseenUpdates: 0, isAppOperator: false, inboxUnread: 5 }} />,
    )
    expect(screen.queryByRole("link", { name: /受信箱/ })).toBeNull()
  })

  it("運用者には受信箱の導線と未読の件数を出す", () => {
    render(
      <HelpCard feedback={{ unseenUpdates: null, isAppOperator: true, inboxUnread: 3 }} />,
    )
    const link = screen.getByRole("link", { name: /要望の受信箱/ })
    expect(link).toHaveAttribute("href", "/feedback/inbox")
    expect(link).toHaveTextContent("未読 3")
  })

  it("件数を読めなかった（null）・0 件の時は件数を出さぬ（0 と偽らぬ）", () => {
    render(
      <HelpCard feedback={{ unseenUpdates: null, isAppOperator: true, inboxUnread: 0 }} />,
    )
    expect(screen.getByRole("link", { name: /要望・改善提案を送る/ })).not.toHaveTextContent("更新")
    expect(screen.getByRole("link", { name: /要望の受信箱/ })).not.toHaveTextContent("未読")
  })
})
