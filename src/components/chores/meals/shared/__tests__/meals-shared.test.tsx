/**
 * ごはんの共有 UI（料理の行・印・数量・注意書き）の最小契約。
 * 色だけで区別しないこと（アイコン + 文字）、未知の値で落ちないこと、保証を装う文言が無いことを見る。
 */
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { ALLERGEN_JUDGEMENT_DISCLAIMER } from "@/lib/meals/catalog/allergens"
import { CHILD_GUIDANCE_DISCLAIMER } from "@/lib/meals/catalog/child-guidance"

import { OriginLabel, PinnedMark, QuantityText, SufficiencyMark, VerdictMark } from "../meal-marks"
import { MEAL_NOTICES, MealNotice, type MealNoticeKind } from "../meal-notices"
import {
  MEAL_HIDDEN_SEGMENTS,
  MEAL_SEGMENTS,
  MEALS_BASE_HREF,
  MEALS_SETTINGS_HREF,
  mealRecipeHref,
} from "../meal-routes"
import { RecipeRow } from "../recipe-row"

afterEach(cleanup)

describe("SufficiencyMark（充足の 3 段）", () => {
  it.each([
    ["ready", "揃う"],
    ["check", "分量要確認"],
    ["buy", "買い足し"],
  ] as const)("%s は「%s」を文字とアイコンで示す", (level, label) => {
    const { container } = render(<SufficiencyMark level={level} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
  })

  it("3 段は文字もアイコンも別（色を消しても区別できる）", () => {
    const shapes = (["ready", "check", "buy"] as const).map((level) => {
      const { container } = render(<SufficiencyMark level={level} />)
      const shape = container.querySelector("svg")?.innerHTML ?? ""
      const text = container.textContent ?? ""
      cleanup()
      return { shape, text }
    })
    expect(new Set(shapes.map((s) => s.shape)).size).toBe(3)
    expect(new Set(shapes.map((s) => s.text)).size).toBe(3)
  })

  it("明暗を対で指定している", () => {
    for (const level of ["ready", "check", "buy"] as const) {
      const { container } = render(<SufficiencyMark level={level} />)
      const className = container.firstElementChild?.className ?? ""
      expect(className).toMatch(/\bdark:bg-/)
      expect(className).toMatch(/\bdark:text-/)
      cleanup()
    }
  })

  it("未知の値は「揃う」などへ言い換えず、確認できない旨を出す", () => {
    render(<SufficiencyMark level={"plenty" as never} />)
    expect(screen.getByText("在庫を確認できません")).toBeInTheDocument()
    expect(screen.queryByText("揃う")).toBeNull()
  })
})

describe("OriginLabel（自動献立と生成 AI の補助を区別する）", () => {
  it.each([
    ["auto", "自動"],
    ["ai_assisted", "AI 補助"],
    ["manual", "手動"],
  ] as const)("%s は「%s」", (origin, label) => {
    render(<OriginLabel origin={origin} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it("自動献立の枠を AI と表示しない", () => {
    const { container } = render(<OriginLabel origin="auto" />)
    expect(container.textContent).not.toMatch(/AI/)
  })

  it("未知の経路は何も名乗らせない", () => {
    const { container } = render(<OriginLabel origin={"ai_v2" as never} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe("VerdictMark（必須除外の判定）", () => {
  it("除外に当たる料理は「使わない食材を含む」", () => {
    render(<VerdictMark verdict="blocked" />)
    expect(screen.getByText("使わない食材を含む")).toBeInTheDocument()
  })

  it("原材料を確かめられない料理は「原材料の確認が必要」", () => {
    render(<VerdictMark verdict="label_check" />)
    expect(screen.getByText("原材料の確認が必要")).toBeInTheDocument()
  })

  it("問題が無いときは何も出さない（「安全」「不使用」と表示しない）", () => {
    const { container } = render(<VerdictMark verdict="ok" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("未知の判定は、確かめられていない側へ倒す（何も出さずに通さない）", () => {
    render(<VerdictMark verdict={"maybe" as never} />)
    expect(screen.getByText("原材料の確認が必要")).toBeInTheDocument()
  })
})

describe("QuantityText / PinnedMark", () => {
  it("数量を日本語で出す。数量が無ければ「数量不明」（空欄にしない）", () => {
    const view = render(<QuantityText quantity={{ amount: 300, unit: "g" }} />)
    expect(view.container.textContent).toBe("300g")
    view.rerender(<QuantityText quantity={null} />)
    expect(view.container.textContent).toBe("数量不明")
    view.rerender(<QuantityText quantity={{ amount: null, unit: "g" }} />)
    expect(view.container.textContent).toBe("数量不明")
  })

  it("固定の印は文字つき", () => {
    render(<PinnedMark />)
    expect(screen.getByText("固定")).toBeInTheDocument()
  })
})

describe("RecipeRow", () => {
  it("料理名・区分・時間・出所・固定・充足・除外の印を出す", () => {
    render(
      <RecipeRow
        title="肉じゃが"
        role="main"
        minutes={30}
        origin="auto"
        pinned
        sufficiency="check"
        verdict="label_check"
      >
        <p>しょうゆの量を確認</p>
      </RecipeRow>,
    )
    expect(screen.getByText("肉じゃが")).toBeInTheDocument()
    expect(screen.getByText("主菜")).toBeInTheDocument()
    expect(screen.getByText("約30分")).toBeInTheDocument()
    expect(screen.getByText("自動")).toBeInTheDocument()
    expect(screen.getByText("固定")).toBeInTheDocument()
    expect(screen.getByText("分量要確認")).toBeInTheDocument()
    expect(screen.getByText("原材料の確認が必要")).toBeInTheDocument()
    expect(screen.getByText("しょうゆの量を確認")).toBeInTheDocument()
  })

  it("渡していない情報は出さない（手動料理に「時間不明」「自動」を付けない）", () => {
    const { container } = render(<RecipeRow title="外食" />)
    expect(container.textContent).toBe("外食")
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("対照: 時間を null で渡したときだけ「時間不明」と出す", () => {
    render(<RecipeRow title="おでん" minutes={null} />)
    expect(screen.getByText("時間不明")).toBeInTheDocument()
  })

  it("href を渡すと料理名が 44px 以上のリンクになる（行全体はリンクにしない）", () => {
    render(
      <RecipeRow
        title="肉じゃが"
        href={mealRecipeHref("nikujaga")}
        trailing={<button type="button">差し替える</button>}
      />,
    )
    const link = screen.getByRole("link", { name: "肉じゃが" })
    expect(link).toHaveAttribute("href", "/chores/meals/recipes/nikujaga")
    expect(link.className).toMatch(/\bmin-h-11\b/)
    expect(link.className).toMatch(/\bmin-w-11\b/)
    expect(link.className).toMatch(/focus-visible:outline-2/)
    expect(link.className).not.toMatch(/transition-all|\boutline-none\b/)
    // 行内の操作はリンクの外に在る（入れ子の操作にしない）
    expect(link.contains(screen.getByRole("button", { name: "差し替える" }))).toBe(false)
  })

  it("問題の無い判定・充足の無い行では、印の行を作らない", () => {
    const { container } = render(<RecipeRow title="肉じゃが" verdict="ok" sufficiency={null} />)
    expect(container.textContent).toBe("肉じゃが")
  })

  it("未知の区分は「料理」と出す", () => {
    render(<RecipeRow title="プリン" role="dessert" />)
    expect(screen.getByText("料理")).toBeInTheDocument()
  })
})

describe("meal-routes", () => {
  it("5 画面の href はごはんの下位で、設定・レシピは切替に並べない", () => {
    for (const segment of MEAL_SEGMENTS) {
      expect(segment.href === MEALS_BASE_HREF || segment.href.startsWith(`${MEALS_BASE_HREF}/`)).toBe(true)
    }
    expect(MEAL_SEGMENTS.map((segment) => segment.href)).not.toContain(MEALS_SETTINGS_HREF)
    expect(MEAL_HIDDEN_SEGMENTS.map((segment) => segment.href)).toContain(MEALS_SETTINGS_HREF)
    expect(new Set([...MEAL_SEGMENTS, ...MEAL_HIDDEN_SEGMENTS].map((segment) => segment.href)).size).toBe(7)
  })

  it("レシピの href は ID を path の 1 区切りとして符号化する", () => {
    expect(mealRecipeHref("curry_rice")).toBe("/chores/meals/recipes/curry_rice")
    expect(mealRecipeHref("a/b?c")).toBe("/chores/meals/recipes/a%2Fb%3Fc")
  })

  it("値を Server Component へ渡せる中立モジュール（use client を書かない）", () => {
    const source = readFileSync(path.resolve(__dirname, "../meal-routes.ts"), "utf8")
    expect(source.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/^\s*["']use client["']/m)
  })
})

describe("注意書きの定型", () => {
  it("アレルギーと子ども向け案内は、出典と一緒に管理しているカタログの文言をそのまま使う", () => {
    expect(MEAL_NOTICES.allergyJudgement).toBe(ALLERGEN_JUDGEMENT_DISCLAIMER)
    expect(MEAL_NOTICES.childGuidance).toBe(CHILD_GUIDANCE_DISCLAIMER)
  })

  it("限界を言い切っている: 商品ごとの原材料・監修・栄養のバランス", () => {
    expect(MEAL_NOTICES.allergyJudgement).toMatch(/商品ごとの原材料.*確認できません/)
    expect(MEAL_NOTICES.childGuidance).toMatch(/監修は受けていません/)
    expect(MEAL_NOTICES.nutrition).toMatch(/保証するものではありません/)
    expect(MEAL_NOTICES.planOrigin).toMatch(/判定には AI を使っていません/)
  })

  it("どの文も、保証・監修済み・安全を装わない（否定形の文だけを例外にする）", () => {
    // 肯定の主張になる語。否定形（「〜を保証するものではありません」「監修は受けていません」）は別に確かめる
    const claims = /監修済み|管理栄養士|アレルゲン不使用|安全です|安心です|適合しています|保証します|栄養バランス保証/
    for (const [kind, text] of Object.entries(MEAL_NOTICES)) {
      expect(text, kind).not.toMatch(claims)
      expect(text.trim().length, kind).toBeGreaterThan(10)
    }
    // 対照: 検査の正規表現は、肯定の主張を実際に捕まえる
    expect("管理栄養士監修済みの献立です").toMatch(claims)
    expect("栄養バランス保証").toMatch(claims)
  })

  it("標準の人数で計算していることを、人数つきで伝える", () => {
    expect(MEAL_NOTICES.defaultServings).toMatch(/標準の2人分/)
  })

  it("MealNotice は文とアイコンで示す（色だけにしない）", () => {
    for (const kind of Object.keys(MEAL_NOTICES) as MealNoticeKind[]) {
      const { container } = render(<MealNotice kind={kind} />)
      expect(screen.getByRole("note")).toHaveTextContent(MEAL_NOTICES[kind])
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
      cleanup()
    }
  })
})

describe("共有 UI の規約", () => {
  const DIR = path.resolve(__dirname, "..")
  // この担当が置いた 5 ファイルだけを見る（後から足される画面別の部品は対象にしない）
  const files = ["meal-marks.tsx", "meal-notices.tsx", "meal-routes.ts", "meals-nav.tsx", "recipe-row.tsx"]
  const codeOf = (file: string) =>
    readFileSync(path.join(DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("検査の対象が在る", () => {
    expect(readdirSync(DIR)).toEqual(expect.arrayContaining(files))
  })

  it.each(files)("%s: transition-all・outline-none・薄めた focus の輪郭を使わない", (file) => {
    const code = codeOf(file)
    expect(code).not.toMatch(/transition-all/)
    expect(code).not.toMatch(/\boutline-none\b/)
    expect(code).not.toMatch(/focus(?:-visible|-within)?:(?:ring|outline)-[a-z]+(?:-[a-z]+)*\/\d/)
  })

  it.each(files)("%s: カタログの重いデータ（食材辞書・レシピ）とごはんの読み込みを import しない", (file) => {
    const imports = [...codeOf(file).matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])
    expect(
      imports.filter((target) =>
        /meals\/catalog\/(ingredients|recipes|index)$|meals\/catalog$|meals\/server\/context$|lib\/supabase/.test(target),
      ),
    ).toEqual([])
  })

  it("対照: 上の import 検査は、重い import を実際に捕まえる", () => {
    const sample = `import { RECIPES } from "@/lib/meals/catalog/recipes"\nimport { x } from "@/lib/meals/server/context"\n`
    const imports = [...sample.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])
    expect(
      imports.filter((target) =>
        /meals\/catalog\/(ingredients|recipes|index)$|meals\/catalog$|meals\/server\/context$|lib\/supabase/.test(target),
      ),
    ).toHaveLength(2)
  })
})
