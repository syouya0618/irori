import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react"
import type { BabyDiaryData } from "@/lib/types/baby"

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/app/(main)/baby/actions", () => ({
  upsertBabyDiary: vi.fn(),
}))

import { BabyDiaryEditSheet } from "../baby-diary-edit-sheet"
import { upsertBabyDiary } from "@/app/(main)/baby/actions"
import { toast } from "sonner"

const mockedUpsert = vi.mocked(upsertBabyDiary)

beforeEach(() => {
  mockedUpsert.mockReset()
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.success).mockClear()
})
afterEach(cleanup)

const savedDiary: BabyDiaryData = {
  id: "d1",
  diary_date: "2026-07-20",
  content: "今日は散歩",
  updated_at: "2026-07-22T12:00:00+09:00",
}

describe("BabyDiaryEditSheet（育児日記の編集・1日1本）", () => {
  it("保存で upsertBabyDiary(対象日, 本文) を呼び、成功時に onSaved と close が走る", async () => {
    mockedUpsert.mockResolvedValue({ error: null, diary: savedDiary })
    const onSaved = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={onOpenChange}
        diaryDate="2026-07-20"
        initialContent="既存の本文"
        onSaved={onSaved}
      />,
    )
    // 既存本文が seed される
    expect(
      (screen.getByLabelText("日記本文") as HTMLTextAreaElement).value,
    ).toBe("既存の本文")

    fireEvent.change(screen.getByLabelText("日記本文"), {
      target: { value: "今日は散歩" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() => expect(mockedUpsert).toHaveBeenCalled())
    expect(mockedUpsert).toHaveBeenCalledWith("2026-07-20", "今日は散歩")
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedDiary))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("日記を保存しました")
  })

  it("空保存の成功（diary: null）は削除トーストを出し onSaved(null) を渡す", async () => {
    mockedUpsert.mockResolvedValue({ error: null, diary: null })
    const onSaved = vi.fn()
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={() => {}}
        diaryDate="2026-07-20"
        initialContent="消す前の本文"
        onSaved={onSaved}
      />,
    )
    fireEvent.change(screen.getByLabelText("日記本文"), {
      target: { value: "" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null))
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("日記を削除しました")
  })

  it("action がエラーを返すと toast.error を出し、onSaved は呼ばれずシートは開いたまま", async () => {
    mockedUpsert.mockResolvedValue({ error: "未来の日記は書けません", diary: null })
    const onSaved = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={onOpenChange}
        diaryDate="2026-07-20"
        initialContent=""
        onSaved={onSaved}
      />,
    )
    fireEvent.change(screen.getByLabelText("日記本文"), {
      target: { value: "x" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "未来の日記は書けません",
      ),
    )
    expect(onSaved).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("action が reject（通信断）すると圏外トーストへ倒し握り潰さない", async () => {
    mockedUpsert.mockRejectedValue(new Error("network down"))
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={() => {}}
        diaryDate="2026-07-20"
        initialContent=""
        onSaved={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText("日記本文"), {
      target: { value: "x" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "通信できませんでした。電波の良い場所でもう一度お試しください",
      ),
    )
  })
})
