import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Select, SelectTrigger, SelectValue } from "../select"

/**
 * SelectTrigger のタッチ領域（CLAUDE.md「Touch targets: min 44px」）。
 *
 * 基底の `data-[size=default]:h-8` は属性セレクタを伴うぶん詳細度が高く、呼び出し側が
 * 素の `h-11` を渡しても 32px に負ける（予定シートの「繰り返し」「通知」が実際に 32px
 * じゃった）。#202 が Button / segmentCn / TabsTrigger で採ったのと同じく、基底へ
 * `min-h-11` を足して「足りぬ時だけ効く」形で 44px を保証する。
 *
 * jsdom は寸法を測れぬゆえクラスの契約で固定する。なお e2e/touch-targets.spec.ts は
 * 常時表示の要素しか測らず、閉じたシートの中（予定シートの Select）は実寸の網に
 * 掛かっておらぬ — この穴が残っておった理由でもある。
 */
describe("SelectTrigger — タッチ領域 44px をプリミティブで満たす", () => {
  it("既定サイズで min-h-11 を持つ（呼び出し側が何も渡さずとも）", () => {
    render(
      <Select items={[{ value: "a", label: "A" }]} defaultValue="a">
        <SelectTrigger aria-label="選択">
          <SelectValue />
        </SelectTrigger>
      </Select>,
    )
    expect(screen.getByLabelText("選択").className).toMatch(/(^|\s)min-h-11(\s|$)/)
  })
})
