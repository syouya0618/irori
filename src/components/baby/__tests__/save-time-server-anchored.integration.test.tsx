/**
 * 記録時刻はサーバの時計で確定する（2026-10-28 製品判断 N3）。
 *
 * 端末の時計が ±5 分・±10 分ずれた端末で、クイック記録（ミルク・おむつ）と母乳の手動記録を、
 * 本物の部品・本物の Server Action（recordFeeding / recordDiaper / insertBabyLog）・主キー重複を持つ
 * 保存先（fake-baby-logs-db）を繋いで確かめる。
 *
 * **同じプロセスに時計が 1 つしか無い罠**: `vi.setSystemTime` で端末をずらすと、Server Action の
 * `validateLogTime` も同じ `Date` を読み、時計のずれが見えなくなる。ゆえに Action はサーバの時計へ
 * 切り替えてから走らせ、終わったら端末の時計へ戻す（`onServerClock`）。保存先の `now()` もサーバの
 * 時計に結ぶ。経過の時計（performance.now）は端末の壁時計と別に進める — 時計の変更（壁時計だけが
 * 跳ぶ）とスリープ（経過の時計が止まりうる）を分けて起こすため。
 *
 * 守る契約:
 * - クイック記録は時刻を送らず、DB が受け取った時刻（now()）で 1 行。時計の進んだ端末でも拒まれず、
 *   遅れた端末でも誤った時刻を残さぬ
 * - 母乳の手動記録は「記録する」を最初に押した実時刻（サーバ時刻のサンプル + 経過の時計で補正）。
 *   5 分を遡らせぬ。補正できぬ時は時刻を送らず、サーバの受信時刻へ退化してそう伝える
 * - 応答だけを失った保存を 90 秒後・再読込の後に送り直しても、同じ id・同じ内容・1 行、初回の時刻
 * - 初回が DB に届いておらねば、送り直した時の受信時刻で記録し、それを押した時刻と偽らぬ
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
  return {
    toast: { error: viMod.fn(), success: viMod.fn(), info: viMod.fn(), dismiss: viMod.fn() },
  }
})

// ---- 2 つの時計 -------------------------------------------------------------------------------
// trueMs: 本当の時刻（= サーバ・DB の時計）。端末の壁時計は trueMs + skewMs。
// monoMs: 端末の経過の時計（performance.now）。ふだんは trueMs と一緒に進む。
const clock = { trueMs: 0, skewMs: 0, monoMs: 1_000 }
function syncDevice() {
  vi.setSystemTime(new Date(clock.trueMs + clock.skewMs))
}
/** 時が流れる（本当の時刻・端末の壁時計・経過の時計がそろって進む） */
function advance(ms: number) {
  act(() => {
    clock.trueMs += ms
    clock.monoMs += ms
    syncDevice()
  })
}
/** 端末の時計を利用者が変えた（壁時計だけが跳ぶ。本当の時刻も経過の時計も変わらぬ） */
function changeDeviceClock(deltaMs: number) {
  act(() => {
    clock.skewMs += deltaMs
    syncDevice()
  })
}
/** 端末が眠った（本当の時刻と壁時計は進むが、経過の時計は止まる — iOS の performance.now） */
function sleepDevice(ms: number) {
  act(() => {
    clock.trueMs += ms
    syncDevice()
  })
}
async function onServerClock<T>(fn: () => Promise<T>): Promise<T> {
  vi.setSystemTime(new Date(clock.trueMs))
  try {
    return await fn()
  } finally {
    syncDevice()
  }
}

// ---- 本物の Server Action に、到達しない・応答だけ失う、を差し込む ------------------------------
const hooks = { dropNextRequest: 0, loseNextResponse: 0 }
const sent: Array<{ action: string; input: Record<string, unknown> }> = []
vi.mock("@/app/(main)/baby/actions", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/(main)/baby/actions")>()
  function wrap<I, R>(name: string, fn: (input: I) => Promise<R>) {
    return async (input: I): Promise<R> => {
      sent.push({ action: name, input: structuredClone(input) as Record<string, unknown> })
      if (hooks.dropNextRequest > 0) {
        // サーバに届かなかった（DB には何も書かれぬ）。クライアントからは応答の喪失と区別できぬ
        hooks.dropNextRequest -= 1
        throw new TypeError("Failed to fetch")
      }
      const result = await onServerClock(() => fn(input))
      if (hooks.loseNextResponse > 0) {
        hooks.loseNextResponse -= 1
        throw new TypeError("Failed to fetch")
      }
      return result
    }
  }
  return {
    ...real,
    recordFeeding: wrap("recordFeeding", real.recordFeeding),
    recordDiaper: wrap("recordDiaper", real.recordDiaper),
  }
})

import { BabyQuickActions } from "../baby-quick-actions"
import { FeedingTimer } from "../feeding-timer"
import { PendingSavesNotice } from "../pending-saves-notice"
import { GET as lookupGET } from "@/app/api/baby-logs/lookup/route"
import { createFakeBabyLogsDb, type FakeBabyLogsDb } from "@/test-utils/fake-baby-logs-db"
import { toast } from "sonner"
import { formatTimeJst, toJstDateString } from "@/lib/utils/date-jst"
import { readPersistedTimer, writePersistedTimer } from "@/lib/domain/feeding-timer-storage"
import type { BabyLogData } from "@/lib/types/baby"
import type { BottleDefaultController } from "@/lib/hooks/use-bottle-default"

const HOUSEHOLD = "house-1"
const USER = "user-1"
// JST 13:00（日跨ぎの影響を受けない日中）
const T0 = Date.parse("2026-07-19T04:00:00.000Z")
const MIN = 60_000

let db: FakeBabyLogsDb
const net = { versionDown: false, versionCalls: 0, rttMs: 200 }

function rowTimeMs(row: Record<string, unknown>): number {
  return Date.parse(String(row.logged_at))
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
  sent.length = 0
  hooks.dropNextRequest = 0
  hooks.loseNextResponse = 0
  net.versionDown = false
  net.versionCalls = 0
  net.rttMs = 200
  clock.trueMs = T0
  clock.skewMs = 0
  clock.monoMs = 1_000
  vi.useFakeTimers({ now: T0, toFake: ["Date"] })
  vi.spyOn(performance, "now").mockImplementation(() => clock.monoMs)
  db = createFakeBabyLogsDb({ now: () => new Date(clock.trueMs), householdId: HOUSEHOLD })
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: db.client, userId: USER, householdId: HOUSEHOLD },
  })
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost")
    if (url.pathname === "/api/version") {
      net.versionCalls += 1
      if (net.versionDown) throw new TypeError("Failed to fetch")
      // 往復の半分で要求が届き、サーバがその時の時刻を答え、残り半分で応答が返る
      clock.trueMs += net.rttMs / 2
      clock.monoMs += net.rttMs / 2
      const serverTime = clock.trueMs
      clock.trueMs += net.rttMs / 2
      clock.monoMs += net.rttMs / 2
      syncDevice()
      return Response.json(
        { buildId: "dev", releaseName: "test", serverTime },
        { headers: { "Cache-Control": "no-store" } },
      )
    }
    if (url.pathname === "/api/baby-logs/lookup") {
      return onServerClock(() => lookupGET(new Request(url)))
    }
    throw new Error(`unexpected fetch ${url.pathname}`)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---- クイック記録 ---------------------------------------------------------------------------

function bottleSet(amountMl = 160): BottleDefaultController {
  return { state: { status: "set", amountMl }, refetch: vi.fn(async () => null), apply: vi.fn() }
}

function renderQuick(onLogRecorded = vi.fn()) {
  const utils = render(
    <BabyQuickActions
      bottleDefault={bottleSet()}
      userId={USER}
      householdId={HOUSEHOLD}
      onCreateLog={() => {}}
      onStartTimer={() => {}}
      onCreateFeeding={() => {}}
      onLogRecorded={onLogRecorded}
    />,
  )
  return { ...utils, onLogRecorded }
}

async function pressWhenEnabled(name: string | RegExp) {
  const button = screen.getByRole("button", { name })
  await waitFor(() => expect(button).not.toBeDisabled())
  fireEvent.click(button)
}

describe("クイック記録: 端末の時計が ±5 分・±10 分ずれても、サーバの時刻で 1 行（N3-a）", () => {
  it.each([
    ["+5 分", 5 * MIN],
    ["+5 分 1 秒", 5 * MIN + 1_000],
    ["+10 分", 10 * MIN],
    ["-5 分", -5 * MIN],
    ["-10 分", -10 * MIN],
  ])("ミルク（端末 %s）: 拒まれず、DB が受け取った時刻で記録し、画面も同じ時刻", async (_label, skew) => {
    changeDeviceClock(skew)
    const { onLogRecorded } = renderQuick()
    const pressedTrueMs = clock.trueMs
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))

    expect(toast.error).not.toHaveBeenCalled()
    expect(db.rows).toHaveLength(1)
    expect(rowTimeMs(db.rows[0])).toBe(pressedTrueMs)
    expect(db.rows[0]).toMatchObject({ feeding_type: "bottle", amount_ml: 160 })
    // 端末の時計で時刻を作って送らぬ（DB の now() に任せる）
    expect(sent[0].input.loggedAt).toBeUndefined()
    const shown = onLogRecorded.mock.calls[0][0] as BabyLogData
    expect(Date.parse(shown.logged_at)).toBe(pressedTrueMs)
    expect(shown.updated_at).toBe(db.rows[0].updated_at)
  })

  it.each([
    ["+10 分", 10 * MIN],
    ["-10 分", -10 * MIN],
  ])("おしっこ（端末 %s）: 拒まれず、DB が受け取った時刻で 1 行", async (_label, skew) => {
    changeDeviceClock(skew)
    const { onLogRecorded } = renderQuick()
    const pressedTrueMs = clock.trueMs
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(toast.error).not.toHaveBeenCalled()
    expect(db.rows).toHaveLength(1)
    expect(rowTimeMs(db.rows[0])).toBe(pressedTrueMs)
    expect(db.rows[0]).toMatchObject({ log_type: "diaper", diaper_type: "pee" })
  })
})

describe("クイック記録: 保存の後で応答だけ失い、90 秒後・再読込の後に押し直す（N3-c）", () => {
  it("端末 +10 分でも、同じ id・同じ内容で 1 行、初回の受信時刻のまま、記録済みと認識する", async () => {
    changeDeviceClock(10 * MIN)
    const { onLogRecorded } = renderQuick()
    const firstTrueMs = clock.trueMs
    hooks.loseNextResponse = 1
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(db.rows).toHaveLength(1))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("保存できたか確認できていません")),
    )
    expect(onLogRecorded).not.toHaveBeenCalled()

    advance(90_000)
    await pressWhenEnabled("ミルク")
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))

    expect(db.rows).toHaveLength(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].input).toEqual(sent[0].input)
    expect(rowTimeMs(db.rows[0])).toBe(firstTrueMs)
    const shown = onLogRecorded.mock.calls[0][0] as BabyLogData
    expect(shown.id).toBe(db.rows[0].id)
    expect(Date.parse(shown.logged_at)).toBe(firstTrueMs)
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("記録済みでした"))
  })

  it("再読込（作り直し）を挟んでも、同じ id・同じ内容で 1 行、初回の受信時刻のまま", async () => {
    changeDeviceClock(-10 * MIN)
    const first = renderQuick()
    const firstTrueMs = clock.trueMs
    hooks.loseNextResponse = 1
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(db.rows).toHaveLength(1))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    first.unmount()

    advance(90_000)
    const { onLogRecorded } = renderQuick()
    await pressWhenEnabled("おしっこ")
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(db.rows).toHaveLength(1)
    expect(sent[1].input).toEqual(sent[0].input)
    expect(rowTimeMs(db.rows[0])).toBe(firstTrueMs)
  })
})

describe("クイック記録: 初回が DB に届いておらぬ（N3-d）", () => {
  it("90 秒後の押し直しは届いた時刻で 1 行を記録し、押した時刻とは偽らず、その時刻を伝える", async () => {
    const { onLogRecorded } = renderQuick()
    hooks.dropNextRequest = 1
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("保存できたか確認できていません")),
    )
    expect(db.rows).toHaveLength(0)

    advance(90_000)
    const retryTrueMs = clock.trueMs
    await pressWhenEnabled("ミルク")
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))

    expect(db.rows).toHaveLength(1)
    // 同じ操作（同じ id）で、新しい id の二重記録にはせぬ
    expect(sent[1].input).toEqual(sent[0].input)
    expect(db.rows[0].id).toBe(sent[0].input.clientId)
    expect(rowTimeMs(db.rows[0])).toBe(retryTrueMs)
    // 「押した時刻」とは言わず、届いた時刻（DB の時刻）を伝え、直す道を示す
    const message = vi.mocked(toast.success).mock.calls.at(-1)?.[0]
    expect(String(message)).toContain("届いた時刻")
    expect(String(message)).toContain(formatTimeJst(new Date(retryTrueMs).toISOString()))
  })
})

describe("クイック記録: 再読込の後、「保存を確認中の記録」から送り直す（N3-c / N3-d）", () => {
  it("初回が届かず、5 分後に一覧から送り直すと、届いた時刻で 1 行・その時刻と直し方を伝える", async () => {
    const first = renderQuick()
    hooks.dropNextRequest = 1
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    first.unmount()

    advance(5 * MIN)
    const resendTrueMs = clock.trueMs
    const onConfirmed = vi.fn()
    render(
      <PendingSavesNotice owner={{ userId: USER, householdId: HOUSEHOLD }} onConfirmed={onConfirmed} />,
    )
    // 押した時刻で記録されるとは言わず、届いておらねば送り直した時刻になると先に示す
    expect(await screen.findByText(/送り直した時刻で記録されます/)).toBeInTheDocument()
    await pressWhenEnabled("同じ内容でもう一度送る")
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1))

    expect(db.rows).toHaveLength(1)
    expect(sent[1].input).toEqual(sent[0].input)
    expect(rowTimeMs(db.rows[0])).toBe(resendTrueMs)
    const message = String(vi.mocked(toast.success).mock.calls.at(-1)?.[0])
    expect(message).toContain("届いた時刻")
    expect(message).toContain(formatTimeJst(new Date(resendTrueMs).toISOString()))
  })

  it("対照: 初回が届いておれば、5 分後の一覧の照合は初回の行（初回の時刻）を認識し、書かぬ", async () => {
    const first = renderQuick()
    const firstTrueMs = clock.trueMs
    hooks.loseNextResponse = 1
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    first.unmount()

    advance(5 * MIN)
    const onConfirmed = vi.fn()
    render(
      <PendingSavesNotice owner={{ userId: USER, householdId: HOUSEHOLD }} onConfirmed={onConfirmed} />,
    )
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1))
    expect(sent).toHaveLength(1)
    expect(db.rows).toHaveLength(1)
    expect(Date.parse((onConfirmed.mock.calls[0][0] as BabyLogData).logged_at)).toBe(firstTrueMs)
  })
})

describe("クイック記録: JST の日跨ぎと時計のずれ（N3-e）", () => {
  it("本当は 23:59:30 JST・端末は +10 分（翌日 00:09）でも、記録はその日（23:59）の行", async () => {
    clock.trueMs = Date.parse("2026-07-19T14:59:30.000Z") // JST 2026-07-19 23:59:30
    changeDeviceClock(10 * MIN)
    const { onLogRecorded } = renderQuick()
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    const shown = onLogRecorded.mock.calls[0][0] as BabyLogData
    expect(toJstDateString(shown.logged_at)).toBe("2026-07-19")
    expect(formatTimeJst(shown.logged_at)).toBe("23:59")
  })

  it("本当は 00:01 JST・端末は -10 分（前日 23:51）でも、記録は新しい日の行", async () => {
    clock.trueMs = Date.parse("2026-07-19T15:01:00.000Z") // JST 2026-07-20 00:01
    changeDeviceClock(-10 * MIN)
    const { onLogRecorded } = renderQuick()
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    const shown = onLogRecorded.mock.calls[0][0] as BabyLogData
    expect(toJstDateString(shown.logged_at)).toBe("2026-07-20")
  })
})

// ---- 母乳の手動記録 -------------------------------------------------------------------------

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

function primaryButton(name: RegExp) {
  return screen.getByRole("button", { name })
}

/** シートを開き、サーバ時刻のサンプルが（あれば）届くのを待ってから手動入力へ切り替える */
async function openManual() {
  const utils = renderTimer()
  // 開いた時のサンプルの取得を落ち着かせる（実の setTimeout で microtask を全て流す）
  await waitFor(() => expect(net.versionCalls).toBeGreaterThanOrEqual(1))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  fireEvent.click(screen.getByRole("button", { name: "手動入力" }))
  return utils
}

describe("母乳の手動記録: 開いて 90 秒後、最初の押下の実時刻が開始（N3-b）", () => {
  it.each([
    ["±0", 0],
    ["+10 分", 10 * MIN],
    ["-10 分", -10 * MIN],
    ["+5 分 1 秒", 5 * MIN + 1_000],
  ])("端末 %s: 開始時刻は押した実時刻（5 分を遡らせぬ）、左 5 分、1 行", async (_label, skew) => {
    changeDeviceClock(skew)
    const { onLogRecorded } = await openManual()
    advance(90_000)
    const pressedTrueMs = clock.trueMs
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))

    expect(toast.error).not.toHaveBeenCalled()
    expect(db.rows).toHaveLength(1)
    // 受信時刻への退化ではなく、押した時刻をサーバの時計で推定して送った
    expect(sent[0].input.loggedAt).toEqual(expect.any(String))
    // サーバ時刻のサンプルの往復の半分（100ms）以内
    expect(Math.abs(rowTimeMs(db.rows[0]) - pressedTrueMs)).toBeLessThanOrEqual(net.rttMs / 2)
    expect(db.rows[0]).toMatchObject({
      feeding_type: "breast",
      breast_left_sec: 300,
      breast_right_sec: 0,
      duration_sec: 300,
    })
    const shown = onLogRecorded.mock.calls[0][0] as BabyLogData
    expect(shown.logged_at).toBe(db.rows[0].logged_at)
  })

  it("サーバ時刻を得られぬ（圏外・取得失敗）なら時刻を送らず、DB の受信時刻で記録してそう伝える", async () => {
    net.versionDown = true
    changeDeviceClock(10 * MIN)
    const { onLogRecorded } = await openManual()
    advance(90_000)
    const pressedTrueMs = clock.trueMs
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(sent[0].input.loggedAt).toBeUndefined()
    expect(rowTimeMs(db.rows[0])).toBe(pressedTrueMs)
    const message = String(vi.mocked(toast.success).mock.calls.at(-1)?.[0])
    expect(message).toContain("届いた時刻")
  })

  it("開いた後に端末の時計を変えたら、古いサンプルを使わず（変えた時計の時刻も使わず）受信時刻へ退化", async () => {
    const { onLogRecorded } = await openManual()
    advance(30_000)
    changeDeviceClock(10 * MIN)
    advance(60_000)
    const pressedTrueMs = clock.trueMs
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    // どちらの時計が正しいか決めつけず、サンプルを捨てて時刻を送らぬ
    expect(sent[0].input.loggedAt).toBeUndefined()
    expect(rowTimeMs(db.rows[0])).toBe(pressedTrueMs)
  })

  it("端末が眠って経過の時計が止まったら、そのサンプルは使わず受信時刻へ退化（10 分ずれた時刻を作らぬ）", async () => {
    const { onLogRecorded } = await openManual()
    sleepDevice(10 * MIN)
    const pressedTrueMs = clock.trueMs
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(sent[0].input.loggedAt).toBeUndefined()
    expect(rowTimeMs(db.rows[0])).toBe(pressedTrueMs)
    expect(String(vi.mocked(toast.success).mock.calls.at(-1)?.[0])).toContain("届いた時刻")
  })

  it("画面へ戻った時（visibilitychange）にサンプルを取り直し、眠った後でも押した時刻で送る", async () => {
    const { onLogRecorded } = await openManual()
    sleepDevice(10 * MIN)
    const before = net.versionCalls
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await waitFor(() => expect(net.versionCalls).toBe(before + 1))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    advance(30_000)
    const pressedTrueMs = clock.trueMs
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(sent[0].input.loggedAt).toEqual(expect.any(String))
    expect(Math.abs(rowTimeMs(db.rows[0]) - pressedTrueMs)).toBeLessThanOrEqual(net.rttMs / 2)
  })
})

describe("母乳の手動記録: 応答だけ失い、90 秒後・再読込の後に送り直す（N3-c）", () => {
  it("端末 +10 分: 同じ id・同じ開始時刻・同じ左右秒で 1 行、確定値で記録済みと認識する", async () => {
    changeDeviceClock(10 * MIN)
    const { onLogRecorded } = await openManual()
    advance(90_000)
    const pressedTrueMs = clock.trueMs
    hooks.loseNextResponse = 1
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(db.rows).toHaveLength(1))
    await waitFor(() => expect(primaryButton(/もう一度送る|記録する/)).not.toBeDisabled())
    expect(onLogRecorded).not.toHaveBeenCalled()

    advance(90_000)
    fireEvent.click(primaryButton(/もう一度送る|記録する/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(db.rows).toHaveLength(1)
    expect(sent[1].input).toEqual(sent[0].input)
    expect(sent[0].input.loggedAt).toEqual(expect.any(String))
    expect(Math.abs(rowTimeMs(db.rows[0]) - pressedTrueMs)).toBeLessThanOrEqual(net.rttMs / 2)
    const shown = onLogRecorded.mock.calls[0][0] as BabyLogData
    expect(shown.id).toBe(db.rows[0].id)
    expect(shown.updated_at).toBe(db.rows[0].updated_at)
  })

  it("保存済みで応答を失った後の再読込は、照合の読みで DB の確定行を認識する（送り直さず 1 行）", async () => {
    changeDeviceClock(-10 * MIN)
    const first = await openManual()
    advance(90_000)
    const pressedTrueMs = clock.trueMs
    hooks.loseNextResponse = 1
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(db.rows).toHaveLength(1))
    await waitFor(() => expect(primaryButton(/もう一度送る|記録する/)).not.toBeDisabled())
    first.unmount()

    advance(10 * MIN)
    const { onLogRecorded } = renderTimer()
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(sent).toHaveLength(1)
    expect(db.rows).toHaveLength(1)
    const shown = onLogRecorded.mock.calls[0][0] as BabyLogData
    expect(shown.id).toBe(db.rows[0].id)
    expect(shown.logged_at).toBe(db.rows[0].logged_at)
    expect(Math.abs(rowTimeMs(db.rows[0]) - pressedTrueMs)).toBeLessThanOrEqual(net.rttMs / 2)
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("記録済みでした"))
  })

  it("初回が届かぬまま再読込し、送り直すと、端末に固定した押下時刻・同じ内容で 1 行", async () => {
    changeDeviceClock(10 * MIN)
    const first = await openManual()
    advance(90_000)
    const pressedTrueMs = clock.trueMs
    hooks.dropNextRequest = 1
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(primaryButton(/もう一度送る|記録する/)).not.toBeDisabled())
    expect(db.rows).toHaveLength(0)
    first.unmount()

    advance(10 * MIN)
    const { onLogRecorded } = renderTimer()
    // 再読込の照合の読みは「まだ見つからぬ」（保存されなかったとは断定せぬ）
    await waitFor(() => expect(screen.getByRole("button", { name: /もう一度送る/ })).not.toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: /もう一度送る/ }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(db.rows).toHaveLength(1)
    expect(sent[1].input).toEqual(sent[0].input)
    // 送り直した時刻（10 分後）ではなく、最初に押した時刻
    expect(Math.abs(rowTimeMs(db.rows[0]) - pressedTrueMs)).toBeLessThanOrEqual(net.rttMs / 2)
  })

  it("初回が届かず、補正できた開始時刻は送り直しでも押した時刻のまま（送り直した時刻にせぬ）", async () => {
    const { onLogRecorded } = await openManual()
    advance(90_000)
    const pressedTrueMs = clock.trueMs
    hooks.dropNextRequest = 1
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(primaryButton(/もう一度送る|記録する/)).not.toBeDisabled())
    expect(db.rows).toHaveLength(0)

    advance(90_000)
    fireEvent.click(primaryButton(/もう一度送る|記録する/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(db.rows).toHaveLength(1)
    expect(Math.abs(rowTimeMs(db.rows[0]) - pressedTrueMs)).toBeLessThanOrEqual(net.rttMs / 2)
  })

  it("本当は 23:59 JST・端末 +10 分で押した手動記録は、その日の 23:59 開始の行", async () => {
    clock.trueMs = Date.parse("2026-07-19T14:57:00.000Z") // JST 23:57
    changeDeviceClock(10 * MIN)
    const { onLogRecorded } = await openManual()
    advance(2 * MIN) // JST 23:59
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    const shown = onLogRecorded.mock.calls[0][0] as BabyLogData
    expect(toJstDateString(shown.logged_at)).toBe("2026-07-19")
    expect(formatTimeJst(shown.logged_at)).toBe("23:59")
  })
})

// ---- 走っておるタイマーの停止（独立レビュー v7 N3-01） ------------------------------------------
//
// タイマーの開始は端末の時計で測る（経過の表示・停め忘れの判定・端末保存の形は変えぬ）。停めて送る
// 開始時刻だけを、停めた時のサーバ時刻のサンプルで端末の時計のずれ分だけ写す（± に同じく効く =
// 対称。誤差は往復の半分と時計の食い違いの 2 秒以内 = 有界。validateLogTime の 5 分は変えぬ）。
// サンプルが使えぬ時は従来どおり端末の開始時刻を送る（進んだ時計は見える拒否、遅れた時計は従来の
// ずれ）。停め忘れ（手動入力で開始時刻を保つ経路）は画面が端末の時刻で約束しておるゆえ変えぬ。

/**
 * タイマーを開き（開いた瞬間に開始）、サーバ時刻のサンプルが届くのを待つ。開始の時刻は端末保存の
 * startedAt（端末の時計）から読み、本当の開始はそこから今のずれを引く — この harness の fetch は
 * 往復ぶんの時計を同期で進め、サンプルの取得の effect がタイマーの開始の effect より先に走るゆえ、
 * render の前の時刻は開始の時刻ではない
 */
async function openTimer() {
  const utils = renderTimer()
  await waitFor(() => expect(net.versionCalls).toBeGreaterThanOrEqual(1))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const persisted = readPersistedTimer()
  expect(persisted).not.toBeNull()
  const startDeviceMs = Date.parse(persisted!.startedAt)
  const startTrueMs = startDeviceMs - clock.skewMs
  return { ...utils, startTrueMs, startDeviceMs }
}

function stopButton() {
  return screen.getByRole("button", { name: /停止して記録|もう一度送る/ })
}

describe("走っておるタイマーの停止: 開始時刻は端末の時計のずれを写す（N3-01）", () => {
  it.each([
    ["±0", 0],
    ["+10 分", 10 * MIN],
    ["-10 分", -10 * MIN],
    ["+5 分 1 秒", 5 * MIN + 1_000],
  ])("端末 %s: 3 分で停めても拒まれず、開始時刻は本当の開始（往復の半分以内）、左 3 分、1 行", async (_label, skew) => {
    changeDeviceClock(skew)
    const { onLogRecorded, startTrueMs } = await openTimer()
    advance(3 * MIN)
    fireEvent.click(stopButton())
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))

    expect(toast.error).not.toHaveBeenCalled()
    expect(db.rows).toHaveLength(1)
    expect(Math.abs(rowTimeMs(db.rows[0]) - startTrueMs)).toBeLessThanOrEqual(net.rttMs / 2)
    // 授乳時間は端末の経過で測る（ずれの影響を受けぬ）
    expect(db.rows[0]).toMatchObject({ feeding_type: "breast", breast_right_sec: 0 })
    expect(Number(db.rows[0].breast_left_sec)).toBeGreaterThanOrEqual(3 * 60)
    expect(Number(db.rows[0].breast_left_sec)).toBeLessThanOrEqual(3 * 60 + 1)
  })

  it("サンプルが無い（圏外）時は従来どおり端末の開始時刻を送る（-10 分の端末は 10 分早い行 = 既知の限界）", async () => {
    net.versionDown = true
    changeDeviceClock(-10 * MIN)
    const { onLogRecorded, startDeviceMs } = await openTimer()
    advance(3 * MIN)
    fireEvent.click(stopButton())
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(Date.parse(String(sent[0].input.loggedAt))).toBe(startDeviceMs)
  })

  it("サンプルが無く +10 分の端末は、黙って誤った時刻を残さず、未来の時刻として見える形で拒まれる（既知の限界）", async () => {
    net.versionDown = true
    changeDeviceClock(10 * MIN)
    const { onLogRecorded } = await openTimer()
    advance(3 * MIN)
    fireEvent.click(stopButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(onLogRecorded).not.toHaveBeenCalled()
    expect(db.rows).toHaveLength(0)
  })

  it("サンプルの後に同じ画面で端末の時計を変えたら、写さず端末の開始時刻を送る（どちらの時計が正しいか決めつけぬ）", async () => {
    const { onLogRecorded, startDeviceMs } = await openTimer()
    advance(MIN)
    changeDeviceClock(10 * MIN)
    advance(2 * MIN)
    fireEvent.click(stopButton())
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(Date.parse(String(sent[0].input.loggedAt))).toBe(startDeviceMs)
  })

  it("+10 分の端末で応答だけ失い、90 秒後に送り直しても、写した開始時刻・同じ内容で 1 行（写し直さぬ）", async () => {
    changeDeviceClock(10 * MIN)
    const { onLogRecorded, startTrueMs } = await openTimer()
    advance(3 * MIN)
    hooks.loseNextResponse = 1
    fireEvent.click(stopButton())
    await waitFor(() => expect(db.rows).toHaveLength(1))
    await waitFor(() => expect(stopButton()).not.toBeDisabled())
    expect(onLogRecorded).not.toHaveBeenCalled()

    advance(90_000)
    fireEvent.click(stopButton())
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(db.rows).toHaveLength(1)
    expect(sent[1].input).toEqual(sent[0].input)
    expect(Math.abs(rowTimeMs(db.rows[0]) - startTrueMs)).toBeLessThanOrEqual(net.rttMs / 2)
  })
})

describe("停め忘れの記録は写さず、画面が約束した端末の開始時刻のまま（N3-01 の範囲外・v8）", () => {
  it("端末 -10 分・サンプルありでも、停め忘れの手動記録の開始時刻は端末保存の startedAt そのもの", async () => {
    changeDeviceClock(-10 * MIN)
    const first = await openTimer()
    first.unmount()
    // 3 時間前に始めて停め忘れた計測にする（端末の時計で）
    const persisted = readPersistedTimer()!
    const staleStartIso = new Date(first.startDeviceMs - 3 * 60 * MIN).toISOString()
    expect(writePersistedTimer({ ...persisted, startedAt: staleStartIso })).toBe(true)

    const { onLogRecorded } = renderTimer()
    await waitFor(() => expect(net.versionCalls).toBeGreaterThanOrEqual(2))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByText(/に始めた計測が残っています/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("左の分"), { target: { value: "10" } })
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(sent.at(-1)?.input.loggedAt).toBe(staleStartIso)
  })

  /** 停め忘れた計測を端末に作って開き直す（開始は端末の時計で 3 時間前） */
  async function reopenStale(): Promise<{ staleStartIso: string; onLogRecorded: ReturnType<typeof vi.fn> }> {
    const first = await openTimer()
    first.unmount()
    const persisted = readPersistedTimer()!
    const staleStartIso = new Date(first.startDeviceMs - 3 * 60 * MIN).toISOString()
    expect(writePersistedTimer({ ...persisted, startedAt: staleStartIso })).toBe(true)
    const before = net.versionCalls
    const { onLogRecorded } = renderTimer()
    if (!net.versionDown) await waitFor(() => expect(net.versionCalls).toBeGreaterThan(before))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByText(/に始めた計測が残っています/)).toBeInTheDocument()
    return { staleStartIso, onLogRecorded }
  }

  it.each([
    ["-10 分", -10 * MIN, /約10分遅れています/],
    ["+10 分", 10 * MIN, /約10分進んでいます/],
  ])("端末 %s（サンプルあり）: 開始時刻は書き換えず、端末の時計によるもので実際とずれうると伝え、直し方を示す（2026-10-28 製品判断）", async (_l, skew, words) => {
    changeDeviceClock(skew)
    const { staleStartIso, onLogRecorded } = await reopenStale()
    const note = screen.getByText(words)
    expect(note).toHaveTextContent(/この端末の時計で測ったため、実際とずれている可能性があります/)
    expect(note).toHaveTextContent(/記録を開いて開始時刻を直せます/)
    fireEvent.change(screen.getByLabelText("左の分"), { target: { value: "10" } })
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    // 推し量って写さぬ・今の時刻で押さぬ（端末保存の開始時刻のまま）
    expect(sent.at(-1)?.input.loggedAt).toBe(staleStartIso)
  })

  it("対照: 端末の時計がずれておらぬ（±0）時は注記を出さぬ", async () => {
    await reopenStale()
    expect(screen.queryByText(/この端末の時計は約/)).toBeNull()
  })

  it("サンプルが無い（圏外）時はずれを確かめられぬ — 「ずれておる」とも「正しい」とも言わず、開始時刻は端末のまま", async () => {
    changeDeviceClock(-10 * MIN)
    net.versionDown = true
    const { staleStartIso, onLogRecorded } = await reopenStale()
    expect(screen.queryByText(/この端末の時計は約/)).toBeNull()
    fireEvent.change(screen.getByLabelText("左の分"), { target: { value: "10" } })
    fireEvent.click(primaryButton(/^記録する$/))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(sent.at(-1)?.input.loggedAt).toBe(staleStartIso)
  })
})

describe("走っておるタイマー: 照合で見つからず内容を直した後の停止は、最初の停止の開始時刻を持ち越す（v8rc2 INFO・N3-02 の約束）", () => {
  it("+10 分の端末で停止の要求が届かず、直す間に端末の時計が変わっても、2 回目の停止は 1 回目に写した開始時刻のまま", async () => {
    changeDeviceClock(10 * MIN)
    const { onLogRecorded, startTrueMs } = await openTimer()
    advance(3 * MIN)
    hooks.dropNextRequest = 1
    fireEvent.click(stopButton())
    await waitFor(() => expect(stopButton()).not.toBeDisabled())
    expect(db.rows).toHaveLength(0)
    const firstLoggedAt = String(sent[0].input.loggedAt)
    expect(Math.abs(Date.parse(firstLoggedAt) - startTrueMs)).toBeLessThanOrEqual(net.rttMs / 2)

    fireEvent.click(screen.getByRole("button", { name: "記録されたか確かめる" }))
    fireEvent.click(await screen.findByRole("button", { name: "内容を直して記録し直す" }))
    // 直す間に端末の時計が変わった（サンプルはもう使えぬ。写し直すと端末の時刻 = 未来へ退く）
    changeDeviceClock(MIN)
    advance(MIN)
    fireEvent.click(screen.getByRole("button", { name: /停止して記録/ }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(sent.at(-1)?.input.loggedAt).toBe(firstLoggedAt)
    expect(sent.at(-1)?.input.clientId).toBe(sent[0].input.clientId)
    expect(db.rows).toHaveLength(1)
  })
})
