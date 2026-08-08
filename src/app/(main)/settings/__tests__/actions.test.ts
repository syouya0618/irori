import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

// updateDigestTime は保存後に revalidatePath を呼ぶ（リクエスト文脈の外では
// 実体が使えぬ）。呼ばれたことも見たいゆえ spy として持つ。
const revalidatePath = vi.fn()
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import {
  updateAutoStockCategories,
  updateBabyProfile,
  updateDefaultPage,
  updateDigestTime,
  updateGoogleCalendarSelection,
  updateProfile,
} from "../actions"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"

const mockedLog = vi.mocked(logSupabaseError)
const HOUSEHOLD = "house-1"

/**
 * update().eq().select() を模した fake client。
 *
 * `.update()` は 0 行更新でも error: null を返すため、settings の全 update は
 * `.select("id")` で更新行を要求する契約に揃えた。ゆえに `eq` は **thenable に
 * しない**（`{ select }` だけを返す）。await 可能にすると実装が `.select()` を
 * 忘れても素通りしてしまい、この mock が契約を守らせられなくなる。
 *
 * rows は returning される行。0 行 = 更新対象なし（RLS 拒否・別世帯）を表す。
 */
function makeSupabase(
  updateResult: { error: unknown },
  rows: Array<{ id: string }> = [{ id: HOUSEHOLD }],
) {
  const select = vi.fn().mockResolvedValue({
    data: updateResult.error ? null : rows,
    error: updateResult.error,
  })
  const eq = vi.fn(() => ({ select }))
  const update = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ update }))
  return { client: { from }, update, select }
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

describe("settings の update: 0 行更新を成功と偽らない", () => {
  it("updateBabyProfile: 0 行更新（RLS 拒否・別世帯）はエラーを返す", async () => {
    const { client, select } = makeSupabase({ error: null }, [])
    setContext(client)
    const result = await updateBabyProfile(form("あかり"))
    expect(result).toEqual({ error: "赤ちゃん情報の更新に失敗しました" })
    // .select("id") を通っていること（行数検証が実在すること）を固定する。
    expect(select).toHaveBeenCalledWith("id")
  })

  it("updateProfile: 0 行更新はエラーを返す", async () => {
    const { client, select } = makeSupabase({ error: null }, [])
    setContext(client)
    const fd = new FormData()
    fd.set("display_name", "ホロ")
    const result = await updateProfile(fd)
    expect(result).toEqual({ error: "プロフィールの更新に失敗しました" })
    expect(select).toHaveBeenCalledWith("id")
  })

  it("updateProfile: 1 行更新なら成功", async () => {
    const { client } = makeSupabase({ error: null }, [{ id: "user-1" }])
    setContext(client)
    const fd = new FormData()
    fd.set("display_name", "ホロ")
    expect(await updateProfile(fd)).toEqual({ success: true })
  })

  it("updateDefaultPage: 0 行更新はエラーを返す", async () => {
    const { client } = makeSupabase({ error: null }, [])
    setContext(client)
    expect(await updateDefaultPage("meals")).toEqual({
      error: "設定の更新に失敗しました",
    })
  })

  it("updateDefaultPage: 1 行更新なら成功", async () => {
    const { client } = makeSupabase({ error: null }, [{ id: "user-1" }])
    setContext(client)
    expect(await updateDefaultPage("meals")).toEqual({ success: true })
  })

  it("updateAutoStockCategories: 0 行更新はエラーを返す", async () => {
    const { client } = makeSupabase({ error: null }, [])
    setContext(client)
    expect(await updateAutoStockCategories(["baby"])).toEqual({
      error: "設定の更新に失敗しました",
    })
  })

  it("updateAutoStockCategories: 1 行更新なら成功", async () => {
    const { client } = makeSupabase({ error: null })
    setContext(client)
    expect(await updateAutoStockCategories(["baby"])).toEqual({ success: true })
  })
})

/**
 * Google カレンダーの購読トグル（D-4）。
 *
 * 世帯スコープを `.eq("household_id", ...)` で**明示**する契約ゆえ `.eq()` を
 * 2 回鎖ねる。上の `makeSupabase` は 1 回しか返さぬため専用の fake を使う。
 */
function makeGoogleSupabase(result: {
  data: Array<{ id: string }> | null
  error: unknown
}) {
  const select = vi.fn().mockResolvedValue(result)
  const eqHousehold = vi.fn(() => ({ select }))
  const eqId = vi.fn(() => ({ eq: eqHousehold }))
  const update = vi.fn(() => ({ eq: eqId }))
  const from = vi.fn(() => ({ update }))
  return { client: { from }, from, update, eqId, eqHousehold, select }
}

describe("updateGoogleCalendarSelection", () => {
  it("認証前に入力を検証する（空 ID は DB へ到達せぬ）", async () => {
    const { client, update } = makeGoogleSupabase({ data: [], error: null })
    setContext(client)
    expect(await updateGoogleCalendarSelection("  ", true)).toEqual({
      error: "カレンダーの指定が不正です",
    })
    expect(update).not.toHaveBeenCalled()
  })

  it("boolean 以外の選択状態は弾く", async () => {
    const { client, update } = makeGoogleSupabase({ data: [], error: null })
    setContext(client)
    expect(
      await updateGoogleCalendarSelection(
        "sub-1",
        "true" as unknown as boolean,
      ),
    ).toEqual({ error: "選択状態の指定が不正です" })
    expect(update).not.toHaveBeenCalled()
  })

  it("未認証はエラーを返す", async () => {
    getAuthContext.mockResolvedValue({
      error: "認証されていません",
      reason: "unauthenticated",
      context: null,
    })
    expect(await updateGoogleCalendarSelection("sub-1", true)).toEqual({
      error: "認証されていません",
    })
  })

  it("is_selected だけを更新し、世帯スコープを明示する", async () => {
    const { client, from, update, eqId, eqHousehold } = makeGoogleSupabase({
      data: [{ id: "sub-1" }],
      error: null,
    })
    setContext(client)

    expect(await updateGoogleCalendarSelection("sub-1", true)).toEqual({
      success: true,
    })
    expect(from).toHaveBeenCalledWith("google_calendar_subscriptions")
    // 秘密列（sync_token / sync_lease_until）へは絶対に触れぬ。
    expect(update).toHaveBeenCalledWith({ is_selected: true })
    expect(eqId).toHaveBeenCalledWith("id", "sub-1")
    expect(eqHousehold).toHaveBeenCalledWith("household_id", HOUSEHOLD)
  })

  it("OFF も同じ経路で通る", async () => {
    const { client, update } = makeGoogleSupabase({
      data: [{ id: "sub-1" }],
      error: null,
    })
    setContext(client)
    expect(await updateGoogleCalendarSelection("sub-1", false)).toEqual({
      success: true,
    })
    expect(update).toHaveBeenCalledWith({ is_selected: false })
  })

  it("0 行更新を成功と偽らぬ（別世帯・RLS 拒否）", async () => {
    const { client } = makeGoogleSupabase({ data: [], error: null })
    setContext(client)
    expect(await updateGoogleCalendarSelection("sub-1", true)).toEqual({
      error: "カレンダーの設定に失敗しました",
    })
  })

  it("Supabase error は構造化ログへ落としてから返す", async () => {
    const error = {
      message: "permission denied for column sync_token",
      code: "42501",
      details: null,
      hint: null,
    }
    const { client } = makeGoogleSupabase({ data: null, error })
    setContext(client)

    expect(await updateGoogleCalendarSelection("sub-1", true)).toEqual({
      error: "カレンダーの設定に失敗しました",
    })
    expect(mockedLog).toHaveBeenCalledWith(
      "settings",
      "google calendar selection update failed",
      error,
      { subscriptionId: "sub-1", householdId: HOUSEHOLD },
    )
  })
})

/**
 * 毎朝のまとめ（B-5）の時刻保存。
 *
 * ここで固定するのは 3 つじゃ:
 *   1. **画面が出す集合しか通さぬ**（allowlist。Server Action は PostgREST を
 *      直叩きできる利用者に対する唯一の関門でもある）
 *   2. **送る列は 2 つだけ**。PostgREST の upsert は送った列だけを
 *      `ON CONFLICT DO UPDATE SET` に並べるゆえ、`event_default_minutes` を
 *      混ぜると予定通知の既定値が黙って消える
 *   3. 0 行を成功と偽らぬ
 */
function makeUpsertSupabase(result: { data: unknown; error: unknown }) {
  const select = vi.fn().mockResolvedValue(result)
  const upsert = vi.fn(() => ({ select }))
  const from = vi.fn(() => ({ upsert }))
  return { client: { from }, from, upsert, select }
}

describe("updateDigestTime", () => {
  beforeEach(() => {
    revalidatePath.mockClear()
  })

  it("刻みに乗った時刻を TIME 列へ書く", async () => {
    const { client, from, upsert } = makeUpsertSupabase({
      data: [{ user_id: "user-1" }],
      error: null,
    })
    setContext(client)

    expect(await updateDigestTime("07:30")).toEqual({ success: true })
    expect(from).toHaveBeenCalledWith("notification_preferences")
    expect(upsert).toHaveBeenCalledWith(
      { user_id: "user-1", digest_time: "07:30" },
      { onConflict: "user_id" },
    )
    expect(revalidatePath).toHaveBeenCalledWith("/settings")
  })

  it("「送らない」は NULL を書く（行は消さぬ）", async () => {
    const { client, upsert } = makeUpsertSupabase({
      data: [{ user_id: "user-1" }],
      error: null,
    })
    setContext(client)

    expect(await updateDigestTime("none")).toEqual({ success: true })
    expect(upsert).toHaveBeenCalledWith(
      { user_id: "user-1", digest_time: null },
      { onConflict: "user_id" },
    )
  })

  it("**予定通知の既定値（event_default_minutes）を送らぬ**", async () => {
    // 送れば `ON CONFLICT DO UPDATE SET event_default_minutes = NULL` になり、
    // まとめの時刻を変えるたびに予定通知の既定が黙って消える。
    const { client, upsert } = makeUpsertSupabase({
      data: [{ user_id: "user-1" }],
      error: null,
    })
    setContext(client)

    await updateDigestTime("08:00")
    // 引数の**列名の集合**を見る（値ではなく形を固定する assert ゆえ、
    // 上の toHaveBeenCalledWith とは別の意図を持つ）。
    const calls = upsert.mock.calls as unknown as [Record<string, unknown>][]
    expect(Object.keys(calls[0][0]).sort()).toEqual(["digest_time", "user_id"])
  })

  it("画面に無い値は DB へ届く前に弾く（allowlist）", async () => {
    const { client, upsert } = makeUpsertSupabase({ data: [], error: null })
    setContext(client)

    for (const bad of ["07:13", "07:00:00", "24:00", "", "なし"]) {
      expect(await updateDigestTime(bad)).toEqual({ error: "無効な時刻です" })
    }
    // **DB を一度も触っておらぬ**（検証が素通りしておらぬ証拠）。
    expect(upsert).not.toHaveBeenCalled()
  })

  it("0 行を成功と偽らぬ（RLS 拒否・行が作られなかった）", async () => {
    const { client } = makeUpsertSupabase({ data: [], error: null })
    setContext(client)

    expect(await updateDigestTime("07:00")).toEqual({
      error: "通知の設定に失敗しました",
    })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("Supabase error は構造化ログへ落としてから返す", async () => {
    const error = {
      message: "permission denied for table notification_preferences",
      code: "42501",
      details: null,
      hint: null,
    }
    const { client } = makeUpsertSupabase({ data: null, error })
    setContext(client)

    expect(await updateDigestTime("07:00")).toEqual({
      error: "通知の設定に失敗しました",
    })
    expect(mockedLog).toHaveBeenCalledWith(
      "settings",
      "digest time update failed",
      error,
      { userId: "user-1" },
    )
  })
})
