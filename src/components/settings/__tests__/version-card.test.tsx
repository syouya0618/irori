/**
 * 設定の「このアプリの版」と更新の操作（E1・AC20 の component 層）。
 *
 * - 端末の版とサーバの版を分けて出す。取得できなかったことを「最新です」と言わぬ
 * - 新しい版がある時だけ「読み直して更新する」。押した時だけ読み直す（自動ではせぬ）
 * - 端末に書きかけ・計測・保存を確認中のものがあれば、先にその旨を出して選ばせる
 * - 端末保存を読めぬ時も「何も無い」とは言わず、確認を挟む
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"
import { VersionCard } from "../version-card"
import { AppUpdateNotice } from "@/components/common/app-update-notice"
import { resetStaleClientForTest, noteServerActionFailure } from "@/lib/pwa/app-version"
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error"
import { act } from "react"
import {
  beginCalendarCreateAttempt,
  clearMemoryOnlyCalendarCreatesForTest,
  putMemoryOnlyCalendarCreate,
} from "@/lib/domain/calendar-pending-creates"

const OWNER = { userId: "u1", householdId: "h1" }
const TIMER_KEY = "irori:feeding-timer"

function versionResponse(buildId: string) {
  return {
    ok: true,
    status: 200,
    type: "basic",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ buildId, releaseName: "x" }),
  }
}

beforeEach(() => {
  resetStaleClientForTest()
  localStorage.clear()
  clearMemoryOnlyCalendarCreatesForTest()
  vi.stubEnv("IRORI_BUILD_SHA", "abc1234")
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("VersionCard", () => {
  it("リリース名・この端末の版・公開中の版を分けて出す（同じ版）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => versionResponse("abc1234")))
    render(<VersionCard owner={OWNER} />)
    expect(screen.getByText("2026年10月の更新")).toBeInTheDocument()
    expect(screen.getByTestId("client-build-id")).toHaveTextContent("abc1234")
    await waitFor(() =>
      expect(screen.getByTestId("server-build-status")).toHaveTextContent("この端末の版と同じです"),
    )
    expect(screen.queryByRole("button", { name: "読み直して更新する" })).not.toBeInTheDocument()
    // 履歴は設定最下部の専用ボタンから開く。
    expect(screen.queryByRole("heading", { name: "この更新のおもな変更" })).not.toBeInTheDocument()
  })

  it("取得できなかった時は「確かめられませんでした」— 最新とも新しい版ありとも言わぬ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      }),
    )
    render(<VersionCard owner={OWNER} />)
    await waitFor(() =>
      expect(screen.getByTestId("server-build-status")).toHaveTextContent("確かめられませんでした"),
    )
    expect(screen.getByTestId("server-build-status")).not.toHaveTextContent("同じです")
    expect(screen.queryByRole("button", { name: "読み直して更新する" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "新しい版を確かめる" })).toBeInTheDocument()
  })

  it("端末が dev の build なら比べられぬと言う", async () => {
    vi.stubEnv("IRORI_BUILD_SHA", "")
    vi.stubGlobal("fetch", vi.fn(async () => versionResponse("abc1234")))
    render(<VersionCard owner={OWNER} />)
    expect(screen.getByTestId("client-build-id")).toHaveTextContent("開発用の版")
    await waitFor(() =>
      expect(screen.getByTestId("server-build-status")).toHaveTextContent("比べられません"),
    )
  })

  it("⭐ 新しい版があり端末に何も無ければ、押した時だけ読み直す（描画しただけでは読み直さぬ）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => versionResponse("def5678")))
    const reload = vi.fn()
    render(<AppUpdateNotice owner={OWNER} onReload={reload} />)
    const button = await screen.findByRole("button", { name: "読み直して更新する" })
    expect(reload).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("⭐ 端末に計測が残っておれば、読み直す前にその旨を出し、利用者が選ぶまで読み直さぬ", async () => {
    localStorage.setItem(
      TIMER_KEY,
      JSON.stringify({ startedAt: new Date().toISOString(), feedingType: "breast_left", userId: "u1", householdId: "h1" }),
    )
    vi.stubGlobal("fetch", vi.fn(async () => versionResponse("def5678")))
    const reload = vi.fn()
    render(<AppUpdateNotice owner={OWNER} onReload={reload} />)
    fireEvent.click(await screen.findByRole("button", { name: "読み直して更新する" }))
    expect(reload).not.toHaveBeenCalled()
    const group = screen.getByRole("group", { name: "更新の前の確認" })
    expect(group).toHaveTextContent("授乳の計測")
    // 「あとで」は読み直さぬ
    fireEvent.click(screen.getByRole("button", { name: "あとで" }))
    expect(reload).not.toHaveBeenCalled()
    // 改めて選べば読み直す
    fireEvent.click(screen.getByRole("button", { name: "読み直して更新する" }))
    fireEvent.click(screen.getByRole("button", { name: "それでも更新する" }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("持ち主が分からぬ時は「確認できなかった」を挟む（何も無いとは言わぬ）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => versionResponse("def5678")))
    const reload = vi.fn()
    render(<AppUpdateNotice owner={null} onReload={reload} />)
    fireEvent.click(await screen.findByRole("button", { name: "読み直して更新する" }))
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByRole("group", { name: "更新の前の確認" })).toHaveTextContent("確認できませんでした")
  })

  it("端末に書けなかった予定の控えだけでも、更新を確認し、再読込で戻ると約束しない（RC2-2）", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError")
    })
    const clientId = "2c2c2c2c-0000-4000-8000-000000000006"
    const { entry, persisted } = beginCalendarCreateAttempt({
      owner: OWNER,
      clientId,
      payload: { title: "検診", memo: null, isAllDay: true, startDate: "2026-11-02", endDate: "2026-11-02", startAt: null, endAt: null, clientId },
      formValue: { title: "検診", memo: null, isAllDay: true, startDate: "2026-11-02", endDate: "2026-11-02", startTime: "09:00", endTime: "", repeat: "none", repeatUntil: "" },
      reminderChoice: "none",
    })
    expect(persisted).toBe(false)
    putMemoryOnlyCalendarCreate(entry)
    vi.stubGlobal("fetch", vi.fn(async () => versionResponse("def5678")))
    const reload = vi.fn()
    render(<AppUpdateNotice owner={OWNER} onReload={reload} />)
    fireEvent.click(await screen.findByRole("button", { name: "読み直して更新する" }))
    expect(reload).not.toHaveBeenCalled()
    const group = screen.getByRole("group", { name: "更新の前の確認" })
    expect(group).toHaveTextContent("保存を確認中の予定 1件")
    expect(group).toHaveTextContent("端末に残せていない予定の控えは、読み直すと消えます")
    expect(group).not.toHaveTextContent("書きかけと計測は読み直した後も、この端末から戻ります")
    fireEvent.click(screen.getByRole("button", { name: "それでも更新する" }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("対照: 同じ版・確かめられぬ時は案内そのものを出さぬ", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => versionResponse("abc1234")))
    render(<AppUpdateNotice owner={OWNER} onReload={vi.fn()} />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    // 応答を流しきる
    await act(async () => {})
    expect(screen.queryByRole("region", { name: "新しい版のお知らせ" })).not.toBeInTheDocument()
  })

  it("古い画面のまま新しいサーバへ action を送って失敗したら、版の確認を待たずに案内を出す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      }),
    )
    render(<AppUpdateNotice owner={OWNER} onReload={vi.fn()} />)
    expect(screen.queryByRole("region", { name: "新しい版のお知らせ" })).not.toBeInTheDocument()
    act(() => {
      noteServerActionFailure(new UnrecognizedActionError("not found"))
    })
    expect(screen.getByRole("region", { name: "新しい版のお知らせ" })).toHaveTextContent(
      "アプリが新しくなっています",
    )
  })

  it("画面復帰で確かめ直すのは前回から 10 分以上たった時だけ（毎回は叩かぬ）", async () => {
    const fetchMock = vi.fn(async () => versionResponse("abc1234"))
    vi.stubGlobal("fetch", fetchMock)
    const now = vi.spyOn(Date, "now")
    now.mockReturnValue(1_000_000)
    render(<VersionCard owner={OWNER} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    now.mockReturnValue(1_000_000 + 60_000)
    document.dispatchEvent(new Event("visibilitychange"))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now.mockReturnValue(1_000_000 + 11 * 60_000)
    document.dispatchEvent(new Event("visibilitychange"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })
})
