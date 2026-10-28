/**
 * 育児日記の端末下書き（2026-10-27 テーマ B / AC07 の画面側）。
 *
 * - 同じ利用者・世帯・日付の下書きだけを「前回の下書きがあります」で戻す（自動では戻さぬ）
 * - 下書きの後に別の端末で日記が保存されておれば、その旨とサーバの本文を見せ、戻しても下書きを
 *   始めた時の版で送る（サーバの衝突 → 既存の衝突表示 = 自動で上書きせぬ）
 * - 保存成功・明示の破棄でその日の下書きだけを消す
 * - 端末へ書けぬ時は「下書き保存済み」と言わず、閉じる前に知らせる
 * - 入力中の値を書き戻さぬ（IME の変換中の値を壊さぬ）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/app/(main)/baby/actions", () => ({ upsertBabyDiary: vi.fn() }))

import { BabyDiaryEditSheet } from "../baby-diary-edit-sheet"
import { upsertBabyDiary } from "@/app/(main)/baby/actions"
import { draftStorageKey, writeDraft } from "@/lib/domain/draft-storage"
import { DRAFT_SAVE_DEBOUNCE_MS } from "@/lib/hooks/use-draft"

const mockedUpsert = vi.mocked(upsertBabyDiary)
const OWNER = { userId: "user-1", householdId: "house-1" }
const V1 = "2026-07-20T03:00:00.111111+00:00"
const V2 = "2026-07-20T03:05:00.222222+00:00"
const DATE = "2026-07-20"

function sheet(over: Partial<Parameters<typeof BabyDiaryEditSheet>[0]> = {}) {
  return (
    <BabyDiaryEditSheet
      open
      onOpenChange={vi.fn()}
      diaryDate={DATE}
      initialContent=""
      initialUpdatedAt={null}
      onSaved={vi.fn()}
      owner={OWNER}
      {...over}
    />
  )
}
const textarea = () => screen.getByLabelText("日記本文") as HTMLTextAreaElement
const stored = (date = DATE, owner = OWNER) =>
  localStorage.getItem(draftStorageKey(owner, { kind: "diary", date }))

beforeEach(() => {
  mockedUpsert.mockReset()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("日記の下書き: 閉じる・再読込で戻せる（AC07）", () => {
  it("打った本文は端末に残り、開き直すと「前回の下書きがあります」から戻せる。保存の成功で消える", async () => {
    const first = render(sheet())
    fireEvent.change(textarea(), { target: { value: "はじめて寝返りした" } })
    // 打ち終わり（DRAFT_SAVE_DEBOUNCE_MS）を待たずに閉じても、アンマウントで書き切る
    first.unmount()
    expect(JSON.parse(stored()!).content).toEqual({ text: "はじめて寝返りした" })

    render(sheet())
    // 自動では戻さぬ（入力欄はサーバの本文 = 空のまま）
    expect(textarea().value).toBe("")
    expect(screen.getByText("前回の下書きがあります")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "戻す" }))
    expect(textarea().value).toBe("はじめて寝返りした")

    mockedUpsert.mockResolvedValue({
      error: null,
      diary: { id: "d1", diary_date: DATE, content: "はじめて寝返りした", updated_at: V1 },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await waitFor(() => expect(mockedUpsert).toHaveBeenCalledWith(DATE, "はじめて寝返りした", null))
    await waitFor(() => expect(stored()).toBeNull())
  })

  it("別の日・別の利用者の下書きは出さぬ（入れ違えぬ）", () => {
    writeDraft(OWNER, { kind: "diary", date: "2026-07-19" }, null, { text: "19日の下書き" })
    writeDraft({ userId: "user-2", householdId: "house-1" }, { kind: "diary", date: DATE }, null, {
      text: "別の利用者の下書き",
    })
    render(sheet())
    expect(screen.queryByText("前回の下書きがあります")).not.toBeInTheDocument()
    expect(screen.queryByText(/19日の下書き|別の利用者の下書き/)).not.toBeInTheDocument()
  })

  it("戻す/破棄を選ぶまで入力を止め、前の下書きを上書きも取りこぼしもせぬ（独立レビュー 2 周の指摘）", () => {
    writeDraft(OWNER, { kind: "diary", date: DATE }, null, { text: "前の長い下書き" })
    const first = render(sheet())
    expect(screen.getByText("前回の下書きがあります")).toBeInTheDocument()
    // 選ぶ前は打てぬ（打てると、前の下書きを上書きするか、打った本文を残せぬかのどちらかになる）
    expect(textarea()).toBeDisabled()
    expect(screen.getByText(/「戻す」か「破棄」を選ぶと入力・保存できます/)).toBeInTheDocument()
    // 保持の注記（7日間残ります）は、残しておらぬ間は出さぬ
    expect(screen.queryByText(/7日間残ります/)).toBeNull()
    first.unmount()
    expect(JSON.parse(stored()!).content).toEqual({ text: "前の長い下書き" })
    render(sheet())
    fireEvent.click(screen.getByRole("button", { name: "戻す" }))
    expect(textarea()).not.toBeDisabled()
    expect(textarea().value).toBe("前の長い下書き")
  })

  it("「戻す/破棄」を選ぶまでは保存もさせず、選んでおらぬ前回の下書きは残る（独立レビュー 3 周目）", () => {
    writeDraft(OWNER, { kind: "diary", date: DATE }, V1, { text: "選んでおらぬ下書き" })
    render(sheet({ initialContent: "サーバの本文", initialUpdatedAt: V1 }))
    expect(screen.getByText("前回の下書きがあります")).toBeInTheDocument()
    const save = screen.getByRole("button", { name: "保存する" })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(mockedUpsert).not.toHaveBeenCalled()
    expect(JSON.parse(stored()!).content).toEqual({ text: "選んでおらぬ下書き" })
    // 選べば保存できる
    fireEvent.click(screen.getByRole("button", { name: "破棄" }))
    expect(screen.getByRole("button", { name: "保存する" })).not.toBeDisabled()
  })

  it("「破棄」を選んだ後に打った本文は下書きとして残る（逆向きの消失をせぬ）", () => {
    writeDraft(OWNER, { kind: "diary", date: DATE }, null, { text: "捨てる下書き" })
    const first = render(sheet())
    fireEvent.click(screen.getByRole("button", { name: "破棄" }))
    expect(textarea()).not.toBeDisabled()
    fireEvent.change(textarea(), { target: { value: "新しく書いた本文" } })
    first.unmount()
    expect(JSON.parse(stored()!).content).toEqual({ text: "新しく書いた本文" })
  })

  it("対照: 「戻す」を選んだ後の入力は下書きへ書く", () => {
    writeDraft(OWNER, { kind: "diary", date: DATE }, null, { text: "前の下書き" })
    const first = render(sheet())
    fireEvent.click(screen.getByRole("button", { name: "戻す" }))
    fireEvent.change(textarea(), { target: { value: "前の下書きに足した" } })
    first.unmount()
    expect(JSON.parse(stored()!).content).toEqual({ text: "前の下書きに足した" })
  })

  it("「破棄」はこの日の下書きだけを消す", () => {
    writeDraft(OWNER, { kind: "diary", date: DATE }, null, { text: "捨てる下書き" })
    writeDraft(OWNER, { kind: "diary", date: "2026-07-19" }, null, { text: "残る下書き" })
    render(sheet())
    fireEvent.click(screen.getByRole("button", { name: "破棄" }))
    expect(stored()).toBeNull()
    expect(stored("2026-07-19")).not.toBeNull()
    expect(screen.queryByText("前回の下書きがあります")).not.toBeInTheDocument()
  })

  it("サーバの本文と同じ下書きは出さず、片付ける（保存は済んでおる）", () => {
    writeDraft(OWNER, { kind: "diary", date: DATE }, V1, { text: "同じ本文" })
    render(sheet({ initialContent: "同じ本文", initialUpdatedAt: V2 }))
    expect(screen.queryByText("前回の下書きがあります")).not.toBeInTheDocument()
    expect(stored()).toBeNull()
  })
})

describe("日記の下書き: 別の端末で更新されていた時（自動で上書きせぬ）", () => {
  it("版が違う下書きはその旨とサーバの本文を出し、戻しても下書きを始めた時の版で送る", async () => {
    writeDraft(OWNER, { kind: "diary", date: DATE }, V1, { text: "わたしの下書き" })
    render(sheet({ initialContent: "家族が書いた本文", initialUpdatedAt: V2 }))
    expect(screen.getByText(/この日の日記は別の端末で更新されています/)).toBeInTheDocument()
    // 入力欄はサーバの本文のまま
    expect(textarea().value).toBe("家族が書いた本文")

    fireEvent.click(screen.getByRole("button", { name: "戻す" }))
    expect(textarea().value).toBe("わたしの下書き")
    // サーバの今の本文を並べて見せる
    expect(screen.getByText("家族が書いた本文")).toBeInTheDocument()

    mockedUpsert.mockResolvedValue({
      error: "この日の日記は別の端末で先に保存されていました（家族またはご自身）。",
      conflict: {
        current: { id: "d1", diary_date: DATE, content: "家族が書いた本文", updated_at: V2 },
      },
    } as never)
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    // 下書きの版（V1）で送る = 今の版（V2）で無条件に上書きせぬ
    await waitFor(() => expect(mockedUpsert).toHaveBeenCalledWith(DATE, "わたしの下書き", V1))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "上書きして保存する" })).toBeInTheDocument(),
    )
    // 衝突の後も下書きは残る
    expect(stored()).not.toBeNull()
  })
})

describe("日記の下書き: 端末へ書けぬ時", () => {
  it("書けなんだら「下書き保存済み」と言わず理由を出し、閉じる前に入力が消えると知らせる", async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError")
      })
      const onOpenChange = vi.fn()
      render(sheet({ onOpenChange }))
      fireEvent.change(textarea(), { target: { value: "残せない本文" } })
      act(() => {
        vi.advanceTimersByTime(DRAFT_SAVE_DEBOUNCE_MS + 10)
      })
      expect(screen.getByRole("alert")).toHaveTextContent(/下書きを残せませんでした/)
      expect(screen.queryByText(/下書き保存済み/)).not.toBeInTheDocument()

      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
      expect(screen.getByRole("button", { name: "編集を続ける" })).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "入力を捨てて閉じる" }))
      expect(onOpenChange).toHaveBeenCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("書けた時は保持期限の注記を出す（バックアップではない）", () => {
    render(sheet())
    expect(screen.getByText(/この端末のこのブラウザにだけ7日間残ります/)).toBeInTheDocument()
  })
})

describe("日記の下書き: 入力中の値を書き戻さぬ", () => {
  it("前後の空白・改行・変換中の文字を整形せず、そのまま入力欄と下書きに持つ", () => {
    const view = render(sheet())
    const raw = "  きょうは\n\nｶﾞ" // 半角カナ・空行・先頭の空白（変換前の形を模す）
    fireEvent.change(textarea(), { target: { value: raw } })
    expect(textarea().value).toBe(raw)
    view.unmount()
    expect(JSON.parse(stored()!).content.text).toBe(raw)
  })
})
