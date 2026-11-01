import { afterEach, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ReleaseHistory } from "../release-history"

afterEach(cleanup)
it("starts closed, opens published changes newest first, and closes with the same button", () => {
  render(<ReleaseHistory />)
  const button = screen.getByRole("button", { name: "更新履歴を見る" })
  expect(button).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByRole("heading")).not.toBeInTheDocument()
  fireEvent.click(button)
  expect(button).toHaveAttribute("aria-expanded", "true")
  expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["2026年10月28日の更新"])
  fireEvent.click(button)
  expect(screen.queryByRole("heading")).not.toBeInTheDocument()
})
