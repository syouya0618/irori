"use client"

import { useLayoutEffect } from "react"

/**
 * 画面下に浮く操作（FAB）が在る間、`<html data-fab>` を立てる。
 *
 * globals.css の `html[data-fab]` がこれを見て、下端トースト（sonner）の退避量
 * `--toast-clearance` を FAB の上端 + 1rem へ上げる（DESIGN_SYSTEM.md「浮く操作（FAB）とトーストの契約」）。
 * FAB の部品は根でこれを呼ぶだけでよい。トースト側（ui/sonner.tsx）は FAB の有無を知らぬ。
 *
 * ## なぜ CSS の :has() ではなく React が持つ属性か
 * Next 16.3 の docs（preserving-ui-state.md「The :has selector」）は、全体に効く状態は React が持つ
 * `data-*` 属性で表し、広い `:has()` は性能の瓶首になると戒める。Cache Components / <Activity> で
 * 隠された route は DOM に残る（display: none）ゆえ、`body:has([data-fab])` では隠れた予定画面の
 * FAB が他の画面のトーストを上げ続ける。layout effect は Activity が隠す時にも cleanup が走るため、
 * 属性は対で消える。`:has()` を解さぬ環境でも属性選択子は効く。
 *
 * 複数の FAB が同時に在っても、最後の 1 つが消えるまで属性を保つ（件数で数える）。
 */
export const FAB_ATTRIBUTE = "data-fab"

let fabCount = 0

export function useFabClearance(active = true): void {
  useLayoutEffect(() => {
    if (!active) return
    fabCount += 1
    document.documentElement.setAttribute(FAB_ATTRIBUTE, "")
    return () => {
      fabCount -= 1
      if (fabCount <= 0) {
        fabCount = 0
        document.documentElement.removeAttribute(FAB_ATTRIBUTE)
      }
    }
  }, [active])
}
