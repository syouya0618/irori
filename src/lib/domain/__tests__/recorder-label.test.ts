import { describe, it, expect } from "vitest"
import {
  recorderLabelFor,
  shouldShowRecorder,
  UNKNOWN_RECORDER_LABEL,
  UNNAMED_RECORDER_LABEL,
} from "../recorder-label"

const members = [
  { id: "u1", displayName: "はな" },
  { id: "u2", displayName: "   " },
]

describe("recorderLabelFor", () => {
  it("世帯員の名前を返す", () => {
    expect(recorderLabelFor(members, "u1")).toBe("はな")
  })
  it("名前が未設定（空白のみ）の世帯員は「名前未設定」", () => {
    expect(recorderLabelFor(members, "u2")).toBe(UNNAMED_RECORDER_LABEL)
  })
  it("世帯に居ない利用者（退出・削除済み）は「家族」", () => {
    expect(recorderLabelFor(members, "gone")).toBe(UNKNOWN_RECORDER_LABEL)
  })
})

describe("shouldShowRecorder", () => {
  it("一人の世帯では出さず、二人以上で出す", () => {
    expect(shouldShowRecorder([members[0]])).toBe(false)
    expect(shouldShowRecorder(members)).toBe(true)
    expect(shouldShowRecorder([])).toBe(false)
  })
})
