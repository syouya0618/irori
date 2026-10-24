/**
 * preventFormAutoReset（P2-30）。
 *
 * React 19 は `<form action={fn}>` の action の後、commit の最中に `form.reset()` を呼ぶ。
 * その間 React は合成イベントを配らぬゆえ `onReset` では止まらぬ（カードのテストで実測:
 * onReset 版はすべて赤）。ネイティブの reset listener が取り消すことをここで固定する。
 */

import { describe, it, expect, afterEach } from "vitest"
import { preventFormAutoReset } from "../prevent-form-auto-reset"

function makeForm(defaultValue: string) {
  const form = document.createElement("form")
  const input = document.createElement("input")
  input.name = "x"
  input.defaultValue = defaultValue
  form.appendChild(input)
  document.body.appendChild(form)
  return { form, input }
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("preventFormAutoReset", () => {
  it("form.reset() を取り消し、入力を残す", () => {
    const { form, input } = makeForm("old")
    preventFormAutoReset(form)

    input.value = "typed"
    form.reset()

    expect(input.value).toBe("typed")
  })

  it("付けておらねば reset で既定値へ戻る（対照: 検知力の証人）", () => {
    const { form, input } = makeForm("old")

    input.value = "typed"
    form.reset()

    expect(input.value).toBe("old")
  })

  it("cleanup の後は listener を外す（付けっぱなしにせぬ）", () => {
    const { form, input } = makeForm("old")
    const cleanup = preventFormAutoReset(form)
    cleanup?.()

    input.value = "typed"
    form.reset()

    expect(input.value).toBe("old")
  })

  it("null（detach）では何もせぬ", () => {
    expect(preventFormAutoReset(null)).toBeUndefined()
  })
})
