"use client"

import { useSyncExternalStore } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * テーマは `<html class="dark">` の有無から読む。
 *
 * 以前は next-themes の `useTheme()` を呼んでおったが、このアプリは next-themes の
 * ThemeProvider を持たず（テーマは `use-theme.ts` が `.dark` クラスで切り替える）、
 * 戻り値は常に "system" じゃった。設定で「ダーク」を選んでも OS がライトなら
 * トーストだけ白く出る（逆も然り）。`.dark` を直接観測すれば、設定・OS のどちらで
 * 切り替わっても必ず画面と同じ側になる。
 *
 * SSR では "light" を返し、hydration 後に実際の値へ寄せる（useSyncExternalStore の
 * getServerSnapshot 契約）。sonner はトーストが無い間は何も描かぬため、属性の不一致は起きぬ。
 */
function subscribeThemeClass(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  })
  return () => observer.disconnect()
}
function getThemeClass(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}
function getServerThemeClass(): "light" | "dark" {
  return "light"
}

/**
 * 下シート（Sheet）が開いておる間だけ、トーストを上端へ逃がす。
 *
 * 通常はナビの上（下端）に出すが、記録フォームなどの下シートは入力の検証エラーを
 * トーストで出してシートを閉じぬ経路を多く持つ。下端のままだとシートの下帯（削除の行や
 * メモ欄）を約 4 秒覆い、そこへのタップをトーストが受ける（独立レビューの指摘）。
 * シートが在る間は従来どおり上端（シートより上の背景）に出し、閉じれば下端へ戻る。
 * 判定は `[data-slot="sheet-content"]`（ui/sheet.tsx）が DOM に在るかで、Base UI の
 * Popup は閉じると unmount するゆえ DOM の有無がそのまま開閉を表す。
 * 既知の限界: Cache Components / <Activity> を有効にすると隠れた route の DOM が残るゆえ、
 * 隠れた画面で開いたままのシートがこの判定に掛かりうる（現在 cacheComponents は無効）。
 */
const SHEET_SELECTOR = '[data-slot="sheet-content"]'
function subscribeSheets(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => observer.disconnect()
}
function getSheetOpen(): boolean {
  return document.querySelector(SHEET_SELECTOR) !== null
}
function getServerSheetOpen(): boolean {
  return false
}

/**
 * トーストは**下端・ナビの上**に出す（以前は top-center）。
 *
 * 1 タップ記録の唯一の救済「取り消す」が画面上端にあると、片手では親指が届かぬ
 * （DESIGN_SYSTEM.md が名指しする失敗モード「誤タップ（片手操作時）」の救済が
 * 片手で使えなんだ）。退避量は globals.css の `--toast-clearance` に委ねる:
 *   - 既定: ナビ高さ + safe-area + 0.75rem（ナビの寸法を変えてもトーストが潜らぬ）
 *   - FAB を持つ画面（FAB の部品が `useFabClearance()` で `<html data-fab>` を立てておる間）:
 *     FAB の上端 + 1rem まで上げる（globals.css の `html[data-fab]`）。この部品は FAB の有無を
 *     知らず、変数名だけを渡す
 * ナビの無い画面（ログイン等）では少し高めに出るだけで、害は無い。
 */
const CLEARANCE = "var(--toast-clearance)"

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useSyncExternalStore(
    subscribeThemeClass,
    getThemeClass,
    getServerThemeClass,
  )
  const sheetOpen = useSyncExternalStore(
    subscribeSheets,
    getSheetOpen,
    getServerSheetOpen,
  )

  return (
    <Sonner
      theme={theme}
      position={sheetOpen ? "top-center" : "bottom-center"}
      offset={{ bottom: CLEARANCE }}
      mobileOffset={{ bottom: CLEARANCE }}
      richColors
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
