import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"

import { OcrProviderCard } from "../ocr-provider-card"

beforeEach(() => {
  localStorage.clear()
})
afterEach(cleanup)

describe("OcrProviderCard", () => {
  it("既定は端末内で、その説明を表示する", () => {
    render(<OcrProviderCard />)
    expect(screen.getByText(/外部送信なし・費用ゼロ/)).toBeInTheDocument()
  })

  it("クラウドを選ぶと localStorage に保存し説明が切り替わる", () => {
    render(<OcrProviderCard />)
    fireEvent.click(screen.getByRole("button", { name: "クラウド" }))
    expect(localStorage.getItem("irori:ocr-provider")).toBe("google-vision")
    expect(screen.getByText(/画像が外部に送信/)).toBeInTheDocument()
  })

  it("手入力を選ぶと localStorage に保存する", () => {
    render(<OcrProviderCard />)
    fireEvent.click(screen.getByRole("button", { name: "手入力" }))
    expect(localStorage.getItem("irori:ocr-provider")).toBe("manual")
  })
})
