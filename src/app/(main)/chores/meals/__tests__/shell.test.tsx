/**
 * ごはんの殻（layout / loading / error）の契約。
 *
 * - 切替は現在地だけに `aria-current="page"` を付ける（設定・レシピの画面では、どの項目も現在地にしない）。
 * - layout はデータを読まない同期の Server Component（読むと `loading.tsx` が出る前に遷移が止まる）。
 * - `error.tsx` の「もう一度試す」は、本物の Next の境界が渡す `retry` に繋がる。
 *
 * 見た目の実寸（44px・320px 幅の折り返し）は実ブラウザでしか測れない。ここは役割・名前・状態と、
 * 規約のクラスが付いていること（対照つき）を見る。
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ComponentType } from "react"
import { ErrorBoundaryHandler } from "next/dist/client/components/error-boundary"
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime"
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let pathname = "/chores/meals"
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ refresh: vi.fn() }),
}))

import MealsError from "../error"
import MealsLayout from "../layout"
import MealsLoading from "../loading"

beforeEach(() => {
  pathname = "/chores/meals"
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderLayout() {
  return render(
    <MealsLayout>
      <p>本文</p>
    </MealsLayout>,
  )
}

function segmentLinks() {
  return within(screen.getByRole("navigation", { name: "ごはんの画面" })).getAllByRole("link")
}

function currentSegments(): string[] {
  return segmentLinks()
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent ?? "")
}

describe("ごはんの layout", () => {
  it("h1「ごはん」・家事へ戻るリンク・本文を出す", () => {
    renderLayout()
    expect(screen.getByRole("heading", { level: 1, name: "ごはん" })).toBeInTheDocument()
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1)
    expect(screen.getByRole("link", { name: "家事" })).toHaveAttribute("href", "/chores")
    expect(screen.getByText("本文")).toBeInTheDocument()
  })

  it("切替は 5 画面を決まった順で並べる", () => {
    renderLayout()
    expect(segmentLinks().map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["今夜", "/chores/meals"],
      ["今あるもので", "/chores/meals/now"],
      ["献立", "/chores/meals/plan"],
      ["買い物", "/chores/meals/shopping"],
      ["食材", "/chores/meals/pantry"],
    ])
  })

  it.each([
    ["/chores/meals", "今夜"],
    ["/chores/meals/now", "今あるもので"],
    ["/chores/meals/plan", "献立"],
    ["/chores/meals/shopping", "買い物"],
    ["/chores/meals/pantry", "食材"],
  ])("%s では「%s」だけが現在地（aria-current=page と塗り）", (path, label) => {
    pathname = path
    renderLayout()
    expect(currentSegments()).toEqual([label])
    const current = screen.getByRole("link", { name: label })
    expect(current.className).toMatch(/(^|\s)bg-primary(\s|$)/)
    for (const link of segmentLinks()) {
      if (link !== current) expect(link.className).not.toMatch(/(^|\s)bg-primary(\s|$)/)
    }
    expect(screen.getByRole("link", { name: "ごはんの設定" })).not.toHaveAttribute("aria-current")
  })

  it("設定の画面では、切替のどの項目も現在地にせず、設定の入口を現在地にする", () => {
    pathname = "/chores/meals/settings"
    renderLayout()
    expect(currentSegments()).toEqual([])
    const settings = screen.getByRole("link", { name: "ごはんの設定" })
    expect(settings).toHaveAttribute("href", "/chores/meals/settings")
    expect(settings).toHaveAttribute("aria-current", "page")
  })

  it("レシピの画面・似た接頭辞の path では、どの項目も現在地にしない（「今夜」を現在地にしない）", () => {
    for (const path of ["/chores/meals/recipes/nikujaga", "/chores/mealsx", "/chores/cleaning"]) {
      pathname = path
      renderLayout()
      expect(currentSegments(), path).toEqual([])
      expect(screen.getByRole("link", { name: "ごはんの設定" })).not.toHaveAttribute("aria-current")
      cleanup()
    }
  })

  it("下位のさらに下位（/plan/…）でも、最も近い項目が現在地", () => {
    pathname = "/chores/meals/plan/2026-11-12"
    renderLayout()
    expect(currentSegments()).toEqual(["献立"])
  })

  it("切替は折り返せる並びで、項目は 44px 以上・項目の中では折り返さない", () => {
    renderLayout()
    const list = screen.getByRole("navigation", { name: "ごはんの画面" }).firstElementChild
    expect(list?.className).toMatch(/\bflex-wrap\b/)
    for (const link of segmentLinks()) {
      expect(link.className).toMatch(/\bmin-h-11\b/)
      expect(link.className).toMatch(/\bmin-w-11\b/)
      expect(link.className).toMatch(/\bwhitespace-nowrap\b/)
      // 等分（flex-1）ではなく文字幅で並べる
      expect(link.className).toMatch(/\bflex-auto\b/)
      expect(link.className).not.toMatch(/\bflex-1\b/)
      expect(link.className).toMatch(/focus-visible:outline-2/)
      expect(link.className).toMatch(/transition-colors/)
      expect(link.className).not.toMatch(/transition-all|\boutline-none\b/)
    }
  })

  it("設定の入口は 44px のアイコンリンクで、名前を持ち、アイコンは装飾", () => {
    renderLayout()
    const settings = screen.getByRole("link", { name: "ごはんの設定" })
    expect(settings.className).toMatch(/\bsize-11\b/)
    expect(settings.className).toMatch(/focus-visible:outline-2/)
    expect(settings.className).not.toMatch(/transition-all|\boutline-none\b/)
    expect(settings.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
  })

  it("外枠の余白は殻が持ち、ナビの下余白（pb-nav 相当）を足さない", () => {
    const { container } = renderLayout()
    const shell = container.firstElementChild
    expect(shell?.className).toMatch(/\bpx-4\b/)
    expect(shell?.className).toMatch(/\bpt-12\b/)
    expect(shell?.className).not.toMatch(/pb-nav|pb-20|pb-24/)
  })
})

describe("ごはんの layout はデータを読まない", () => {
  const source = readFileSync(path.resolve(__dirname, "../layout.tsx"), "utf8")
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("同期の関数で、認証・cookies・Supabase・ごはんの読み込みを import しない", () => {
    expect(MealsLayout({ children: null })).not.toBeInstanceOf(Promise)
    expect(code).not.toMatch(/\basync\b/)
    expect(code).not.toMatch(/auth-context|next\/headers|supabase|meals\/server\/context|meals\/catalog/)
  })

  it("対照: この検査は、コメント中の語ではなく実コードを見ている", () => {
    // 説明文には getAuthContext の語が在るが、実コードには無い
    expect(source).toMatch(/getAuthContext/)
    expect(code).not.toMatch(/getAuthContext/)
  })

  it("page.tsx はこの殻と同じ階層に置かれていても、殻は page を import しない", () => {
    expect(code).not.toMatch(/from\s+"\.\/page"/)
  })
})

describe("ごはんの loading", () => {
  it("読み込み中であることを名前つきの status で伝える（見出しは layout が出す）", () => {
    render(<MealsLoading />)
    const status = screen.getByRole("status", { name: "ごはんを読み込み中" })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByRole("heading")).toBeNull()
    expect(status.querySelector(".glass")).not.toBeNull()
  })
})

describe("ごはんの error.tsx: 「もう一度試す」が Next の retry に繋がる", () => {
  let shouldThrow = true
  function Thrower() {
    if (shouldThrow) throw new Error("boom")
    return <p>回復した</p>
  }

  it("押すと router.refresh が 1 回走り、子が描き直される", async () => {
    shouldThrow = true
    const refresh = vi.fn(() => {
      shouldThrow = false
    })
    vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <AppRouterContext.Provider value={{ refresh } as unknown as AppRouterInstance}>
        <ErrorBoundaryHandler
          pathname="/chores/meals"
          errorComponent={MealsError as ComponentType<never> as never}
          errorStyles={undefined}
          errorScripts={undefined}
        >
          <Thrower />
        </ErrorBoundaryHandler>
      </AppRouterContext.Provider>,
    )

    expect(screen.getByText("ごはんの読み込みに失敗しました")).toBeInTheDocument()
    // 「消えたわけではない」と伝える（読めなかったことを、記録が無いことと混同させない）
    expect(screen.getByText(/消えたわけではありません/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /もう一度試す/ }))
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(await screen.findByText("回復した")).toBeInTheDocument()
  })

  it("対照: retry を渡さなければ、押しても何も起きない（prop 名を取り違えると無反応になる）", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const retry = vi.fn()
    const Wrong = MealsError as unknown as ComponentType<{ error: Error; unstable_retry: () => void }>
    render(<Wrong error={new Error("boom")} unstable_retry={retry} />)
    fireEvent.click(screen.getByRole("button", { name: /もう一度試す/ }))
    expect(retry).not.toHaveBeenCalled()
  })
})
