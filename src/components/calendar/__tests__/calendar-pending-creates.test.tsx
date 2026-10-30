/**
 * 予定の作成の「保存を確認中」の控え（2026-10-28 v9 / AC28）。v8 の 1 枠の下書きの根（T2・P-B・N1）を、
 * 作成ごとの控え（clientId ごと・送信内容は凍結・状態は単調）で直したことを、**本物の Server Action
 * （createCalendarEvent）** と主キー・世帯の絞りを持つ fake DB を繋いで確かめる。成功を返すだけの mock
 * にはせぬ — 応答だけが失われた作成の行は DB に残り、送り直しは本物の照合（replayed / conflict）を通る。
 *
 * 主張は観測できる状態に置く: DB の行の数・送った clientId の並び・端末に残った値・画面の文言。
 * 再読込は「CalendarView を unmount → 同じ localStorage のまま render し直す」で模す。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react"
import { createFakeCalendarDb, type FakeCalendarDb } from "@/test-utils/fake-calendar-db"

const env = vi.hoisted(() => ({
  db: null as unknown as FakeCalendarDb,
  /** 次の作成の送信の通信の結果（先頭から使う。無ければ ok）。hold = release() を呼ぶまで応答を返さぬ */
  sends: [] as Array<"ok" | "lose-response" | "offline" | "hold" | "hold-lose-response">,
  release: () => {},
  /** 月の読み（画面の取り直し）が通るか */
  readsOk: false,
  /** サーバが見る利用者（null = ログイン切れ） */
  session: { userId: "user-1", householdId: "house-1" } as { userId: string; householdId: string } | null,
}))

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: async () =>
    env.session
      ? {
          error: null,
          reason: null,
          context: {
            supabase: env.db.serverClient(env.session.householdId),
            userId: env.session.userId,
            householdId: env.session.householdId,
          },
        }
      : { error: "認証されていません", reason: "unauthenticated", context: null },
}))
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const real = env.db.browserClient() as { from: (t: string) => unknown }
    return {
      ...real,
      from: (t: string) => {
        if (env.readsOk) return real.from(t)
        // 圏外・ログイン切れの間の取り直しは失敗する（行が在っても画面には出ぬ）
        const fail = { data: null, error: { message: "Failed to fetch", code: "" } }
        const chain: Record<string, unknown> = {}
        for (const k of ["select", "eq", "lte", "gte", "order"]) chain[k] = () => chain
        chain.abortSignal = () => Promise.resolve(fail)
        return chain
      },
    }
  },
}))
vi.mock("@/app/(main)/calendar/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/(main)/calendar/actions")>()
  const { vi: viMod } = await import("vitest")
  return {
    ...actual,
    createCalendarEvent: viMod.fn(async (input: Parameters<typeof actual.createCalendarEvent>[0]) => {
      const mode = env.sends.shift() ?? "ok"
      if (mode === "offline") throw new TypeError("Failed to fetch")
      if (mode === "hold" || mode === "hold-lose-response") await new Promise<void>((resolve) => (env.release = resolve))
      const res = await actual.createCalendarEvent(input)
      // 書けた後に応答だけが失われた（クライアントには例外にしか見えぬ）
      if (mode === "lose-response" || mode === "hold-lose-response") throw new TypeError("Failed to fetch")
      return res
    }),
    fetchGoogleSyncSignal: viMod.fn().mockResolvedValue({ lastSyncedAt: null }),
    fetchEventReminder: viMod.fn().mockResolvedValue({ error: null, row: null }),
    setEventReminder: viMod.fn().mockResolvedValue({ error: null, count: 1 }),
  }
})
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn(), warning: viMod.fn(), info: viMod.fn() } }
})

import { CalendarView } from "../calendar-view"
import { resetPendingCreatesPageStateForTest } from "../calendar-pending-creates"
import { CacheUserGuard } from "@/components/common/cache-user-guard"
import { createCalendarEvent } from "@/app/(main)/calendar/actions"
import { toast } from "sonner"
import { SAVE_RESEND_LABEL } from "@/lib/domain/save-attempt"
import type { CalendarEventRecord } from "../use-month-events"

const A = { userId: "user-1", householdId: "house-1" }
const B = { userId: "user-2", householdId: "house-2" }
const view = { monthFirst: "2026-07-01", selectedDate: "2026-07-15" }

function renderCalendar(owner = A, initialEvents: CalendarEventRecord[] = []) {
  return render(
    <CalendarView
      householdId={owner.householdId}
      userId={owner.userId}
      initialView={view}
      initialEvents={initialEvents}
    />,
  )
}

const openNew = () => fireEvent.click(screen.getByRole("button", { name: /^\d+月\d+日（.）に予定を追加$/ }))
const typeTitle = (title: string) => fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: title } })
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }))
const sentIds = () => vi.mocked(createCalendarEvent).mock.calls.map((c) => c[0].clientId)
const sentTitles = () => vi.mocked(createCalendarEvent).mock.calls.map((c) => c[0].title)
const rowsTitled = (title: string, owner = A) => env.db.rowsOf(owner.householdId).filter((r) => r.title === title)
/** 端末に残った全ての値（形を問わず、clientId や本文が残っておるかを見る） */
function storedText(): string {
  let out = ""
  for (let i = 0; i < localStorage.length; i++) out += `${localStorage.key(i)}=${localStorage.getItem(localStorage.key(i)!)}\n`
  return out
}
const pendingRegion = () => screen.getByRole("region", { name: "予定の追加の確認" })
const pendingItem = (title: string) =>
  within(pendingRegion()).getByText(title).closest("li") as HTMLElement

/** 新しい予定を打って「追加」（送信の結果は env.sends で決める） */
async function createEvent(title: string) {
  openNew()
  typeTitle(title)
  press("追加")
}

/** 結果不明の toast の「同じ内容でもう一度送る」を押す（n 番目の結果不明の toast） */
function pressToastResend(n = -1) {
  const calls = vi.mocked(toast.error).mock.calls.filter(
    (c) => (c[1] as { action?: { label?: string } } | undefined)?.action?.label === SAVE_RESEND_LABEL,
  )
  const opts = calls.at(n)![1] as unknown as { action: { onClick: () => void } }
  act(() => opts.action.onClick())
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
  // 試験の間の再読込（同じモジュールのまま）: このページの送信中・端末に書けなんだ控えも空にする
  resetPendingCreatesPageStateForTest()
  env.db = createFakeCalendarDb()
  env.sends = []
  env.readsOk = false
  env.session = { ...A }
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("T2: 結果不明の作成の送り直しがログイン切れで拒まれても、先の作成を「保存されておらぬ」と決めつけぬ", () => {
  it("同じ画面: 応答を失った作成 → ログイン切れの送り直し（rejected）→ 打ち直しても黙って新しい id で 2 件目を作らぬ", async () => {
    env.sends.push("lose-response")
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const xId = sentIds()[0]
    expect(rowsTitled("検診X")).toHaveLength(1) // 書けておる（応答だけが失われた）

    // ログインが切れた状態で送り直す → サーバは「この要求は書いておらぬ」（rejected）
    env.session = null
    pressToastResend()
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    expect(sentIds()[1]).toBe(xId)
    await act(async () => {})

    // 先の作成の手がかり（id）は端末に残る
    expect(storedText()).toContain(xId)

    // ログインし直し、画面の言うとおりに打ち直す（復元された入力があれば破棄して打ち直す）
    env.session = { ...A }
    openNew()
    const discard = screen.queryByRole("button", { name: "破棄" })
    if (discard) fireEvent.click(discard)
    typeTitle("検診X")
    press("追加")
    await act(async () => {})

    // 黙って新しい id で送らず、確かめられていない作成が在ると示す
    expect(sentIds().filter((id) => id !== xId)).toEqual([])
    expect(await screen.findByRole("alert")).toHaveTextContent("検診X")
    expect(rowsTitled("検診X")).toHaveLength(1)
  })

  it("再読込を挟む: 結果不明 → 再読込 → ログイン切れの送り直し → 再読込しても「確認中」のまま残り、ログインし直した送り直しは二重にせず保存済みと分かる", async () => {
    env.sends.push("lose-response")
    let ui = renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const xId = sentIds()[0]
    ui.unmount()

    ui = renderCalendar()
    expect(within(pendingItem("検診X")).getByText(/保存できたか確認できていません/)).toBeInTheDocument()
    env.session = null
    fireEvent.click(within(pendingItem("検診X")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    await act(async () => {})
    // 拒まれたことは伝えるが、先の作成を「保存できなかった」とは言わぬ
    const item = pendingItem("検診X")
    expect(item).toHaveTextContent(/認証されていません/)
    expect(item).toHaveTextContent(/保存できたか確認できていません/)
    expect(item).not.toHaveTextContent(/保存できませんでした/)
    ui.unmount()

    env.session = { ...A }
    renderCalendar()
    expect(pendingItem("検診X")).toHaveTextContent(/保存できたか確認できていません/)
    fireEvent.click(within(pendingItem("検診X")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(3))
    expect(sentIds()).toEqual([xId, xId, xId])
    await waitFor(() => expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull())
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/「検診X」は保存されていました/))
    expect(rowsTitled("検診X")).toHaveLength(1)
    expect(storedText()).not.toContain(xId)
  })
})

describe("P-B: 結果不明の作成が 2 件あっても、どちらも端末に残り、件ごとに確かめられる", () => {
  it("X と Y が両方とも結果不明のまま再読込 → 両方が残り、Y の解決は X を消さず、それぞれ同じ id で送り直せる", async () => {
    env.sends.push("lose-response", "lose-response")
    let ui = renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    await createEvent("面談Y")
    // X が確認中ゆえ、確かめてから別の予定として追加する
    fireEvent.click(await screen.findByRole("button", { name: "別の予定として追加" }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2))
    const [xId, yId] = sentIds()
    expect(xId).not.toBe(yId)
    ui.unmount()

    // 再読込の後も両方の控えが端末に在る
    expect(storedText()).toContain(xId)
    expect(storedText()).toContain(yId)

    ui = renderCalendar()
    expect(pendingItem("検診X")).toBeInTheDocument()
    expect(pendingItem("面談Y")).toBeInTheDocument()
    fireEvent.click(within(pendingItem("面談Y")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(3))
    expect(sentIds()[2]).toBe(yId)
    await waitFor(() => expect(within(pendingRegion()).queryByText("面談Y")).toBeNull())
    // Y の解決で X は消えぬ
    expect(pendingItem("検診X")).toBeInTheDocument()
    expect(storedText()).toContain(xId)
    expect(storedText()).not.toContain(yId)

    fireEvent.click(within(pendingItem("検診X")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(4))
    expect(sentIds()[3]).toBe(xId)
    await waitFor(() => expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull())
    expect(rowsTitled("検診X")).toHaveLength(1)
    expect(rowsTitled("面談Y")).toHaveLength(1)
  })

  it("無関係の作成の成功は、結果不明の作成の控えを消さぬ", async () => {
    env.sends.push("lose-response", "ok")
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    const xId = sentIds()[0]
    await createEvent("面談Y")
    fireEvent.click(await screen.findByRole("button", { name: "別の予定として追加" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("予定を追加しました"))
    expect(storedText()).toContain(xId)
    expect(pendingItem("検診X")).toBeInTheDocument()
  })
})

describe("送信の内容は凍結し、応答を失った作成の送り直しは二重にせぬ（単発・繰返し）", () => {
  it("応答を失った単発の作成の toast からの送り直しは、同じ id・同じ内容で送り、保存済みと伝えて 1 行のまま", async () => {
    env.sends.push("lose-response")
    renderCalendar()
    await createEvent("予防接種")
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    pressToastResend()
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    const [first, second] = vi.mocked(createCalendarEvent).mock.calls.map((c) => c[0])
    expect(second).toEqual(first)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/保存されていました/)))
    expect(rowsTitled("予防接種")).toHaveLength(1)
    expect(storedText()).not.toContain(first.clientId!)
  })

  it("結果不明の作成をフォームへ戻して書き換え、同じ id で別の内容を送る経路は無い（「追加」は控えの入力で始めぬ）", async () => {
    env.sends.push("lose-response")
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    openNew()
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("")
  })
})

describe("N1: 端末に残せる時だけ「7日間残ります」と言う", () => {
  it("localStorage へ書けぬ（プライベートブラウズ等）時は、シートを開いた時点から保持の注記を出さぬ", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    renderCalendar()
    openNew()
    expect(screen.queryByText(/7日間残ります/)).toBeNull()
    expect(screen.getByText(/この端末では下書きを残せません/)).toBeInTheDocument()
  })

  it("古い版の下書きを読むだけで見せておる（書かぬ）シートでは、保持の注記を出さぬ", () => {
    const ev: CalendarEventRecord = {
      id: "0a0a0a0a-0000-4000-8000-000000000001",
      title: "検診",
      memo: null,
      is_all_day: true,
      start_date: "2026-07-15",
      end_date: "2026-07-15",
      start_at: null,
      end_at: null,
      source: "native",
      series_id: null,
      updated_at: "v1",
    }
    const first = renderCalendar(A, [ev])
    fireEvent.click(screen.getAllByText("検診")[0])
    typeTitle("検診（自分の入力）")
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    press("下書きを残して閉じる")
    first.unmount()

    renderCalendar(A, [{ ...ev, title: "検診（家族）", updated_at: "v2" }])
    fireEvent.click(screen.getAllByText("検診（家族）")[0])
    expect(screen.getByText(/別の端末で更新されています/)).toBeInTheDocument()
    expect(screen.queryByText(/7日間残ります/)).toBeNull()
  })

  it("端末に残せぬまま結果不明になった作成は、「端末に残した」と言わず、閉じると手がかりが消えると伝え、この画面では同じ id で送り直せる", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    env.sends.push("lose-response")
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const xId = sentIds()[0]
    const item = pendingItem("検診X")
    expect(item).toHaveTextContent(/この端末に残せていません/)
    fireEvent.click(within(item).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    expect(sentIds()).toEqual([xId, xId])
    expect(rowsTitled("検診X")).toHaveLength(1)
  })
})

describe("利用者の交代: 前の利用者の確認中の作成を、次の利用者へ見せず・送らぬ（圏外でも）", () => {
  it("A の結果不明の作成 → ログアウト → B が同じ端末で圏外のまま開く: B には出ず、CacheUserGuard が消し、B の作成の確認にも名を出さぬ", async () => {
    env.sends.push("lose-response")
    const ui = renderCalendar(A)
    await createEvent("Aの検診")
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const aId = sentIds()[0]
    ui.unmount()
    expect(storedText()).toContain(aId)

    // 読みの絞り: CacheUserGuard が走る前でも B には出ぬ
    env.session = { ...B }
    const bOnly = renderCalendar(B)
    expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull()
    bOnly.unmount()

    render(<CacheUserGuard userId={B.userId} householdId={B.householdId} />)
    expect(storedText()).not.toContain(aId)
    expect(storedText()).not.toContain("Aの検診")

    env.sends.push("offline")
    renderCalendar(B)
    await createEvent("Bの予定")
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/Aの検診/)).toBeNull()
    expect(sentTitles()).toEqual(["Aの検診", "Bの予定"])
    expect(sentIds()[1]).not.toBe(aId)
  })

  it("同じ利用者のログインし直し（同じ持ち主）では控えは残る", async () => {
    env.sends.push("lose-response")
    const ui = renderCalendar(A)
    await createEvent("検診X")
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const xId = sentIds()[0]
    ui.unmount()
    render(<CacheUserGuard userId={A.userId} householdId={A.householdId} />)
    expect(storedText()).toContain(xId)
  })
})

describe("繰返し予定の控え: 同じシリーズの送り直しと、途中の回を消した後の送り直し（本物の Action・v8 の行ごとの id を保つ）", () => {
  const WEEKLY = {
    title: "通院",
    memo: null,
    isAllDay: true,
    startDate: "2026-07-06",
    endDate: "2026-07-06",
    startAt: null,
    endAt: null,
    repeat: "weekly" as const,
    repeatUntil: "2026-07-20",
  }
  /** 応答を失った繰返しの作成（DB には 3 行。端末には結果不明の控え） */
  async function lostSeries(): Promise<string> {
    const clientId = "5e5e5e5e-0000-4000-8000-000000000001"
    const { beginCalendarCreateAttempt, settleCalendarCreateAttempt } = await import(
      "@/lib/domain/calendar-pending-creates"
    )
    const formValue = {
      title: "通院",
      memo: null,
      isAllDay: true,
      startDate: "2026-07-06",
      endDate: "2026-07-06",
      startTime: "09:00",
      endTime: "",
      repeat: "weekly" as const,
      repeatUntil: "2026-07-20",
    }
    const { entry } = beginCalendarCreateAttempt({
      owner: A,
      clientId,
      payload: { ...WEEKLY, clientId },
      formValue,
      reminderChoice: "none",
    })
    env.sends.push("lose-response")
    await expect(createCalendarEvent({ ...WEEKLY, clientId })).rejects.toThrow()
    settleCalendarCreateAttempt(entry, { kind: "unknown" })
    vi.mocked(createCalendarEvent).mockClear()
    return clientId
  }

  it("同じシリーズの送り直しは replayed で 3 行のまま、全行が別の id を持ち、初回の行の id と series_id は冪等 id", async () => {
    const clientId = await lostSeries()
    expect(rowsTitled("通院")).toHaveLength(3)
    renderCalendar()
    fireEvent.click(within(pendingItem("通院")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("「通院」は保存されていました（繰り返し3件。二重には追加していません）"),
    )
    expect(vi.mocked(createCalendarEvent).mock.calls[0][0]).toEqual({ ...WEEKLY, clientId })
    const rows = rowsTitled("通院")
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.id)).size).toBe(3)
    expect(rows.every((r) => r.id !== null && r.series_id === clientId)).toBe(true)
    expect(rows.find((r) => r.start_date === "2026-07-06")?.id).toBe(clientId)
    expect(storedText()).not.toContain(clientId)
  })

  it("家族が途中の回を消した後の送り直しは、二重に作らず conflict = 作成済みとして控えを畳み、一覧で確かめさせる", async () => {
    const clientId = await lostSeries()
    const middle = env.db.rows.findIndex((r) => r.start_date === "2026-07-13")
    env.db.rows.splice(middle, 1)
    renderCalendar()
    fireEvent.click(within(pendingItem("通院")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/「通院」は作成済みでした/), expect.anything()))
    expect(rowsTitled("通院")).toHaveLength(2)
    expect(storedText()).not.toContain(clientId)
    expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull()
  })

  it("初回の回を消した後の送り直しも、残りの回を二重に作らぬ（v8 F4）", async () => {
    const clientId = await lostSeries()
    env.db.rows.splice(env.db.rows.findIndex((r) => r.id === clientId), 1)
    renderCalendar()
    fireEvent.click(within(pendingItem("通院")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(rowsTitled("通院")).toHaveLength(2)
  })
})

describe("2 つのタブ・取り直し・1 度きりの拒否", () => {
  it("別のタブが送信中の作成も、新しい作成の確認で数え、一覧では送信中と出しつつ同じ id で送り直せる", async () => {
    const { beginCalendarCreateAttempt, calendarCreateKey } = await import("@/lib/domain/calendar-pending-creates")
    const other = "7a7a7a7a-0000-4000-8000-000000000001"
    const { entry } = beginCalendarCreateAttempt({
      owner: A,
      clientId: other,
      payload: { title: "別タブの予定", memo: null, isAllDay: true, startDate: "2026-07-15", endDate: "2026-07-15", startAt: null, endAt: null, clientId: other },
      formValue: { title: "別タブの予定", memo: null, isAllDay: true, startDate: "2026-07-15", endDate: "2026-07-15", startTime: "09:00", endTime: "", repeat: "none", repeatUntil: "" },
      reminderChoice: "none",
    })
    // 別のタブ（別のページ生存期間）が今送っておる
    localStorage.setItem(calendarCreateKey(A, other), JSON.stringify({ ...entry, pageId: "other-tab" }))
    renderCalendar()
    expect(pendingItem("別タブの予定")).toHaveTextContent(/別の画面で送信中/)
    await createEvent("別タブの予定")
    expect(await screen.findByRole("alert")).toHaveTextContent("別タブの予定")
    expect(createCalendarEvent).not.toHaveBeenCalled()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    press("破棄して閉じる")
    fireEvent.click(within(pendingItem("別タブの予定")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    expect(sentIds()).toEqual([other])
    expect(rowsTitled("別タブの予定")).toHaveLength(1)
  })

  it("別のタブが控えを確定して消したら（storage イベント）、この画面の一覧からも消える", async () => {
    env.sends.push("lose-response")
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const xId = sentIds()[0]!
    expect(pendingItem("検診X")).toBeInTheDocument()
    const key = Object.keys({ ...localStorage }).find((k) => k.endsWith(xId))!
    localStorage.removeItem(key)
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key }))
    })
    expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull()
  })

  it("取り直した一覧に結果不明の作成の行が現れたら、読むだけで保存済みとして畳む（送り直さぬ）", async () => {
    env.readsOk = true
    env.sends.push("lose-response")
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("確認中だった「検診X」は保存されていました"))
    expect(createCalendarEvent).toHaveBeenCalledTimes(1)
    expect(storedText()).not.toContain(sentIds()[0])
    expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull()
  })

  it("1 度きりの送信がログイン切れで拒まれた作成は「保存できなかった」と言い、確認に数えず、直した入力は新しい id で送り、古い控えを畳む", async () => {
    env.session = null
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("認証されていません", expect.anything()))
    const xId = sentIds()[0]
    expect(pendingItem("検診X")).toHaveTextContent(/保存できませんでした（認証されていません）。予定は作られていません/)
    env.session = { ...A }
    fireEvent.click(within(pendingItem("検診X")).getByRole("button", { name: "入力に戻る" }))
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("検診X")
    expect(screen.getByText("保存できなかった入力を復元しました。")).toBeInTheDocument()
    typeTitle("検診X（午後）")
    press("追加")
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    expect(sentIds()[1]).not.toBe(xId)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("予定を追加しました"))
    expect(storedText()).not.toContain(xId)
    expect(rowsTitled("検診X")).toHaveLength(0)
    expect(rowsTitled("検診X（午後）")).toHaveLength(1)
  })
})

describe("独立レビュー v9rc1 の回帰（画面）", () => {
  const panel = () => screen.getByRole("region", { name: "予定の追加の確認" })

  it("PI-2: 送信中に別の画面へ移って戻っても（画面の作り直し）、送信中の作成を「確認できていない」と出さず、送り直しの釦も出さぬ", async () => {
    env.sends.push("hold")
    const first = renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    first.unmount() // 別の画面へ（送信は続く）
    renderCalendar() // 戻る
    const item = pendingItem("検診X")
    expect(item).toHaveTextContent("送信中です…")
    expect(within(item).queryByRole("button", { name: SAVE_RESEND_LABEL })).toBeNull()
    expect(within(item).queryByRole("button", { name: "確認をやめる" })).toBeNull()
    await act(async () => env.release())
    await waitFor(() => expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull())
    expect(createCalendarEvent).toHaveBeenCalledTimes(1)
    expect(rowsTitled("検診X")).toHaveLength(1)
  })

  it("UX-06: 送信中の繰り返しの作成（楽観行を作らぬ）は、一覧に「送信中です…」と出す", async () => {
    const { beginCalendarCreateAttempt, settleCalendarCreateAttempt } = await import("@/lib/domain/calendar-pending-creates")
    const id = "6f6f6f6f-0000-4000-8000-000000000001"
    const payload = { title: "通院", memo: null, isAllDay: true, startDate: "2026-07-06", endDate: "2026-07-06", startAt: null, endAt: null, repeat: "weekly" as const, repeatUntil: "2026-07-20", clientId: id }
    const { entry } = beginCalendarCreateAttempt({
      owner: A,
      clientId: id,
      payload,
      formValue: { title: "通院", memo: null, isAllDay: true, startDate: "2026-07-06", endDate: "2026-07-06", startTime: "09:00", endTime: "", repeat: "weekly", repeatUntil: "2026-07-20" },
      reminderChoice: "none",
    })
    settleCalendarCreateAttempt(entry, { kind: "unknown" })
    env.sends.push("hold")
    renderCalendar()
    fireEvent.click(within(pendingItem("通院")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    expect(pendingItem("通院")).toHaveTextContent("送信中です…")
    expect(panel()).toHaveTextContent("送信中 1件")
    await act(async () => env.release())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("繰り返し予定を3件追加しました"))
  })

  it("UX-03: 一覧は「確認できていない」と「保存できなかった」を別々に数える", async () => {
    env.sends.push("lose-response")
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    env.session = null
    await createEvent("面談Y")
    fireEvent.click(await screen.findByRole("button", { name: "別の予定として追加" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("認証されていません", expect.anything()))
    expect(panel()).toHaveTextContent("保存できたか確認できていない予定 1件・保存できなかった予定 1件")
  })

  it("UX-02: 端末に残せておらぬ控えだけの時、一覧の共通の文は「この端末に残ります」と言わぬ", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    env.sends.push("lose-response")
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(panel()).toHaveTextContent("この一覧はこの端末に残せていません")
    expect(panel()).not.toHaveTextContent("この一覧はこの端末のこのブラウザにだけ残ります")
  })

  it("UX-01: 保存できなかった作成を直すシートで「破棄」したら、シートを閉じ、送っておらぬ別の下書きを上書きせぬ", async () => {
    renderCalendar()
    // 先に、1 度きりの送信が拒まれる作成 R
    env.session = null
    await createEvent("拒まれる予定R")
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("認証されていません", expect.anything()))
    env.session = { ...A }
    // その後、送っておらぬ別の予定 A を打って下書きに残す
    openNew()
    typeTitle("予定A（下書き）")
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    press("下書きを残して閉じる")
    // R を直すシートを開く
    fireEvent.click(within(pendingItem("拒まれる予定R")).getByRole("button", { name: "入力に戻る" }))
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("拒まれる予定R")
    press("破棄")
    await waitFor(() => expect(screen.queryByLabelText("タイトル")).toBeNull())
    expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull()
    openNew()
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("予定A（下書き）")
  })

  it("UX-04: 端末に残せなかった（上限）拒否の控えを直す入力は、端末に書かず「7日間残ります」と言わぬ", async () => {
    const { beginCalendarCreateAttempt, settleCalendarCreateAttempt, CALENDAR_CREATES_MAX } = await import(
      "@/lib/domain/calendar-pending-creates"
    )
    // 上限まで埋める（拒まれた控え = 確認に数えぬ。新しい作成を止めずに上限だけを効かせる）
    for (let i = 0; i < CALENDAR_CREATES_MAX; i++) {
      const cid = `8a8a8a8a-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
      const { entry } = beginCalendarCreateAttempt({
        owner: A,
        clientId: cid,
        payload: { title: `既存${i}`, memo: null, isAllDay: true, startDate: "2026-07-01", endDate: "2026-07-01", startAt: null, endAt: null, clientId: cid },
        formValue: { title: `既存${i}`, memo: null, isAllDay: true, startDate: "2026-07-01", endDate: "2026-07-01", startTime: "09:00", endTime: "", repeat: "none", repeatUntil: "" },
        reminderChoice: "none",
      })
      settleCalendarCreateAttempt(entry, { kind: "rejected", message: "前の拒否" })
    }
    env.session = null
    renderCalendar()
    await createEvent("拒まれる予定R")
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("認証されていません", expect.anything()))
    const rId = sentIds()[0]!
    fireEvent.click(within(pendingItem("拒まれる予定R")).getByRole("button", { name: "入力に戻る" }))
    expect(screen.getByText(/元の予定の控えをこの端末に残せていないため、この入力も残せません/)).toBeInTheDocument()
    expect(screen.queryByText(/7日間/)).toBeNull()
    typeTitle("拒まれる予定R（直し）")
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500))
    })
    expect(storedText()).not.toContain(`calendar-event-new:${rId}`)
  })

  it("UX-04: 直すシートの保持の注記は、元の控えの期限（最初に追加しようとしてから 7 日）で言う", async () => {
    env.session = null
    renderCalendar()
    await createEvent("拒まれる予定R")
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("認証されていません", expect.anything()))
    fireEvent.click(within(pendingItem("拒まれる予定R")).getByRole("button", { name: "入力に戻る" }))
    expect(screen.getByText(/元の予定を最初に追加しようとしてから7日間/)).toBeInTheDocument()
  })
})

describe("独立レビュー v9rc2 の回帰（画面）", () => {
  it("UX-06 の変種: 単発の作成の送信中に月を送って楽観行が消えたら、一覧に「送信中です…」で出す（釦は出さぬ）。対照: 楽観行が見えておる間は出さぬ", async () => {
    env.readsOk = true
    env.sends.push("hold")
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    // 楽観行が一覧に在る間は、控えの一覧に二重に出さぬ
    expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "次の月" }))
    const item = await waitFor(() => pendingItem("検診X"))
    expect(item).toHaveTextContent("送信中です…")
    expect(within(item).queryByRole("button", { name: SAVE_RESEND_LABEL })).toBeNull()
    await act(async () => env.release())
    await waitFor(() => expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull())
    expect(rowsTitled("検診X")).toHaveLength(1)
  })
})

describe("独立レビュー v9rc2 INFO: PI-1 を画面の層で守る", () => {
  it("別のタブで確認を終えた後に送信結果が不明になったら、控えを蘇らせず送った画面にも一覧で確かめるよう知らせる（RC2-3）", async () => {
    env.sends.push("hold-lose-response")
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    const xId = sentIds()[0]!
    const key = Object.keys({ ...localStorage }).find((k) => k.endsWith(xId))!
    localStorage.removeItem(key)
    act(() => window.dispatchEvent(new StorageEvent("storage", { key })))
    await act(async () => env.release())
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(
      "「検診X」の確認は既に終了しています。追加できたかは予定の一覧で確かめてください。",
      expect.anything(),
    ))
    expect(storedText()).not.toContain(xId)
    expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull()
    expect(rowsTitled("検診X")).toHaveLength(1)
    expect(vi.mocked(toast.error).mock.calls.some((call) =>
      (call[1] as { action?: { label?: string } } | undefined)?.action?.label === SAVE_RESEND_LABEL,
    )).toBe(false)
  })

  it("この画面の送信中に別のタブが確定して控えを消し、遅れてこちらにログイン切れの拒否が届いても、「保存できなかった」で蘇らせず知らせぬ", async () => {
    env.sends.push("hold")
    renderCalendar()
    await createEvent("検診X")
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    const xId = sentIds()[0]!
    // 別のタブの送り直しが成功して控えを消した（storage イベントで知る）
    const key = Object.keys({ ...localStorage }).find((k) => k.endsWith(xId))!
    localStorage.removeItem(key)
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key }))
    })
    // こちらの送信は遅れて届き、ログイン切れで拒まれる
    env.session = null
    await act(async () => env.release())
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(storedText()).not.toContain(xId)
    expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull()
    expect(toast.error).not.toHaveBeenCalledWith("認証されていません", expect.anything())
    expect(screen.queryByText(/予定は作られていません/)).toBeNull()
  })
})

describe("独立レビュー v9rc2 の回帰: 直すシートを開いておる間に元の控えが消えた", () => {
  it("別のタブが保存できなかった控えを破棄したら、開いておる直すシートは下書きを書かず、残せぬと言う。対照: 消えるまでは書く", async () => {
    env.session = null
    renderCalendar()
    await createEvent("拒まれる予定R")
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("認証されていません", expect.anything()))
    const rId = sentIds()[0]!
    fireEvent.click(within(pendingItem("拒まれる予定R")).getByRole("button", { name: "入力に戻る" }))
    typeTitle("拒まれる予定R（直し1）")
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500))
    })
    // 対照: 控えが在る間は直す入力を端末に書く
    expect(storedText()).toContain(`calendar-event-new:${rId}`)

    // 別のタブが R を破棄（控えと直す下書きを消す）
    const keys = Object.keys({ ...localStorage }).filter((k) => k.endsWith(rId))
    for (const k of keys) localStorage.removeItem(k)
    act(() => {
      for (const k of keys) window.dispatchEvent(new StorageEvent("storage", { key: k }))
    })
    expect(screen.getByText(/元の予定の控えはもうこの端末にありません/)).toBeInTheDocument()
    typeTitle("拒まれる予定R（直し2）")
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500))
    })
    expect(storedText()).not.toContain(`calendar-event-new:${rId}`)
    expect(screen.queryByText(/7日間/)).toBeNull()
  })
})

vi.mock("next/navigation",()=>({useRouter:()=>({push:vi.fn()})}))
