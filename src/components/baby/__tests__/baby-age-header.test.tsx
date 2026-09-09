import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { BabyAgeHeader } from "../baby-age-header"

afterEach(cleanup)

describe("BabyAgeHeader", () => {
  it("生年月日があれば暦上の月齢と通算日数を同時に表示する", () => {
    render(
      <BabyAgeHeader
        babyName="そうた"
        babyBirthDate="2026-01-01"
        referenceDate="2026-04-11"
      />,
    )
    expect(screen.getByText("生後3ヶ月10日")).toBeInTheDocument()
    expect(screen.getByText("生後100日")).toBeInTheDocument()
    expect(screen.getByText(/そうた/)).toBeInTheDocument()
  })

  it("要望の例: 生後1ヶ月27日 と 生後58日 が一目で両方見える", () => {
    render(
      <BabyAgeHeader
        babyName={null}
        babyBirthDate="2026-07-13"
        referenceDate="2026-09-09"
      />,
    )
    expect(screen.getByText("生後1ヶ月27日")).toBeInTheDocument()
    expect(screen.getByText("生後58日")).toBeInTheDocument()
  })

  it("月末生まれの月跨ぎ（1/31 → 3/1）は 1ヶ月1日 / 生後29日（30 日換算ではない）", () => {
    render(
      <BabyAgeHeader
        babyName={null}
        babyBirthDate="2026-01-31"
        referenceDate="2026-03-01"
      />,
    )
    expect(screen.getByText("生後1ヶ月1日")).toBeInTheDocument()
    expect(screen.getByText("生後29日")).toBeInTheDocument()
  })

  it("1 歳以上は「○歳○ヶ月」と通算日数を並べる", () => {
    render(
      <BabyAgeHeader
        babyName={null}
        babyBirthDate="2025-02-11"
        referenceDate="2026-04-11"
      />,
    )
    expect(screen.getByText("1歳2ヶ月")).toBeInTheDocument()
    expect(screen.getByText("生後424日")).toBeInTheDocument()
  })

  it("名前が未設定でも月齢は表示する。1ヶ月未満は日数を二重に出さない", () => {
    render(
      <BabyAgeHeader
        babyName={null}
        babyBirthDate="2026-04-01"
        referenceDate="2026-04-11"
      />,
    )
    // 「生後10日」は 1 度だけ（月齢ラベル自体が日数ゆえ通算日数を重ねない）
    expect(screen.getAllByText("生後10日")).toHaveLength(1)
  })

  it("生年月日が未設定なら設定への誘導を表示する", () => {
    render(
      <BabyAgeHeader
        babyName={null}
        babyBirthDate={null}
        referenceDate="2026-04-11"
      />,
    )
    const link = screen.getByRole("link", { name: /誕生日を登録/ })
    expect(link).toHaveAttribute("href", "/settings")
    expect(screen.queryByText(/生後/)).not.toBeInTheDocument()
  })

  it("不正な生年月日は月齢を出さず設定誘導にフォールバック", () => {
    render(
      <BabyAgeHeader
        babyName="そうた"
        babyBirthDate="not-a-date"
        referenceDate="2026-04-11"
      />,
    )
    expect(screen.queryByText(/生後/)).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: /誕生日を登録/ })).toBeInTheDocument()
  })
})
