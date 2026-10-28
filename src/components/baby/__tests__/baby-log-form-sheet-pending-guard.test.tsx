/**
 * 記録シートを結果不明のまま閉じ、開き直して入れ直した時に、黙って新しい id で 2 件目を送らぬこと
 * （独立レビュー 2026-10-28 v7 F2 / 受入 AC05「元の保存結果を無視して新IDを作らない」）。
 *
 * シートは開くたびに key で作り直され、新しい冪等 id を持つ。同じ種類の、保存されておりうる控え
 * （記録シート・クイック記録のどちらの控えも）が端末に在る間は、新しい id で送る前に明示の確認を挟む。
 * 確認すれば別の記録として送る（同じ種類の 2 回目の記録という別の意図は止めぬ）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import { act } from "react"

vi.mock("@/app/(main)/baby/actions", () => ({
  updateLog: vi.fn(),
  deleteLog: vi.fn(),
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { BabyLogFormSheet } from "../baby-log-form-sheet"
import { recordDiaper, recordFeeding, recordMemo } from "@/app/(main)/baby/actions"
import { writePersistedTimer } from "@/lib/domain/feeding-timer-storage"
import {
  PAGE_LIFE_ID,
  PENDING_SAVE_SCHEMA_VERSION,
  listPendingSaves,
  putPendingSave,
  type PendingSave,
} from "@/lib/domain/pending-saves-storage"

const mockedRecordMemo = vi.mocked(recordMemo)
const mockedRecordDiaper = vi.mocked(recordDiaper)
const mockedRecordFeeding = vi.mocked(recordFeeding)

const OWNER = { userId: "u1", householdId: "h1" }
const OTHER_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"

// 返らぬ送信（遅い回線）の解決口。React 19 の async transition は絡み合うゆえ、残すと次の試験のシートの
// isPending まで立ったままになる — 試験の終わりに必ず解決させる
const hanging: Array<() => void> = []

beforeEach(() => {
  vi.clearAllMocks()
  mockedRecordMemo.mockReset()
  mockedRecordDiaper.mockReset()
  mockedRecordFeeding.mockReset()
  localStorage.clear()
  cleanup()
})
afterEach(async () => {
  cleanup()
  await act(async () => {
    while (hanging.length > 0) hanging.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

function renderSheet(createLogType: "memo" | "diaper" | "feeding") {
  return render(
    <BabyLogFormSheet
      open
      onOpenChange={vi.fn()}
      log={null}
      createLogType={createLogType}
      userId={OWNER.userId}
      householdId={OWNER.householdId}
    />,
  )
}

function typeMemo(value: string) {
  fireEvent.change(screen.getByLabelText("メモ"), { target: { value } })
}

async function pressRecord() {
  fireEvent.click(await screen.findByRole("button", { name: "記録する" }))
}

function memoClientIdOf(index: number): string | undefined {
  return (mockedRecordMemo.mock.calls[index]?.[0] as { clientId?: string } | undefined)?.clientId
}

const TIMER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
/** 停止の保存が結果不明のまま残った授乳タイマー（feeding-timer-storage の形） */
function seedTimerSubmission(userId: string): void {
  const startedAt = new Date(Date.now() - 10 * 60_000).toISOString()
  expect(
    writePersistedTimer({
      startedAt,
      feedingType: "breast_left",
      leftCount: 1,
      rightCount: 0,
      userId,
      householdId: OWNER.householdId,
      clientId: TIMER_ID,
      submission: {
        firstAttemptAt: new Date().toISOString(),
        phase: "unknown",
        payload: {
          feedingType: "breast",
          breastLeftCount: 1,
          breastRightCount: 0,
          breastStartSide: "left",
          breastLeftSec: 600,
          breastRightSec: 0,
          loggedAt: startedAt,
          clientId: TIMER_ID,
        },
      },
    }),
  ).toBe(true)
}

function seedPending(overrides: Partial<PendingSave>): void {
  const ok = putPendingSave({
    schemaVersion: PENDING_SAVE_SCHEMA_VERSION,
    clientId: OTHER_ID,
    owner: OWNER,
    action: "recordMemo",
    payload: { memo: "前のメモ", clientId: OTHER_ID },
    summary: "メモ",
    firstAttemptAt: new Date().toISOString(),
    phase: "unknown",
    unknownAt: new Date().toISOString(),
    ...overrides,
  })
  expect(ok).toBe(true)
}

describe("記録シート: 結果不明の控えが在る間は、黙って新しい id で送らぬ（F2）", () => {
  it("unknown → 閉じる → 開き直す → 入れ直す → 押す: 送らずに確認を出し、確認すれば別の記録として新しい id で送る", async () => {
    mockedRecordMemo
      .mockRejectedValueOnce(new Error("network down")) // 1 枚目: 応答を失う（保存されたかもしれぬ）
      .mockResolvedValueOnce({ error: null, id: "m2" })

    const first = renderSheet("memo")
    typeMemo("ミルク多め")
    await pressRecord()
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(1))
    expect(listPendingSaves(OWNER)[0]).toMatchObject({ phase: "unknown", action: "recordMemo" })
    first.unmount() // シートを閉じた（親は次に開く時 key で作り直す）

    renderSheet("memo")
    typeMemo("ミルク多め")
    await pressRecord()

    // 送らぬ。確認を出し、同じ記録なら確認中の記録から確かめるよう示す
    const guard = await screen.findByRole("alert")
    expect(guard).toHaveTextContent("保存を確認中の記録")
    expect(guard).toHaveTextContent("メモ")
    // 対照: タイマーの項目が無ければ、タイマーで確かめる案内は出さぬ
    expect(guard).not.toHaveTextContent("授乳タイマーを開いて")
    expect(mockedRecordMemo).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "別の記録として記録する" }))
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(2))
    // 別の意図として明示に選んだゆえ、1 枚目とは別の id
    expect(memoClientIdOf(1)).toMatch(/^[0-9a-f-]{36}$/)
    expect(memoClientIdOf(1)).not.toBe(memoClientIdOf(0))
  })

  it("対照: 控えが無ければ確認を出さず、そのまま送る", async () => {
    mockedRecordMemo.mockResolvedValueOnce({ error: null, id: "m1" })
    renderSheet("memo")
    typeMemo("ミルク多め")
    await pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("クイック記録の控え（同じ種類・retryKey つき）でも、記録シートは確認を挟む", async () => {
    seedPending({
      action: "recordDiaper",
      payload: { diaperType: "pee", clientId: OTHER_ID },
      summary: "おむつ（おしっこ）",
      retryKey: "diaper:pee",
    })
    mockedRecordDiaper.mockResolvedValueOnce({ error: null, id: "d1" })
    renderSheet("diaper")
    await pressRecord()
    expect(await screen.findByRole("alert")).toHaveTextContent("おむつ（おしっこ）")
    expect(mockedRecordDiaper).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "別の記録として記録する" }))
    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(1))
  })

  it("対照: 別の利用者の控えでは確認を出さぬ（持ち主で絞る）", async () => {
    seedPending({ owner: { userId: "someone-else", householdId: "h1" } })
    mockedRecordMemo.mockResolvedValueOnce({ error: null, id: "m1" })
    renderSheet("memo")
    typeMemo("a")
    await pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("対照: 別の種類の控え（体温）では、メモの記録に確認を出さぬ", async () => {
    seedPending({
      action: "recordTemperature",
      payload: { temperature: 37.2, clientId: OTHER_ID },
      summary: "体温 37.2℃",
    })
    mockedRecordMemo.mockResolvedValueOnce({ error: null, id: "m1" })
    renderSheet("memo")
    typeMemo("a")
    await pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("先の送信がまだ返らぬまま閉じて開き直し、入れ直して押しても、送らずに確認を出す（独立レビュー v8rc1 V8-F2R）", async () => {
    // 1 枚目の送信は返らぬ（遅い回線）。控えは「このページで送信中」（mayHaveLanded は false）のまま残る —
    // 別のシートの送信ゆえ、新しい id で送れば 2 件目になりうる
    mockedRecordMemo.mockImplementationOnce(
      () => new Promise((resolve) => hanging.push(() => resolve({ error: null, id: "late" }))),
    )
    const first = renderSheet("memo")
    typeMemo("ミルク多め")
    await pressRecord()
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(1))
    expect(listPendingSaves(OWNER)[0]).toMatchObject({ phase: "sending", pageId: PAGE_LIFE_ID })
    first.unmount()

    renderSheet("memo")
    typeMemo("ミルク多め")
    await pressRecord()
    const guard = await screen.findByRole("alert")
    // 送信中のものは一覧（保存を確認中の記録）にまだ出ぬ — そう言う
    expect(guard).toHaveTextContent("送信中")
    expect(mockedRecordMemo).toHaveBeenCalledTimes(1)
  })

  it("授乳タイマーの停止の保存が結果不明のまま残っておれば、授乳の記録シートも確認を出す（v8rc2 TIMER-UNKNOWN-NOT-IN-SHEET-GUARD）", async () => {
    seedTimerSubmission(OWNER.userId)
    mockedRecordFeeding.mockResolvedValueOnce({ error: null, id: "f1" })
    renderSheet("feeding")
    await pressRecord()
    const guard = await screen.findByRole("alert")
    expect(guard).toHaveTextContent("母乳（授乳タイマー）")
    // タイマーの送信は確認中の記録の一覧に出ぬゆえ、確かめる場所を言い分ける（v8rc3 RC3-SHEET-TIMER-COPY）
    expect(guard).toHaveTextContent("授乳タイマーを開いて「記録されたか確かめる」")
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
  })

  it("対照: 別の利用者のタイマーの送信内容では確認を出さぬ", async () => {
    seedTimerSubmission("someone-else")
    mockedRecordFeeding.mockResolvedValueOnce({ error: null, id: "f1" })
    renderSheet("feeding")
    await pressRecord()
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("作成が同じ id の別の内容と衝突したら、同じ衝突にしかならぬ「記録する」を止め、開き直すよう示す（v8rc2 SHEET-CONFLICT-DEAD-END）", async () => {
    mockedRecordMemo.mockResolvedValueOnce({ error: "別の内容で記録済み", id: null, failure: "conflict" })
    renderSheet("memo")
    typeMemo("a")
    await pressRecord()
    expect(await screen.findByText(/閉じて開き直してから記録してください/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "記録する" })).toBeDisabled()
  })

  it("対照: 拒否（保存の前に拒まれた）なら「記録する」は押せるまま", async () => {
    mockedRecordMemo.mockResolvedValueOnce({ error: "メモが長すぎます", id: null, failure: "rejected" })
    renderSheet("memo")
    typeMemo("a")
    await pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole("button", { name: "記録する" })).not.toBeDisabled())
    expect(screen.queryByText(/閉じて開き直してから記録してください/)).toBeNull()
  })

  it("同じシートの結果不明の後の押し直しは、自分の控え（同じ id）ゆえ確認を挟まず同じ id で送る", async () => {
    mockedRecordMemo
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: null, id: "m1" })
    renderSheet("memo")
    typeMemo("a")
    await pressRecord()
    await waitFor(() => expect(listPendingSaves(OWNER)).toHaveLength(1))
    await pressRecord()
    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalledTimes(2))
    expect(memoClientIdOf(1)).toBe(memoClientIdOf(0))
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
