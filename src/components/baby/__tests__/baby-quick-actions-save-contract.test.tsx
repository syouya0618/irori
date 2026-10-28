/**
 * クイック記録の保存契約（2026-10-27 大型更新 A2 / C2。受入 AC04・AC06・AC11）。
 *
 * - 結果の分からぬ記録は持ち主付きで端末に残し、再読込（作り直し）の後の期限内の押し直しも
 *   同じ id・同じ内容で送る（新しい id で登録し直さぬ）
 * - replayed は DB の確定行を画面へ出す（端末時計で行を組まぬ）
 * - 「今回だけ別の量」はいつもの量で記録シートを開くだけで、いつもの量（世帯の設定）は変えぬ
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"

import {
  BabyQuickActions,
  SEPARATE_FROM_PENDING_NOTE,
  SEPARATE_FROM_PENDING_REPLAY_NOTE,
  SEPARATE_FROM_PENDING_UNKNOWN_NOTE,
} from "../baby-quick-actions"
import { recordFeeding, recordDiaper, updateBottleDefault } from "@/app/(main)/baby/actions"
import { toast } from "sonner"
import {
  listPendingSaves,
  isAwaitingConfirmation,
  PAGE_LIFE_ID,
  PENDING_SAVE_SCHEMA_VERSION,
  putPendingSave,
  pendingSaveKey,
} from "@/lib/domain/pending-saves-storage"
import type { BabyLogData } from "@/lib/types/baby"
import type { BottleDefaultController } from "@/lib/hooks/use-bottle-default"

vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  deleteLog: vi.fn(),
  updateBottleDefault: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

const mockedRecordFeeding = vi.mocked(recordFeeding)
const mockedRecordDiaper = vi.mocked(recordDiaper)
const mockedUpdate = vi.mocked(updateBottleDefault)
const mockedToast = vi.mocked(toast)
const OWNER = { userId: "u1", householdId: "h1" }

function bottleSet(amountMl = 160): BottleDefaultController {
  return { state: { status: "set", amountMl }, refetch: vi.fn(async () => null), apply: vi.fn() }
}

function renderActions(props: Partial<Parameters<typeof BabyQuickActions>[0]> = {}) {
  return render(
    <BabyQuickActions
      bottleDefault={bottleSet()}
      userId="u1"
      householdId="h1"
      onCreateLog={() => {}}
      onStartTimer={() => {}}
      onCreateFeeding={() => {}}
      {...props}
    />,
  )
}

async function clickWhenEnabled(name: string | RegExp) {
  const button = screen.getByRole("button", { name })
  await waitFor(() => expect(button).not.toBeDisabled())
  fireEvent.click(button)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedRecordFeeding.mockReset()
  mockedRecordDiaper.mockReset()
  localStorage.clear()
  // 同じ画面の押し直しの期限は経過の時計（performance.now）で測る（v7 N3-04）。この file は端末の
  // 時計を変えぬ場面だけを扱うゆえ、経過の時計を偽の Date に揃えて進める（時計の変更は
  // baby-quick-actions.test.tsx の N3-04 の試験）
  vi.spyOn(performance, "now").mockImplementation(() => Date.now())
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("結果の分からぬクイック記録（AC04 / AC06）", () => {
  it("例外は「保存されておらぬ」と言わず、持ち主付きで端末に残す（送信内容そのまま）", async () => {
    mockedRecordFeeding.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(
        expect.stringContaining("保存できたか確認できていません"),
      ),
    )
    const pending = listPendingSaves(OWNER)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      action: "recordFeeding",
      summary: "ミルク 160ml",
      retryKey: "feeding:bottle",
      phase: "unknown",
      payload: { feedingType: "bottle", amountMl: 160, clientId: pending[0].clientId },
    })
    // 別の利用者・世帯には見えぬ
    expect(listPendingSaves({ userId: "u2", householdId: "h1" })).toHaveLength(0)
    expect(listPendingSaves({ userId: "u1", householdId: "h2" })).toHaveLength(0)
  })

  it("再読込（作り直し）の後でも、期限内の同じ操作は端末に残した同じ id で送る", async () => {
    mockedRecordFeeding.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    const first = renderActions()
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(1))
    first.unmount()

    mockedRecordFeeding.mockResolvedValueOnce({ error: null, id: "x", replayed: true })
    renderActions()
    await clickWhenEnabled("ミルク")
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
    expect(mockedRecordFeeding.mock.calls[1][0]).toEqual(mockedRecordFeeding.mock.calls[0][0])
    // 確定（replayed）したら端末の記録は消す
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(0))
  })

  it("端末に控えを書けぬ（容量不足）時は「保存を確認中の記録」へ案内せず、2 分以内の押し直しと一覧での確認を言う（v7 F3）", async () => {
    mockedRecordFeeding.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError")
    })
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(
        expect.stringContaining("この端末に控えを残せなかったため、2分以内にもう一度押して"),
      ),
    )
    expect(String(mockedToast.error.mock.calls.at(-1)?.[0])).not.toContain("「保存を確認中の記録」")
  })

  it("対照: 端末に控えを書けた時は「保存を確認中の記録」へ案内する", async () => {
    mockedRecordFeeding.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining("「保存を確認中の記録」から送り直す")),
    )
  })

  it("対照: householdId を渡さぬ（持ち主不明）なら端末には残さぬ", async () => {
    mockedRecordFeeding.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    renderActions({ householdId: undefined })
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
    expect(listPendingSaves(OWNER)).toHaveLength(0)
  })

  it("サーバの unknown（DB 送信後の失敗）も結果不明として残し、その後の押し直しが rejected（ログイン切れ等）でも捨てぬ", async () => {
    // 独立レビュー 2026-10-28: 押し直しの拒否は「先の結果不明の送信が保存されておらぬ」ことを意味せぬ。
    // 控えと id を捨てると次の押下が新しい id になり、先の送信が成立しておれば二重記録になる
    mockedRecordDiaper
      .mockResolvedValueOnce({ error: "おむつの記録に失敗しました。", id: null, failure: "unknown" })
      .mockResolvedValueOnce({ error: "認証されていません", id: null, failure: "rejected" })
      .mockResolvedValueOnce({ error: null, id: "x", replayed: true })
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(1))
    await clickWhenEnabled("おしっこ")
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenLastCalledWith(
        expect.stringContaining("認証されていません（前の送信が保存されたかは"),
      ),
    )
    expect(mockedRecordDiaper.mock.calls[1][0]).toEqual(mockedRecordDiaper.mock.calls[0][0])
    expect(listPendingSaves(OWNER)).toHaveLength(1)
    // 次の押下も同じ id・同じ内容（新しい id で登録し直さぬ）
    await clickWhenEnabled("おしっこ")
    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(3))
    expect(mockedRecordDiaper.mock.calls[2][0]).toEqual(mockedRecordDiaper.mock.calls[0][0])
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(0))
  })

  it("対照: 初めての送信が保存前に拒まれた（検証エラー）なら控えを残さず、次の押下は新しい操作", async () => {
    mockedRecordDiaper
      .mockResolvedValueOnce({ error: "検証エラー", id: null, failure: "rejected" })
      .mockResolvedValueOnce({ error: null, id: "y" })
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.error).toHaveBeenLastCalledWith("検証エラー"))
    expect(listPendingSaves(OWNER)).toHaveLength(0)
    await clickWhenEnabled("おしっこ")
    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(2))
    expect(mockedRecordDiaper.mock.calls[1][0].clientId).not.toBe(mockedRecordDiaper.mock.calls[0][0].clientId)
  })

  it("送る前に「送信中」として端末に残す（応答の前の再読込・更新でも照合できる）。同じページの送信中は一覧に出さぬ", async () => {
    let release: (v: Awaited<ReturnType<typeof recordFeeding>>) => void = () => {}
    mockedRecordFeeding.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = resolve
      }),
    )
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    try {
      await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(1))
      const during = listPendingSaves(OWNER)
      expect(during).toHaveLength(1)
      expect(during[0]).toMatchObject({ phase: "sending", pageId: PAGE_LIFE_ID })
      expect(isAwaitingConfirmation(during[0])).toBe(false)
      // 別のタブ（ページ生存期間）から見ても、送信の直後は「確認中」に出さぬ（送信の最中の誤警告）
      const sentAt = new Date(during[0].sentAt!).getTime()
      const otherTab = { ...during[0], pageId: "previous-page" }
      expect(isAwaitingConfirmation(otherTab, { nowMs: sentAt + 1_000 })).toBe(false)
      // 猶予を過ぎても送信中のまま = そのタブが閉じられた・再読込された → 結果不明として出す
      expect(isAwaitingConfirmation(otherTab, { nowMs: sentAt + 61_000 })).toBe(true)
    } finally {
      // 応答を必ず解く（解かぬと React 19 の async transition が後続のテストまで「処理中」に絡む）
      release({ error: null, id: "z" })
    }
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(0))
  })

  it("失敗が遅れて届いても、押し直しの期限は結果不明と分かった時から 2 分（約束どおり同じ id・同じ内容。独立レビュー 2 周目の W1 を反転）", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T03:00:00.000Z"), toFake: ["Date"] })
    try {
      let fail: (e: unknown) => void = () => {}
      mockedRecordFeeding.mockImplementationOnce(
        () => new Promise((_, reject) => {
          fail = reject
        }),
      )
      mockedRecordFeeding.mockResolvedValueOnce({ error: null, id: "x", replayed: true })
      renderActions()
      fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
      await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(1))
      // 押してから 110 秒後に失敗が届く
      vi.setSystemTime(new Date("2026-10-28T03:01:50.000Z"))
      fail(new TypeError("Failed to fetch"))
      await waitFor(() =>
        expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining("2分以内にもう一度押すか")),
      )
      // トーストに従って 15 秒後に押す（最初の押下からは 125 秒）
      vi.setSystemTime(new Date("2026-10-28T03:02:05.000Z"))
      await clickWhenEnabled("ミルク")
      await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
      expect(mockedRecordFeeding.mock.calls[1][0]).toEqual(mockedRecordFeeding.mock.calls[0][0])
      await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(0))
    } finally {
      vi.useRealTimers()
    }
  })

  it("再読込の後も、端末の控えの「結果不明と分かった時刻」から期限を測る", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T03:00:00.000Z"), toFake: ["Date"] })
    try {
      let fail: (e: unknown) => void = () => {}
      mockedRecordFeeding.mockImplementationOnce(
        () => new Promise((_, reject) => {
          fail = reject
        }),
      )
      const first = renderActions()
      fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
      await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(1))
      vi.setSystemTime(new Date("2026-10-28T03:01:50.000Z"))
      fail(new TypeError("Failed to fetch"))
      await waitFor(() => expect(listPendingSaves(OWNER)[0]?.phase).toBe("unknown"))
      first.unmount()
      mockedRecordFeeding.mockResolvedValueOnce({ error: null, id: "x", replayed: true })
      vi.setSystemTime(new Date("2026-10-28T03:03:00.000Z"))
      renderActions()
      await clickWhenEnabled("ミルク")
      await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
      expect(mockedRecordFeeding.mock.calls[1][0]).toEqual(mockedRecordFeeding.mock.calls[0][0])
    } finally {
      vi.useRealTimers()
    }
  })

  it("対照: 結果不明と分かってから 2 分を過ぎた押下は新しい記録（新しい id。時刻は送らず DB の受信時刻）", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T03:00:00.000Z"), toFake: ["Date"] })
    try {
      mockedRecordFeeding
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ error: null, id: "y" })
      renderActions()
      fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
      await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(1))
      vi.setSystemTime(new Date("2026-10-28T03:02:01.000Z"))
      await clickWhenEnabled("ミルク")
      await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
      expect(mockedRecordFeeding.mock.calls[1][0].clientId).not.toBe(mockedRecordFeeding.mock.calls[0][0].clientId)
      expect(mockedRecordFeeding.mock.calls[1][0]).not.toHaveProperty("loggedAt")
      // 先の控えは「保存を確認中の記録」に残る（黙って捨てぬ）
      expect(listPendingSaves(OWNER).map((p) => p.clientId)).toContain(
        mockedRecordFeeding.mock.calls[0][0].clientId,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("送信中に再読込した直後（表示の猶予の内）の押し直しが拒まれても、先の控えと id を捨てぬ（独立レビュー 3 周目 G1）", async () => {
    // 前のページが送信中のまま再読込された形を作る（応答は届かず、控えは sending・前のページ・10 秒前）
    mockedRecordDiaper.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    const first = renderActions()
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(1))
    first.unmount()
    const entries = listPendingSaves(OWNER)
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString()
    for (const e of entries) {
      e.phase = "sending"
      e.pageId = "previous-page"
      e.sentAt = tenSecondsAgo
      delete e.unknownAt
    }
    for (const entry of entries) localStorage.setItem(pendingSaveKey(OWNER, entry.clientId), JSON.stringify(entry))
    const clientId = listPendingSaves(OWNER)[0].clientId

    mockedRecordDiaper.mockResolvedValueOnce({ error: "認証されていません", id: null, failure: "rejected" })
    renderActions()
    await clickWhenEnabled("おしっこ")
    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(2))
    expect(mockedRecordDiaper.mock.calls[1][0]).toEqual(mockedRecordDiaper.mock.calls[0][0])
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenLastCalledWith(
        expect.stringContaining("（前の送信が保存されたかは"),
      ),
    )
    // 先の送信は成立しておりうる → 控えも id も残す
    expect(listPendingSaves(OWNER).map((p) => p.clientId)).toEqual([clientId])
  })

  it("時計が 10 分進んだ端末でも、送信内容に端末の時計の時刻を入れぬ（N3: 未来の時刻で拒まれる道を作らぬ）", async () => {
    // 2026-10-28 製品判断 N3: 以前は押した時刻（端末の時計）を送り、進んだ時計の端末は全て
    // 「未来の時刻」で拒まれた。記録時刻は DB の受信時刻ゆえ、端末の時計は送信内容に現れぬ
    vi.useFakeTimers({ now: new Date("2026-10-28T03:10:00.000Z"), toFake: ["Date"] })
    try {
      mockedRecordFeeding.mockResolvedValueOnce({ error: null, id: "x" })
      mockedRecordDiaper.mockResolvedValueOnce({ error: null, id: "y" })
      renderActions()
      fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
      await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(1))
      await clickWhenEnabled("おしっこ")
      await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(1))
      expect(mockedRecordFeeding.mock.calls[0][0]).not.toHaveProperty("loggedAt")
      expect(mockedRecordDiaper.mock.calls[0][0]).not.toHaveProperty("loggedAt")
      expect(JSON.stringify(mockedRecordFeeding.mock.calls[0][0])).not.toContain("2026-10-28T03:10")
    } finally {
      vi.useRealTimers()
    }
  })

  it("結果不明の後の押し直しが拒まれた時は、サーバの理由のまま伝え、控えは残す（時計を疑う作り文言は出さぬ）", async () => {
    mockedRecordFeeding
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ error: "認証されていません", id: null, failure: "rejected" })
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(1))
    await clickWhenEnabled("ミルク")
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenLastCalledWith(
        "認証されていません（前の送信が保存されたかは「保存を確認中の記録」で確かめられます）",
      ),
    )
    expect(listPendingSaves(OWNER)).toHaveLength(1)
  })

  it("結果不明の後の押し直しが新しく記録したら、届いた時刻（DB の時刻）を押した時刻と偽らず伝える", async () => {
    mockedRecordFeeding
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        error: null,
        id: "fresh-1",
        updatedAt: "2026-10-28T03:01:30.123456+00:00",
        loggedAt: "2026-10-28T03:01:30.1+00:00",
      })
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(1))
    await clickWhenEnabled("ミルク")
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith(
        expect.stringContaining("記録時刻は届いた時刻（12:01）です"),
        expect.anything(),
      ),
    )
  })

  it("対照: 初めての送信の成功には届いた時刻の注記を付けぬ（押した時とほぼ同時ゆえ）", async () => {
    mockedRecordFeeding.mockResolvedValueOnce({
      error: null,
      id: "fresh-2",
      updatedAt: "2026-10-28T03:00:00.123456+00:00",
      loggedAt: "2026-10-28T03:00:00.1+00:00",
    })
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    expect(String(mockedToast.success.mock.calls[0][0])).not.toContain("届いた時刻")
  })

  it("期限内にいつもの量を変えて押し直しても、控えの送信内容は最初の内容のまま（照合・送り直しは最初の内容で）", async () => {
    mockedRecordFeeding
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ error: "認証されていません", id: null, failure: "rejected" })
    const view = renderActions()
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(1))
    view.unmount()
    renderActions({ bottleDefault: bottleSet(180) })
    await clickWhenEnabled("ミルク")
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
    expect(mockedRecordFeeding.mock.calls[1][0]).toMatchObject({ amountMl: 180 })
    await waitFor(() => expect(listPendingSaves(OWNER)[0]?.phase).toBe("unknown"))
    expect(listPendingSaves(OWNER)[0].payload).toMatchObject({ amountMl: 160 })
    expect(listPendingSaves(OWNER)[0].summary).toBe("ミルク 160ml")
  })

  it("記録時刻は送らず（DB の受信時刻）、期限内の押し直しも同じ内容 — 後から時刻を足さぬ（N3）", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T03:00:00.000Z"), toFake: ["Date"] })
    try {
      mockedRecordFeeding
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ error: null, id: "x", replayed: true })
      renderActions()
      fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
      await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(1))
      vi.setSystemTime(new Date("2026-10-28T03:01:30.000Z"))
      await clickWhenEnabled("ミルク")
      await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
      // 時刻を足すと、先の送信が届いておった時に同じ id・別の内容として照合に拒まれる
      expect(mockedRecordFeeding.mock.calls[0][0]).not.toHaveProperty("loggedAt")
      expect(mockedRecordFeeding.mock.calls[1][0]).toEqual(mockedRecordFeeding.mock.calls[0][0])
    } finally {
      vi.useRealTimers()
    }
  })

  it("replayed は DB の確定行（版・時刻）を画面へ出し、取り消しは出さぬ", async () => {
    const stored = {
      id: "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
      log_type: "feeding",
      logged_at: "2026-10-27T03:00:00+00:00",
      logged_by: "u1",
      feeding_type: "bottle",
      amount_ml: 160,
      updated_at: "2026-10-27T03:00:00.123456+00:00",
    } as unknown as BabyLogData
    mockedRecordFeeding.mockResolvedValueOnce({
      error: null,
      id: stored.id,
      replayed: true,
      updatedAt: stored.updated_at!,
      loggedAt: stored.logged_at,
      log: stored,
    })
    const onLogRecorded = vi.fn()
    renderActions({ onLogRecorded })
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledWith(stored))
    expect(mockedToast.success).toHaveBeenCalledWith(expect.stringContaining("記録済みでした"))
    const opts = mockedToast.success.mock.calls.at(-1)?.[1] as { action?: unknown } | undefined
    expect(opts?.action).toBeUndefined()
  })
})

describe("期限の後の同じ操作は別の記録として送り、黙っては送らぬ（v8）", () => {
  const OLD_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
  function seedOldUnknownPee() {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    expect(
      putPendingSave({
        schemaVersion: PENDING_SAVE_SCHEMA_VERSION,
        clientId: OLD_ID,
        owner: OWNER,
        action: "recordDiaper",
        payload: { diaperType: "pee", poopAmount: null, clientId: OLD_ID },
        summary: "おしっこ",
        firstAttemptAt: fiveMinutesAgo,
        phase: "unknown",
        unknownAt: fiveMinutesAgo,
        retryKey: "diaper:pee:",
      }),
    ).toBe(true)
  }

  it("確認中の同じ操作（期限切れ）が在る時の新しい記録は、新しい id で送り、別の記録であることと戻し方を知らせる", async () => {
    seedOldUnknownPee()
    mockedRecordDiaper.mockResolvedValueOnce({ error: null, id: "d-new" })
    renderActions()
    await clickWhenEnabled("おしっこ")
    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(1))
    const sent = mockedRecordDiaper.mock.calls[0][0] as { clientId: string }
    expect(sent.clientId).not.toBe(OLD_ID)
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith(
        `おむつ交換を記録しました（おしっこ）${SEPARATE_FROM_PENDING_NOTE}`,
        expect.anything(),
      ),
    )
    // 前の控えは確認中のまま残す（消せば、先の送信が成立しておった時の手がかりを失う）
    expect(listPendingSaves(OWNER).map((p) => p.clientId)).toContain(OLD_ID)
  })

  it("記録シートの控え（retryKey を持たぬ・送信内容が同じ種類）でも知らせる（独立レビュー v8rc1 V8-QN）", async () => {
    expect(
      putPendingSave({
        schemaVersion: PENDING_SAVE_SCHEMA_VERSION,
        clientId: OLD_ID,
        owner: OWNER,
        action: "recordDiaper",
        payload: { diaperType: "pee", poopAmount: null, loggedAt: new Date().toISOString(), clientId: OLD_ID },
        summary: "おむつ（おしっこ）",
        firstAttemptAt: new Date().toISOString(),
        phase: "unknown",
        unknownAt: new Date().toISOString(),
      }),
    ).toBe(true)
    mockedRecordDiaper.mockResolvedValueOnce({ error: null, id: "d-new" })
    renderActions()
    await clickWhenEnabled("おしっこ")
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith(
        `おむつ交換を記録しました（おしっこ）${SEPARATE_FROM_PENDING_NOTE}`,
        expect.anything(),
      ),
    )
  })

  it("対照: 種類の違う記録シートの控え（うんち）では、おしっこに知らせを出さぬ", async () => {
    expect(
      putPendingSave({
        schemaVersion: PENDING_SAVE_SCHEMA_VERSION,
        clientId: OLD_ID,
        owner: OWNER,
        action: "recordDiaper",
        payload: { diaperType: "poop", poopAmount: "large", clientId: OLD_ID },
        summary: "おむつ（うんち（大量））",
        firstAttemptAt: new Date().toISOString(),
        phase: "unknown",
        unknownAt: new Date().toISOString(),
      }),
    ).toBe(true)
    mockedRecordDiaper.mockResolvedValueOnce({ error: null, id: "d-new" })
    renderActions()
    await clickWhenEnabled("おしっこ")
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith("おむつ交換を記録しました（おしっこ）", expect.anything()),
    )
  })

  it("新しい id の送信が結果不明になっても、その後の押し直しでも、別の記録であることを落とさぬ（V8 QUICK-SEPARATE-NOTE-DROPPED）", async () => {
    seedOldUnknownPee()
    mockedRecordDiaper
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ error: null, id: "d-new", loggedAt: new Date().toISOString() })
    renderActions()
    await clickWhenEnabled("おしっこ")
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining(SEPARATE_FROM_PENDING_UNKNOWN_NOTE)),
    )
    // 期限内の押し直しは同じ新しい id（結果不明の後）— 受信時刻の注記に加えて、前の操作とは別の記録と言う
    await clickWhenEnabled("おしっこ")
    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(2))
    const [first, second] = mockedRecordDiaper.mock.calls.map((c) => (c[0] as { clientId: string }).clientId)
    expect(second).toBe(first)
    expect(first).not.toBe(OLD_ID)
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith(
        expect.stringContaining(SEPARATE_FROM_PENDING_NOTE),
        expect.anything(),
      ),
    )
  })

  it("新しい id の送信が記録済みでした（replayed）でも、別の記録であることを言う", async () => {
    seedOldUnknownPee()
    mockedRecordDiaper.mockResolvedValueOnce({ error: null, id: "d-new", replayed: true })
    renderActions()
    await clickWhenEnabled("おしっこ")
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith(expect.stringContaining(SEPARATE_FROM_PENDING_REPLAY_NOTE)),
    )
  })

  it("対照: 確認中の控えが無ければ、知らせは従来どおり", async () => {
    mockedRecordDiaper.mockResolvedValueOnce({ error: null, id: "d-new" })
    renderActions()
    await clickWhenEnabled("おしっこ")
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith(
        "おむつ交換を記録しました（おしっこ）",
        expect.anything(),
      ),
    )
  })
})

describe("今回だけ別の量（AC11 の入口）", () => {
  it("いつもの量で記録シートを開くだけで、いつもの量の保存も記録もせぬ", () => {
    const onCreateFeeding = vi.fn()
    renderActions({ onCreateFeeding })
    fireEvent.click(screen.getByRole("button", { name: "今回だけ別の量" }))
    expect(onCreateFeeding).toHaveBeenCalledWith("bottle", { amountMl: 160 })
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
    // 主ボタンの量は変わらぬ
    expect(screen.getByTestId("bottle-default-amount")).toHaveTextContent("160ml")
  })

  it("いつもの量が未設定・読めておらぬ時は出さぬ（量を知らぬまま開かぬ）", () => {
    renderActions({
      bottleDefault: { state: { status: "unset" }, refetch: vi.fn(async () => null), apply: vi.fn() },
    })
    expect(screen.queryByRole("button", { name: "今回だけ別の量" })).toBeNull()
  })
})
