/**
 * 起動時ページの解決規則と、その**判定源が1つである**ことの固定。
 *
 * 解決は二層で走る（proxy = 速い一層目 / app/page.tsx = proxy が inert でも
 * 設定を効かせ続ける二層目）。両層が別々に既定値を持つと、片方だけ直したときに
 * **無音で食い違う**。同じ轍を踏まぬよう、`routing-auth-single-source.test.ts`
 * と同じ流儀でソース上の不変条件として固定する。
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEFAULT_PAGE, VALID_PAGES, resolveDefaultPage } from "../pages"

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")

/**
 * `default_page` を読んで振る舞いを決めるファイル（＝解決規則を持ちうる層）。
 *
 * 設定画面も含めるのは、そこが**利用者に「今どこが選ばれているか」を見せる**層
 * だからじゃ。ここだけ独自の既定を持つと、未知の値が入ったときに
 * 「カードは無選択なのに起動は献立へ行く」という乖離が無音で生じる
 * —— 設定と実挙動が食い違う形は `#219` そのものじゃ。
 */
const RESOLVER_FILES = [
  "src/proxy.ts",
  "src/app/page.tsx",
  "src/app/(main)/settings/page.tsx",
]

describe("resolveDefaultPage", () => {
  it.each(VALID_PAGES)("有効な値 %s はそのまま通す", (page) => {
    expect(resolveDefaultPage(page)).toBe(page)
  })

  // 「通る側」と「弾かれる側」を対で置く（片側だけだと恒真な実装を素通しする）
  it.each([
    ["NULL（列追加以前の行・未設定の利用者）", null],
    ["undefined（列を select し忘れた場合）", undefined],
    ["未知の文字列", "dashboard"],
    ["空文字", ""],
    ["ページではないが実在するパス", "settings"],
    ["ページではないが実在するパス（calendar）", "calendar"],
    ["先頭スラッシュ付き（列の書式違い）", "/meals"],
    ["数値", 42],
    ["オブジェクト", { page: "meals" }],
  ])("%s は既定へ倒す", (_label, value) => {
    expect(resolveDefaultPage(value)).toBe(DEFAULT_PAGE)
  })

  it("既定値そのものは有効なページである（`/${DEFAULT_PAGE}` が 404 にならぬ）", () => {
    expect(VALID_PAGES).toContain(DEFAULT_PAGE)
  })
})

describe("解決規則の判定源は1つ", () => {
  it.each(RESOLVER_FILES)("%s は resolveDefaultPage を呼ぶ", (file) => {
    expect(read(file)).toMatch(/resolveDefaultPage\s*\(/)
  })

  it.each(RESOLVER_FILES)(
    "%s は VALID_PAGES.includes を直接書かない（規則の複製を禁ずる）",
    (file) => {
      const offending = read(file)
        .split("\n")
        .filter(
          (line) =>
            !line.trim().startsWith("//") && !line.trim().startsWith("*")
        )
        .filter((line) => /VALID_PAGES\s*\.\s*includes\s*\(/.test(line))
      expect(offending).toEqual([])
    }
  )
})
