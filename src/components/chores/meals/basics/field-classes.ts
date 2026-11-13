/**
 * 食材・設定の画面が共有する入力部品のクラス（境界指令を持たない中立モジュール）。
 *
 * - 素の `<select>` は 44px（`min-h-11`）。文字は 16px（`text-base`）— 16px 未満だと iOS が
 *   フォーカス時に画面を拡大する。
 * - 遷移は `transition-colors duration-200` だけ。
 */

export const NATIVE_SELECT_CLASS =
  "min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-base text-foreground transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"

/** 選択できる小さな札（常備品・アレルゲン・保管場所など）。選択中は塗りとチェックの印で示す。 */
export function chipClass(selected: boolean): string {
  return `inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1 rounded-full border px-3 text-sm font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 ${
    selected
      ? "border-primary bg-primary text-primary-foreground"
      : "border-border bg-background text-foreground hover:bg-muted"
  }`
}

/** 印（アイコン + 文字）の共通の形。色は補助で、文字で意味を言う。 */
export const MARK_BADGE_CLASS = "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-medium"
export const MARK_NEUTRAL_TONE = "bg-muted text-foreground ring-1 ring-border ring-inset"
export const MARK_WARN_TONE = "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
export const MARK_ALERT_TONE = "bg-destructive/10 text-destructive ring-1 ring-destructive/30 ring-inset"
export const MARK_OK_TONE = "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
