export const VALID_PAGES = ["meals", "shopping", "stock", "baby"] as const
export type ValidPage = (typeof VALID_PAGES)[number]

/** `default_page` が未設定・未知の値だったときの行き先 */
export const DEFAULT_PAGE: ValidPage = "meals"

/**
 * `profiles.default_page` を「起動時に開くページ」へ解決する。
 *
 * ⚠️ **この規則を呼び出し側へ複製してはならぬ。** 解決は二層で走る:
 *   一層目 = `src/proxy.ts`（`/` に来た時点で最終目的地へ 307。ここで解決すると
 *            `/` の動的描画そのものが要らなくなる）
 *   二層目 = `src/app/page.tsx`（proxy が inert になっても設定が効き続けるため）
 *
 * 二層が**別々に既定値を持つと、片方だけ直したときに無音で食い違う** —
 * `getVerifiedUserId`（proxy とページで認証方式が割れると無限リダイレクト）や
 * `isValidYmd` を 1 箇所へ畳んだのと同じ理由じゃ。ゆえに両層ともこの関数を呼ぶ。
 *
 * `default_page` は NULL を取りうる（列追加以前の行・未設定の利用者）。未知の
 * 文字列も、列が自由文字列である以上ありうる。どちらも `DEFAULT_PAGE` へ倒す。
 */
export function resolveDefaultPage(value: unknown): ValidPage {
  return VALID_PAGES.includes(value as ValidPage)
    ? (value as ValidPage)
    : DEFAULT_PAGE
}
