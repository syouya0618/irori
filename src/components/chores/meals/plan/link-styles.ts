/**
 * ごはんの画面で、Link を釦の見た目にするためのクラス（正本）。
 *
 * 境界指令を持たない中立モジュール。`Button` は `asChild` を持たず、`buttonVariants` は基底に
 * `outline-none` を含む（Link の `focus-visible:outline-2` と同居すると輪郭が消える）ので、
 * Link 用の組を別に持つ。どれも 44px 以上・`transition-colors` のみ・薄めない focus の輪郭。
 */

const LINK_BASE =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

/** 主の操作（塗り）。 */
export const PRIMARY_LINK = `${LINK_BASE} bg-primary text-primary-foreground hover:bg-primary-hover`

/** 副の操作（枠）。 */
export const OUTLINE_LINK = `${LINK_BASE} border border-border bg-background text-foreground hover:bg-muted dark:border-input dark:bg-input/30 dark:hover:bg-input/50`

/** 文中から別の画面へ送る、文字だけのリンク（押下領域は 44px）。 */
export const TEXT_LINK =
  "inline-flex min-h-11 min-w-11 items-center gap-1 rounded-lg px-1 text-sm font-medium text-primary underline underline-offset-4 transition-colors duration-200 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"

/** 入力欄と並べる素の select（44px・16px 以上の文字）。 */
export const NATIVE_SELECT =
  "min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
