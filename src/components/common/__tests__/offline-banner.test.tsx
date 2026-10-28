/**
 * 圏外の表示（E1）: navigator.onLine は「ヒント」。false の時だけ出し、できぬこと（保存・共有）を
 * 正直に言う。true の時に「保存できます」「同期済み」などと言わぬ（何も出さぬ）。
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { OfflineBanner } from "../offline-banner"
import OfflinePage from "@/app/offline/page"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("OfflineBanner", () => {
  it("端末が圏外と言う時だけ、表示が古い可能性と保存・共有できぬことを出す", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    render(<OfflineBanner />)
    const status = screen.getByRole("status")
    expect(status).toHaveTextContent("オフラインです。表示中の内容は最新でない可能性があります")
    expect(status).toHaveTextContent("記録の保存や家族との共有ができません")
    expect(status).toHaveTextContent("端末の通信表示による判定です")
  })

  it("対照: onLine=true では何も出さぬ（保存できる・同期済みとは言わぬ）", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
    const { container } = render(<OfflineBanner />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe("/offline", () => {
  it("戻れる範囲とできぬことを分け、「一度表示したページは全て見られる」と約束せぬ", () => {
    render(<OfflinePage />)
    expect(screen.getByRole("heading", { name: "オフラインです" })).toBeInTheDocument()
    expect(screen.getByText("見られることがあるもの")).toBeInTheDocument()
    expect(screen.getByText("オフラインの間にできないこと")).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent("一度表示したページはオフラインでも閲覧できます")
    expect(document.body).toHaveTextContent("ログアウトや権限の変更も、つながるまでこの端末には反映されません")
  })
})
