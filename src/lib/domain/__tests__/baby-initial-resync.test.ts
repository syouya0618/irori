import { describe, expect, it } from "vitest"
import { INITIAL_BABY_SNAPSHOT_FRESH_MS, shouldResyncBabyOnMount } from "../baby-initial-resync"

describe("育児ホームのSSR直後に起こる重複データ取得を省く", () => {
  const now = 1_795_300_000_000

  it("SSR完了直後はマウントの2回目だけ省き、10秒以内でも同じ", () => {
    expect(shouldResyncBabyOnMount(now, now + 100, false)).toBe(false)
    expect(shouldResyncBabyOnMount(now, now + INITIAL_BABY_SNAPSHOT_FRESH_MS, false)).toBe(false)
  })

  it("戻る/進むで古いRSCが復元された場合は必ず再取得する", () => {
    expect(shouldResyncBabyOnMount(now, now + INITIAL_BABY_SNAPSHOT_FRESH_MS + 1, false)).toBe(true)
    expect(shouldResyncBabyOnMount(now, now + 60_000, false)).toBe(true)
  })

  it("取得失敗、端末時刻のずれ、欠落・不正値は通信を省略しない", () => {
    expect(shouldResyncBabyOnMount(now, now, true)).toBe(true)
    expect(shouldResyncBabyOnMount(null, now, false)).toBe(true)
    expect(shouldResyncBabyOnMount(undefined, now, false)).toBe(true)
    expect(shouldResyncBabyOnMount(now + 1, now, false)).toBe(true)
    expect(shouldResyncBabyOnMount(Number.NaN, now, false)).toBe(true)
    expect(shouldResyncBabyOnMount(now, Number.POSITIVE_INFINITY, false)).toBe(true)
  })
})
