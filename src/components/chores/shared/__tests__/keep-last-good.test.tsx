/**
 * 画面全体の読み取り失敗の受け皿（R34）。
 *
 * - 表示済みの画面の取り直しが失敗しても、中の Client Component を unmount せぬ（入力中の state が残る）
 * - 初回の失敗・別の scope の失敗は throw して error.tsx へ渡す（「無い」と偽らぬ）
 *
 * 対照として、同じ失敗を error boundary で受けると state が消えることも固定する
 * （page から throw する形へ戻すと、この対照の側の挙動になる）。
 */
import { Component, useState, type ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { KeepLastGood } from "../keep-last-good"
import { resetRefreshGateForTest } from "../refresh-gate"

/** 入力中の state を持つ画面の代役。`rows` は Server から届く内容。 */
function View({ rows }: { rows: string }) {
  const [draft, setDraft] = useState("")
  return (
    <div>
      <p data-testid="rows">{rows}</p>
      <textarea aria-label="まとめ入力" value={draft} onChange={(event) => setDraft(event.target.value)} />
    </div>
  )
}

/** page.tsx の代役: 読めた時も読めなんだ時も、同じ位置に KeepLastGood を返す。 */
function Page({ scope = "u1:h1", rows, failure }: { scope?: string; rows?: string; failure?: string }) {
  if (failure !== undefined) return <KeepLastGood scope={scope} failure={failure} />
  return (
    <KeepLastGood scope={scope}>
      <View rows={rows ?? ""} />
    </KeepLastGood>
  )
}

class Boundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { message: error.message }
  }
  render() {
    return this.state.message === null ? this.props.children : <p role="alert">{this.state.message}</p>
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  resetRefreshGateForTest()
  // React は boundary が受けた例外も console.error へ出す。期待した例外ゆえ黙らせる
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("KeepLastGood: 取り直しの失敗", () => {
  it("直前に読めた内容と入力中の state を保ち、「更新できませんでした」と理由を出す", () => {
    const view = render(<Page rows="玉ねぎ" />)
    expect(screen.queryByTestId("stale-content-notice")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("まとめ入力"), { target: { value: "卵 1パック" } })
    const box = screen.getByLabelText("まとめ入力")

    view.rerender(<Page failure="食材を読み込めませんでした" />)

    // 同じ DOM 要素のまま = unmount されておらぬ
    expect(screen.getByLabelText("まとめ入力")).toBe(box)
    expect(box).toHaveValue("卵 1パック")
    expect(screen.getByTestId("rows")).toHaveTextContent("玉ねぎ")
    const notice = screen.getByRole("status")
    expect(notice).toHaveTextContent("最新の内容に更新できませんでした（食材を読み込めませんでした）")
    expect(notice).toHaveTextContent("前回読み込めた内容")

    // 失敗が続いても保つ
    view.rerender(<Page failure="食材を読み込めませんでした" />)
    expect(screen.getByLabelText("まとめ入力")).toBe(box)
    expect(box).toHaveValue("卵 1パック")
  })

  it("次に読めたら知らせを消し、新しい内容を出す。入力中の state はそのまま", () => {
    const view = render(<Page rows="玉ねぎ" />)
    fireEvent.change(screen.getByLabelText("まとめ入力"), { target: { value: "卵" } })
    const box = screen.getByLabelText("まとめ入力")
    view.rerender(<Page failure="食材を読み込めませんでした" />)
    view.rerender(<Page rows="玉ねぎ・牛乳" />)
    expect(screen.queryByTestId("stale-content-notice")).not.toBeInTheDocument()
    expect(screen.getByTestId("rows")).toHaveTextContent("玉ねぎ・牛乳")
    expect(screen.getByLabelText("まとめ入力")).toBe(box)
    expect(box).toHaveValue("卵")
  })

  it("「もう一度読み込む」で取り直せる", () => {
    const view = render(<Page rows="玉ねぎ" />)
    view.rerender(<Page failure="食材を読み込めませんでした" />)
    fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("対照: 同じ失敗を throw して error boundary で受けると、入力中の state は消える", () => {
    function ThrowingPage({ rows, failure }: { rows?: string; failure?: string }) {
      if (failure !== undefined) throw new Error(failure)
      return <View rows={rows ?? ""} />
    }
    const view = render(
      <Boundary>
        <ThrowingPage rows="玉ねぎ" />
      </Boundary>,
    )
    fireEvent.change(screen.getByLabelText("まとめ入力"), { target: { value: "卵 1パック" } })
    view.rerender(
      <Boundary>
        <ThrowingPage failure="食材を読み込めませんでした" />
      </Boundary>,
    )
    expect(screen.queryByLabelText("まとめ入力")).not.toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("食材を読み込めませんでした")
  })
})

describe("KeepLastGood: 出せる内容が無い失敗", () => {
  it("初回の失敗は throw して error boundary へ渡す（空の画面を出さぬ）", () => {
    render(
      <Boundary>
        <Page failure="献立を読み込めませんでした" />
      </Boundary>,
    )
    expect(screen.getByRole("alert")).toHaveTextContent("献立を読み込めませんでした")
    expect(screen.queryByTestId("stale-content-notice")).not.toBeInTheDocument()
    // boundary 無しなら描画そのものが失敗する
    cleanup()
    expect(() => render(<Page failure="献立を読み込めませんでした" />)).toThrow("献立を読み込めませんでした")
  })

  it("scope（世帯・表示中の週）が替わった失敗では、前の scope の内容を出さぬ", () => {
    const view = render(
      <Boundary>
        <Page scope="u1:h1:2026-11-09" rows="今週の献立" />
      </Boundary>,
    )
    view.rerender(
      <Boundary>
        <Page scope="u1:h1:2026-11-16" failure="献立を読み込めませんでした" />
      </Boundary>,
    )
    expect(screen.queryByText("今週の献立")).not.toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("献立を読み込めませんでした")
  })

  it("対照: 同じ scope の失敗なら前の内容を保つ", () => {
    const view = render(
      <Boundary>
        <Page scope="u1:h1:2026-11-09" rows="今週の献立" />
      </Boundary>,
    )
    view.rerender(
      <Boundary>
        <Page scope="u1:h1:2026-11-09" failure="献立を読み込めませんでした" />
      </Boundary>,
    )
    expect(screen.getByText("今週の献立")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
