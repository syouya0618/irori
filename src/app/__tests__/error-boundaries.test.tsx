/**
 * error.tsx 3 本の「もう一度試す」が**本物の Next の境界**から渡る関数に繋がっておるかの検証（P2-01）。
 *
 * ## 直した欠陥
 * Next 16.3 で再試行の prop は `unstable_retry` → `retry` へ改名された
 * （node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md:331
 *  `v16.3.0 | retry prop became stable.`）。props の型はアプリ自身が宣言するゆえ tsc は
 * 黙り、`unstable_retry` は undefined のまま届いておった。結果、(main) 配下の 2 本は
 * onClick が undefined で無反応、ルートの 1 本は押すと TypeError を投げる。
 * lookup-failed（`(main)/layout.tsx` が throw）の自己回復はこのボタンが前提じゃ。
 *
 * ## なぜ props を手で渡さず ErrorBoundaryHandler で包むか
 * `render(<MainError retry={fn} />)` は「自分で宣言した名前で自分で渡す」だけの
 * 同語反復で、ランタイムが**何という名前で渡すか**を一切検証せぬ（今回の欠陥は
 * まさにそこに在った）。ゆえに Next 本体の境界に throw する子を包ませ、
 * `AppRouterContext.refresh` が呼ばれるか（= retry の実体が走ったか）で判定する。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"
import type { ComponentType } from "react"
import { ErrorBoundaryHandler } from "next/dist/client/components/error-boundary"
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime"
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime"

import GlobalError from "../error"
import MainError from "../(main)/error"
import BabyError from "../(main)/baby/error"

/** refresh が呼ばれるまで throw し続ける子（一度きりの throw は React の同期再描画で隠れうる）。 */
let shouldThrow = true
function Thrower() {
  if (shouldThrow) throw new Error("boom")
  return <p>回復した</p>
}

const refresh = vi.fn(() => {
  shouldThrow = false
})

function renderInsideNextBoundary(errorComponent: ComponentType<never>) {
  const router = { refresh } as unknown as AppRouterInstance
  return render(
    <AppRouterContext.Provider value={router}>
      <ErrorBoundaryHandler
        pathname="/baby"
        errorComponent={errorComponent as never}
        errorStyles={undefined}
        errorScripts={undefined}
      >
        <Thrower />
      </ErrorBoundaryHandler>
    </AppRouterContext.Provider>,
  )
}

beforeEach(() => {
  shouldThrow = true
  refresh.mockClear()
  // 境界が捕まえた例外は React と各 error.tsx の useEffect が console.error へ出す。
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const cases: { name: string; component: ComponentType<never>; heading: RegExp }[] = [
  { name: "app/error.tsx", component: GlobalError as ComponentType<never>, heading: /問題が発生しました/ },
  { name: "(main)/error.tsx", component: MainError as ComponentType<never>, heading: /問題が発生しました/ },
  {
    name: "(main)/baby/error.tsx",
    component: BabyError as ComponentType<never>,
    heading: /育児ログの読み込みに失敗しました/,
  },
]

describe("error.tsx: 「もう一度試す」が Next の retry に繋がる", () => {
  for (const { name, component, heading } of cases) {
    it(`${name}: 押すと router.refresh が 1 回走り、子が描き直される`, async () => {
      renderInsideNextBoundary(component)

      // 境界の fallback が出ておること（前提）
      expect(screen.getByText(heading)).toBeInTheDocument()

      fireEvent.click(screen.getByRole("button", { name: /もう一度試す/ }))

      // unstable_retry のままだと onClick が undefined（または TypeError）で refresh が走らぬ
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      expect(await screen.findByText("回復した")).toBeInTheDocument()
    })
  }
})
