/**
 * 授乳の保存の再送契約（2026-10-27 監査 F01 / 受入 AC01〜AC03・AC05）。
 *
 * 本物の FeedingTimer・本物の recordFeeding（insertBabyLog / sameRecordedContent）・主キー重複と
 * 世帯の絞り込みを持つ保存先（fake-baby-logs-db）を繋ぎ、**DB に保存した後で応答だけを失わせ**、
 * 時計を 30 秒・90 秒進めてから押し直す。旧い試験は 2 回目の Action を成功 mock にしておったため、
 * 「同じ id で別の時刻・秒数を送ってサーバに拒まれる」不整合を検出できなんだ。
 *
 * 守る契約:
 * - 最初の有効な保存操作で送信内容（id・開始時刻・左右秒・回数・開始側）を固定し、結果が不明な間の
 *   再送は同じものを送る（時刻・秒数を作り直さぬ）
 * - 行は 1 件だけ。成功の表示はサーバの確定値（id・logged_at・updated_at）で組む
 * - 応答不明の間は内容を変えさせず、新しい id で登録し直さぬ
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import { act } from "react"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn(), info: viMod.fn() } }
})

// 本物の Server Action を通しつつ、「DB には届いたが応答が失われた」を注入する差し込み口。
const actionHooks: { loseNextResponse: number; hangAfterSave: boolean } = {
  loseNextResponse: 0,
  hangAfterSave: false,
}
const sentPayloads: Array<Record<string, unknown>> = []
vi.mock("@/app/(main)/baby/actions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/(main)/baby/actions")>()
  return {
    ...real,
    recordFeeding: async (input: Parameters<typeof real.recordFeeding>[0]) => {
      sentPayloads.push(structuredClone(input) as unknown as Record<string, unknown>)
      const result = await real.recordFeeding(input)
      if (actionHooks.hangAfterSave) return new Promise<never>(() => {})
      if (actionHooks.loseNextResponse > 0) {
        actionHooks.loseNextResponse -= 1
        throw new TypeError("Failed to fetch")
      }
      return result
    },
  }
})

import { FeedingTimer } from "../feeding-timer"
import { GET as lookupGET } from "@/app/api/baby-logs/lookup/route"
import { GET as versionGET } from "@/app/api/version/route"
import { createFakeBabyLogsDb, type FakeBabyLogsDb } from "@/test-utils/fake-baby-logs-db"
import { toast } from "sonner"
import type { BabyLogData } from "@/lib/types/baby"

const HOUSEHOLD = "house-1"
const USER = "user-1"
// JST 13:00（日跨ぎの影響を受けない日中）
const T0 = new Date("2026-07-19T04:00:00.000Z")

let db: FakeBabyLogsDb

function advance(ms: number) {
  act(() => {
    vi.setSystemTime(new Date(Date.now() + ms))
  })
}

function renderTimer(onLogRecorded = vi.fn(), onOpenChange = vi.fn()) {
  const utils = render(
    <FeedingTimer
      open
      onOpenChange={onOpenChange}
      initialFeedingType="breast_left"
      userId={USER}
      householdId={HOUSEHOLD}
      onLogRecorded={onLogRecorded}
    />,
  )
  return { ...utils, onLogRecorded, onOpenChange }
}

/** 最初の押下も再送も同じ主操作の釦（応答不明の間は再送の文言になる）。 */
function primaryButton(name: RegExp) {
  return screen.getByRole("button", { name })
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
  sentPayloads.length = 0
  actionHooks.loseNextResponse = 0
  actionHooks.hangAfterSave = false
  vi.useFakeTimers({ now: T0, toFake: ["Date"] })
  db = createFakeBabyLogsDb({ now: () => new Date(), householdId: HOUSEHOLD })
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: db.client, userId: USER, householdId: HOUSEHOLD },
  })
  // 照合の GET は本物の Route Handler（getAuthContext と同じ保存先）へ繋ぐ。手動記録の押した時刻の
  // サンプル（/api/version）も本物の Route Handler が答える（この試験では端末とサーバの時計は同じ。
  // 時計のずれは save-time-server-anchored.integration.test.tsx）。経過の時計は偽の Date に揃える
  const base = Date.now()
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - base + 1_000)
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost")
    if (url.pathname === "/api/version") return versionGET()
    return lookupGET(new Request(url))
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 開いた時のサーバ時刻のサンプルを落ち着かせる（押下はサンプルの取得を待たぬ。N3） */
async function flushServerSample() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("手動記録: DB 保存後に応答だけ失い、30 秒・90 秒後に押し直す（AC01 / AC02）", () => {
  it.each([30_000, 90_000])("%i ms 後の再送も最初の押下時刻のまま 1 件だけ保存し、確定値で成功を認識する", async (later) => {
    const { onLogRecorded, onOpenChange } = renderTimer()
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
    await flushServerSample()
    // 開いてから 90 秒手間取ってから記録する（開いた時刻でも 5 分前でもなく押下時刻）
    advance(90_000)
    const pressedAt = new Date().toISOString()

    actionHooks.loseNextResponse = 1
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(db.rows).toHaveLength(1))
    await waitFor(() => expect(primaryButton(/もう一度送る|記録する/)).not.toBeDisabled())
    // 失敗を保存済みと言わぬ
    expect(onLogRecorded).not.toHaveBeenCalled()

    advance(later)
    fireEvent.click(primaryButton(/もう一度送る|記録する/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))

    expect(db.rows).toHaveLength(1)
    expect(sentPayloads).toHaveLength(2)
    // 同じ操作の再送は同じ内容（id・時刻・左右秒・回数・開始側）
    expect(sentPayloads[1]).toEqual(sentPayloads[0])
    expect(sentPayloads[0].loggedAt).toBe(pressedAt)
    const stored = db.rows[0]
    expect(new Date(String(stored.logged_at)).toISOString()).toBe(pressedAt)

    // 成功の表示はサーバの確定値で組む（id・logged_at・updated_at）
    const shown = onLogRecorded.mock.calls[0][0] as BabyLogData
    expect(shown.id).toBe(stored.id)
    expect(shown.updated_at).toBe(stored.updated_at)
    expect(new Date(shown.logged_at).toISOString()).toBe(pressedAt)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(localStorage.getItem("irori:feeding-timer")).toBeNull()
  })
})

describe("タイマー停止: 応答を失い、経過が増えてから再停止する（AC03）", () => {
  it("初回停止の秒数と開始時刻を保ち、同じ記録が 1 件だけ存在する", async () => {
    const { onLogRecorded } = renderTimer()
    advance(5 * 60_000)

    actionHooks.loseNextResponse = 1
    fireEvent.click(primaryButton(/停止して記録/))
    await waitFor(() => expect(db.rows).toHaveLength(1))
    await waitFor(() =>
      expect(primaryButton(/もう一度送る|停止して記録/)).not.toBeDisabled(),
    )
    expect(onLogRecorded).not.toHaveBeenCalled()

    advance(90_000)
    fireEvent.click(primaryButton(/もう一度送る|停止して記録/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))

    expect(db.rows).toHaveLength(1)
    expect(sentPayloads[1]).toEqual(sentPayloads[0])
    expect(sentPayloads[0]).toMatchObject({
      loggedAt: T0.toISOString(),
      breastLeftSec: 300,
      breastRightSec: 0,
    })
    expect(db.rows[0]).toMatchObject({ breast_left_sec: 300, duration_sec: 300 })
  })

  it("応答不明の保存は再読込（再マウント）を越えて同じ内容で照合できる（AC06）", async () => {
    const first = renderTimer()
    advance(5 * 60_000)
    actionHooks.loseNextResponse = 1
    fireEvent.click(primaryButton(/停止して記録/))
    await waitFor(() => expect(db.rows).toHaveLength(1))
    await waitFor(() => expect(primaryButton(/もう一度送る|停止して記録/)).not.toBeDisabled())
    first.unmount()

    // 再読込: 端末保存から同じ送信内容が戻る（計測を走らせ直さぬ）
    advance(10 * 60_000)
    const { onLogRecorded } = renderTimer()
    fireEvent.click(primaryButton(/もう一度送る|停止して記録/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(db.rows).toHaveLength(1)
    expect(sentPayloads[1]).toEqual(sentPayloads[0])
  })
})

describe("送信が返らぬまま（AC14: Server Action は直列ゆえ送り直しは詰まる）", () => {
  it("15 秒で「応答を待っています」と出し、照合（GET）で保存を確かめて終えられる", async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ now: T0, toFake: ["Date", "setTimeout", "clearTimeout"] })
    // DB には書けたが、応答が永遠に返らぬ（Server Action の列を塞ぐ）
    actionHooks.hangAfterSave = true
    const { onLogRecorded } = renderTimer()
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
    // この試験は setTimeout も偽ゆえ、サンプルの到着は偽の時計を 0 進めて流す
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.click(primaryButton(/^記録する$/))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(db.rows).toHaveLength(1)
    const check = screen.getByRole("button", { name: "記録されたか確かめる" })
    expect(check).toBeDisabled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(screen.getByText(/応答を待っています/)).toBeInTheDocument()
    // 送り直しは列で待たされるゆえ押せぬまま、照合だけ先に使える
    expect(screen.getByRole("button", { name: /記録中/ })).toBeDisabled()
    expect(check).not.toBeDisabled()
    fireEvent.click(check)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(onLogRecorded).toHaveBeenCalledTimes(1)
    expect((onLogRecorded.mock.calls[0][0] as BabyLogData).id).toBe(db.rows[0].id)
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("記録済みでした"))
  })
})

describe("応答不明の間に内容を変えようとする（AC05）", () => {
  it("確認するまで左右の時間・回数を変えられず、新しい id で登録し直さぬ", async () => {
    renderTimer()
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
    await flushServerSample()
    actionHooks.loseNextResponse = 1
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(db.rows).toHaveLength(1))
    await waitFor(() => expect(primaryButton(/もう一度送る|記録する/)).not.toBeDisabled())

    // 応答不明の間は入力を出さぬ（変えると「同じ操作の再送」ではなくなる）。送った内容は見せる
    expect(screen.queryByLabelText("左の分")).toBeNull()
    expect(screen.queryByRole("button", { name: "右から" })).toBeNull()
    expect(screen.getByText(/保存できたか確認できていません/)).toBeInTheDocument()
    expect(screen.getByText("送った内容: 13:00 開始・左から・左1回5分")).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("別の内容"))
    // 「内容を直す」は照合で見つからなんだ後の明確な操作としてだけ出す
    expect(screen.queryByRole("button", { name: "内容を直して記録し直す" })).toBeNull()
  })

  it("照合で見つかれば送り直さず、サーバの確定行で記録済みとして終える", async () => {
    const { onLogRecorded } = renderTimer()
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
    await flushServerSample()
    actionHooks.loseNextResponse = 1
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(db.rows).toHaveLength(1))
    await waitFor(() => expect(primaryButton(/もう一度送る/)).not.toBeDisabled())

    fireEvent.click(screen.getByRole("button", { name: "記録されたか確かめる" }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(sentPayloads).toHaveLength(1)
    expect((onLogRecorded.mock.calls[0][0] as BabyLogData).updated_at).toBe(db.rows[0].updated_at)
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("記録済みでした"))
  })

  it("要求が届かなかった（照合で見つからぬ）なら、確認の後に内容を直して同じ id で記録できる（AC04）", async () => {
    const { onLogRecorded } = renderTimer()
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
    await flushServerSample()
    // 要求が DB に届く前に通信が切れた
    getAuthContext.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(primaryButton(/もう一度送る/)).not.toBeDisabled())
    expect(db.rows).toHaveLength(0)
    // 失敗を保存済みと表示せぬ
    expect(onLogRecorded).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "記録されたか確かめる" }))
    fireEvent.click(await screen.findByRole("button", { name: "内容を直して記録し直す" }))
    // 入力が戻る（左の分を 7 へ直す）
    fireEvent.change(screen.getByLabelText("左の分"), { target: { value: "7" } })
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ breast_left_sec: 420 })
    // 同じ計測の記録ゆえ id は同じ
    expect(sentPayloads[1].clientId).toBe(sentPayloads[0].clientId)
  })

  it("照合の後に直して 20 分後に押しても、開始時刻は最初の押下のまま（作り直さぬ。v7 N3-02）", async () => {
    const { onLogRecorded } = renderTimer()
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
    await flushServerSample()
    const firstPressed = new Date().toISOString()
    getAuthContext.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(primaryButton(/もう一度送る/)).not.toBeDisabled())

    advance(20 * 60_000)
    fireEvent.click(screen.getByRole("button", { name: "記録されたか確かめる" }))
    fireEvent.click(await screen.findByRole("button", { name: "内容を直して記録し直す" }))
    fireEvent.change(screen.getByLabelText("左の分"), { target: { value: "7" } })
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(sentPayloads[0].loggedAt).toBe(firstPressed)
    expect(sentPayloads[1].loggedAt).toBe(firstPressed)
    expect(new Date(String(db.rows[0].logged_at)).toISOString()).toBe(firstPressed)
  })

  it("結果不明の後の送り直しがログイン切れで拒まれても、固定した内容を捨てず、次も同じ内容で 1 行（v7 F1）", async () => {
    const { onLogRecorded, onOpenChange } = renderTimer()
    fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
    await flushServerSample()
    // 1 回目: DB に保存した後で応答だけ失う
    actionHooks.loseNextResponse = 1
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(db.rows).toHaveLength(1))
    await waitFor(() => expect(primaryButton(/もう一度送る/)).not.toBeDisabled())

    // 2 回目: 90 秒後の送り直しがログイン切れで拒まれる（先の送信が保存されておらぬ証拠ではない）
    advance(90_000)
    getAuthContext.mockResolvedValueOnce({
      error: "認証されていません",
      reason: "unauthenticated",
      context: null,
    })
    fireEvent.click(primaryButton(/もう一度送る/))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("認証されていません（前の送信が保存されたかは"),
      ),
    )
    // 固定した内容は残り、入力へは戻らぬ（時刻・秒数を作り直させぬ）
    await waitFor(() => expect(primaryButton(/もう一度送る/)).not.toBeDisabled())
    expect(screen.queryByLabelText("左の分")).toBeNull()
    const saved = JSON.parse(localStorage.getItem("irori:feeding-timer") ?? "null")
    expect(saved?.submission?.phase).toBe("unknown")

    // 3 回目: 同じ内容で送り直し → 先の行を認識（1 行・二重にならぬ・別の内容の衝突にもならぬ）
    advance(60_000)
    fireEvent.click(primaryButton(/もう一度送る/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(db.rows).toHaveLength(1)
    expect(sentPayloads[2]).toEqual(sentPayloads[0])
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("別の内容"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
