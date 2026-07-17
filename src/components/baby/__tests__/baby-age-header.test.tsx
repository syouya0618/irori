import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { BabyAgeHeader } from "../baby-age-header"

afterEach(cleanup)

describe("BabyAgeHeader", () => {
  it("生年月日があれば月齢ラベルを表示する", () => {
    render(
      <BabyAgeHeader
        babyName="そうた"
        babyBirthDate="2026-01-01"
        referenceDate="2026-04-11"
      />,
    )
    expect(screen.getByText("生後3ヶ月10日")).toBeInTheDocument()
    expect(screen.getByText(/そうた/)).toBeInTheDocument()
  })

  it("名前が未設定でも月齢は表示する", () => {
    render(
      <BabyAgeHeader
        babyName={null}
        babyBirthDate="2026-04-01"
        referenceDate="2026-04-11"
      />,
    )
    expect(screen.getByText("生後10日")).toBeInTheDocument()
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
