import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { updateBabyProfile } from "../actions"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"

const mockedLog = vi.mocked(logSupabaseError)
const HOUSEHOLD = "house-1"

/** update().eq() を模した fake client（settings は select/single を挟まない）。 */
function makeSupabase(updateResult: { error: unknown }) {
  const eq = vi.fn().mockResolvedValue(updateResult)
  const update = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ update }))
  return { client: { from }, update }
}

function setContext(supabase: unknown) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: "user-1", householdId: HOUSEHOLD },
  })
}

/** baby_name / baby_birth_date を持つ FormData を作る。 */
function form(babyName: string, babyBirthDate?: string): FormData {
  const fd = new FormData()
  fd.set("baby_name", babyName)
  if (babyBirthDate !== undefined) fd.set("baby_birth_date", babyBirthDate)
  return fd
}

beforeEach(() => {
  getAuthContext.mockReset()
  mockedLog.mockClear()
})

describe("updateBabyProfile: 誕生日 JST 未来日の拒否", () => {
  it("JST 未来日は DB へ到達せず明確な文言で拒否する", async () => {
    const { client, update } = makeSupabase({ error: null })
    setContext(client)
    // 実 now に対して確実に未来（+3 日）の日付を渡す。
    const future = shiftYmd(todayJstString(), 3)
    const result = await updateBabyProfile(form("あかり", future))
    expect(result).toEqual({ error: "誕生日には今日以前の日付を指定してください" })
    // 未来日は getAuthContext 前に弾かれ DB update は呼ばれない。
    expect(getAuthContext).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it("JST 当日は許可されて DB update まで到達する", async () => {
    const { client, update } = makeSupabase({ error: null })
    setContext(client)
    const result = await updateBabyProfile(form("あかり", todayJstString()))
    expect(result).toEqual({ success: true })
    expect(update).toHaveBeenCalled()
  })

  it("形式不正は専用文言で拒否する", async () => {
    const { client } = makeSupabase({ error: null })
    setContext(client)
    const result = await updateBabyProfile(form("あかり", "2026/07/19"))
    expect(result).toEqual({ error: "生年月日の形式が不正です" })
  })
})

describe("updateBabyProfile: CHECK 違反(23514)の弁別", () => {
  it("23514 は汎用文言でなく誕生日起因の文言を返す", async () => {
    const { client } = makeSupabase({
      error: { code: "23514", message: "check constraint violation" },
    })
    setContext(client)
    // 過去日はアプリ層検証を通過し、DB の CHECK（UTC 基準）でのみ弾かれるケース。
    const result = await updateBabyProfile(form("あかり", "2020-01-01"))
    expect(result).toEqual({ error: "誕生日には今日以前の日付を指定してください" })
    // 握り潰さず構造化ログに残す。
    expect(mockedLog).toHaveBeenCalledWith(
      "settings",
      expect.any(String),
      expect.objectContaining({ code: "23514" }),
      expect.objectContaining({ householdId: HOUSEHOLD }),
    )
  })

  it("23514 以外の DB エラーは汎用文言 + 構造化ログ", async () => {
    const { client } = makeSupabase({
      error: { code: "XX000", message: "boom" },
    })
    setContext(client)
    const result = await updateBabyProfile(form("あかり", "2020-01-01"))
    expect(result).toEqual({ error: "赤ちゃん情報の更新に失敗しました" })
    expect(mockedLog).toHaveBeenCalledWith(
      "settings",
      expect.any(String),
      expect.objectContaining({ code: "XX000" }),
      expect.objectContaining({ householdId: HOUSEHOLD }),
    )
  })

  it("誕生日空欄は許可され null で保存される", async () => {
    const { client, update } = makeSupabase({ error: null })
    setContext(client)
    const result = await updateBabyProfile(form("あかり", ""))
    expect(result).toEqual({ success: true })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ baby_birth_date: null }),
    )
  })
})

describe("updateBabyProfile: 授乳間隔", () => {
  function formWithInterval(interval: string): FormData {
    const fd = new FormData()
    fd.set("baby_name", "あかり")
    fd.set("feeding_interval_min", interval)
    return fd
  }

  it("有効な間隔は households 更新に含まれる", async () => {
    const { client, update } = makeSupabase({ error: null })
    setContext(client)
    const result = await updateBabyProfile(formWithInterval("120"))
    expect(result).toEqual({ success: true })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ feeding_interval_min: 120 }),
    )
  })

  it("範囲外の間隔は DB へ到達せず拒否する", async () => {
    const { client, update } = makeSupabase({ error: null })
    setContext(client)
    const result = await updateBabyProfile(formWithInterval("10"))
    expect(result).toEqual({ error: "授乳間隔の値が不正です" })
    expect(update).not.toHaveBeenCalled()
  })

  it("未送信時は既定 180 分で保存される", async () => {
    const { client, update } = makeSupabase({ error: null })
    setContext(client)
    const result = await updateBabyProfile(form("あかり"))
    expect(result).toEqual({ success: true })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ feeding_interval_min: 180 }),
    )
  })
})
