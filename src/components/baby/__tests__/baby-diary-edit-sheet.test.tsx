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

const SEED_VERSION = "2026-07-22T03:00:00.111111+00:00"
const SPOUSE_VERSION = "2026-07-22T03:05:00.222222+00:00"

const savedDiary: BabyDiaryData = {
  id: "d1",
  diary_date: "2026-07-20",
  content: "今日は散歩",
  updated_at: "2026-07-22T12:00:00+09:00",
}

function textarea() {
  return screen.getByLabelText("日記本文") as HTMLTextAreaElement
}

describe("BabyDiaryEditSheet / 開いた日の日記として保存する", () => {
  // 開いている最中に親の選択日が動いても（日跨ぎの自動追従など）、書いている本文は
  // 開いた日のもの。prop の diaryDate をそのまま保存に使うと、前日の本文を翌日の
  // 日記として upsert し、前日の日記は保存されぬ（dashboard の W-1 注記が禁じる経路）。
  it("開いた後に diaryDate prop が変わっても、開いた日付で保存し見出しも変えぬ", async () => {
    mockedUpsert.mockResolvedValue({ error: null, diary: savedDiary })
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      initialContent: "",
      initialUpdatedAt: null,
      onSaved: vi.fn(),
    }
    const { rerender } = render(
      <BabyDiaryEditSheet {...props} diaryDate="2026-07-20" />,
    )
    const heading = screen.getByText(/空にして保存すると/).textContent
    fireEvent.change(screen.getByLabelText("日記本文"), {
      target: { value: "夜遅くの日記" },
    })

    rerender(<BabyDiaryEditSheet {...props} diaryDate="2026-07-21" />)
    expect(screen.getByText(/空にして保存すると/).textContent).toBe(heading)

    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    await waitFor(() =>
      expect(mockedUpsert).toHaveBeenCalledWith("2026-07-20", "夜遅くの日記", null),
    )
    // 親が「選択日の日記か」を確かめられるよう、書いた日を添えて返す
    await waitFor(() =>
      expect(props.onSaved).toHaveBeenCalledWith(savedDiary, "2026-07-20"),
    )
  })
})

describe("BabyDiaryEditSheet（育児日記の編集・1日1本）", () => {
  it("保存で upsertBabyDiary(対象日, 本文, 開いた時の版) を呼び、成功時に onSaved と close が走る", async () => {
    mockedUpsert.mockResolvedValue({ error: null, diary: savedDiary })
    const onSaved = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={onOpenChange}
        diaryDate="2026-07-20"
        initialContent="既存の本文"
        initialUpdatedAt={SEED_VERSION}
        onSaved={onSaved}
      />,
    )
    // 既存本文が seed される
    expect(textarea().value).toBe("既存の本文")

    fireEvent.change(textarea(), { target: { value: "今日は散歩" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() => expect(mockedUpsert).toHaveBeenCalled())
    // 版（updated_at）は文字列のまま渡す（Date を通すとマイクロ秒が落ちて常に衝突する）
    expect(mockedUpsert).toHaveBeenCalledWith("2026-07-20", "今日は散歩", SEED_VERSION)
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(savedDiary, "2026-07-20"),
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("日記を保存しました")
  })

  it("日記が無い日から開いたら版 null（＝行が無いことを期待）で保存する", async () => {
    mockedUpsert.mockResolvedValue({ error: null, diary: savedDiary })
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={() => {}}
        diaryDate="2026-07-20"
        initialContent=""
        initialUpdatedAt={null}
        onSaved={() => {}}
      />,
    )
    fireEvent.change(textarea(), { target: { value: "はじめての日記" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() =>
      expect(mockedUpsert).toHaveBeenCalledWith("2026-07-20", "はじめての日記", null),
    )
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
        initialUpdatedAt={SEED_VERSION}
        onSaved={onSaved}
      />,
    )
    fireEvent.change(textarea(), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null, "2026-07-20"))
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
        initialUpdatedAt={null}
        onSaved={onSaved}
      />,
    )
    fireEvent.change(textarea(), { target: { value: "x" } })
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
        initialUpdatedAt={null}
        onSaved={() => {}}
      />,
    )
    fireEvent.change(textarea(), { target: { value: "x" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "通信できませんでした。電波の良い場所でもう一度お試しください",
      ),
    )
  })
})

// 衝突の主体は判別できない（応答が失われた自分の保存・同じ利用者の別端末も同じ形で
// 衝突する）ため、文言は「家族が」と断定しない。
const CONFLICT_HEADING = "この日の日記は別の端末で先に保存されていました（家族またはご自身）"
const CONFLICT_ERROR = `${CONFLICT_HEADING}。`

describe("BabyDiaryEditSheet の保存衝突（P1-06: 下書きを捨てない）", () => {
  const spouseDiary: BabyDiaryData = {
    id: "d1",
    diary_date: "2026-07-20",
    content: "配偶者が先に書いた本文",
    updated_at: SPOUSE_VERSION,
  }

  it("衝突しても下書きは textarea に残り、先に保存されていた本文を並べて見せ、シートは閉じない", async () => {
    mockedUpsert.mockResolvedValue({
      error: CONFLICT_ERROR,
      diary: null,
      conflict: { current: spouseDiary },
    })
    const onOpenChange = vi.fn()
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={onOpenChange}
        diaryDate="2026-07-20"
        initialContent="開いた時の本文"
        initialUpdatedAt={SEED_VERSION}
        onSaved={() => {}}
      />,
    )
    fireEvent.change(textarea(), { target: { value: "わたしの下書き" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    expect(await screen.findByText(CONFLICT_HEADING)).toBeInTheDocument()
    // 下書きは捨てない
    expect(textarea().value).toBe("わたしの下書き")
    // サーバの最新本文を並べて見せる
    expect(screen.getByText("先に保存されていた本文")).toBeInTheDocument()
    expect(screen.getByText("配偶者が先に書いた本文")).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
  })

  it("衝突の表示は書いた人を断定しない（自分の別端末・応答が失われた自分の保存でも嘘にならない）", async () => {
    mockedUpsert.mockResolvedValue({
      error: CONFLICT_ERROR,
      diary: null,
      conflict: { current: spouseDiary },
    })
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={() => {}}
        diaryDate="2026-07-20"
        initialContent="開いた時の本文"
        initialUpdatedAt={SEED_VERSION}
        onSaved={() => {}}
      />,
    )
    fireEvent.change(textarea(), { target: { value: "わたしの下書き" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("家族またはご自身")
    expect(alert).not.toHaveTextContent("家族が先に")
    expect(alert).not.toHaveTextContent("家族が保存した本文")
    expect(alert).not.toHaveTextContent("家族の本文")
  })

  it("衝突後に下書きが空なら、保存は削除だと明示する（ボタンも案内文も「上書き」と言わない）", async () => {
    mockedUpsert
      .mockResolvedValueOnce({
        error: CONFLICT_ERROR,
        diary: null,
        conflict: { current: spouseDiary },
      })
      .mockResolvedValueOnce({ error: null, diary: null })
    // 取得失敗で空欄に見えていた日を開き、書くのをやめて空のまま保存した経路
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={() => {}}
        diaryDate="2026-07-20"
        initialContent=""
        initialUpdatedAt={null}
        onSaved={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    const deleteButton = await screen.findByRole("button", {
      name: "保存されている日記を削除する",
    })
    expect(screen.queryByRole("button", { name: "上書きして保存する" })).toBeNull()
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent(
      "下書きが空のため、保存すると先に保存されていた本文ごと削除されます",
    )
    expect(alert).not.toHaveTextContent("上書きして保存する")
    // 破壊的な操作として見た目でも区別する
    expect(deleteButton.className).toMatch(/destructive/)

    // 明示の削除はできる（サーバの版ガードはそのまま。版は先に保存されていた行へ進む）
    fireEvent.click(deleteButton)
    await waitFor(() => expect(mockedUpsert).toHaveBeenCalledTimes(2))
    expect(mockedUpsert).toHaveBeenNthCalledWith(2, "2026-07-20", "", SPOUSE_VERSION)
  })

  it("衝突後の空判定は今の下書きで行う（書き足せば「上書きして保存する」へ戻り、空白だけなら削除のまま）", async () => {
    mockedUpsert.mockResolvedValue({
      error: CONFLICT_ERROR,
      diary: null,
      conflict: { current: spouseDiary },
    })
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={() => {}}
        diaryDate="2026-07-20"
        initialContent="開いた時の本文"
        initialUpdatedAt={SEED_VERSION}
        onSaved={() => {}}
      />,
    )
    fireEvent.change(textarea(), { target: { value: "わたしの下書き" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))
    expect(
      await screen.findByRole("button", { name: "上書きして保存する" }),
    ).toBeInTheDocument()

    // 空白だけ（サーバは trim して空保存＝削除として扱う）
    fireEvent.change(textarea(), { target: { value: "  \n " } })
    expect(
      screen.getByRole("button", { name: "保存されている日記を削除する" }),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "上書きして保存する" })).toBeNull()

    fireEvent.change(textarea(), { target: { value: "書き直した" } })
    expect(
      screen.getByRole("button", { name: "上書きして保存する" }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "保存されている日記を削除する" }),
    ).toBeNull()
  })

  it("衝突後の保存は current.updated_at を版として送る（＝意図した上書き）", async () => {
    mockedUpsert
      .mockResolvedValueOnce({
        error: CONFLICT_ERROR,
        diary: null,
        conflict: { current: spouseDiary },
      })
      .mockResolvedValueOnce({ error: null, diary: savedDiary })
    const onSaved = vi.fn()
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={() => {}}
        diaryDate="2026-07-20"
        initialContent=""
        initialUpdatedAt={SEED_VERSION}
        onSaved={onSaved}
      />,
    )
    fireEvent.change(textarea(), { target: { value: "わたしの下書き" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    const overwrite = await screen.findByRole("button", { name: "上書きして保存する" })
    fireEvent.click(overwrite)

    await waitFor(() => expect(mockedUpsert).toHaveBeenCalledTimes(2))
    expect(mockedUpsert).toHaveBeenNthCalledWith(1, "2026-07-20", "わたしの下書き", SEED_VERSION)
    expect(mockedUpsert).toHaveBeenNthCalledWith(2, "2026-07-20", "わたしの下書き", SPOUSE_VERSION)
    await waitFor(() =>
      expect(onSaved).toHaveBeenLastCalledWith(savedDiary, "2026-07-20"),
    )
  })

  it("衝突時は親へサーバの最新（current）を渡し、背後の表示を揃える", async () => {
    mockedUpsert.mockResolvedValue({
      error: CONFLICT_ERROR,
      diary: null,
      conflict: { current: spouseDiary },
    })
    const onSaved = vi.fn()
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={() => {}}
        diaryDate="2026-07-20"
        initialContent=""
        initialUpdatedAt={null}
        onSaved={onSaved}
      />,
    )
    fireEvent.change(textarea(), { target: { value: "空欄から書いた一言" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(spouseDiary, "2026-07-20"),
    )
    expect(textarea().value).toBe("空欄から書いた一言")
  })

  it("他端末で削除されていた衝突（current: null）は削除を伝え、次の保存は版 null で送る", async () => {
    mockedUpsert
      .mockResolvedValueOnce({
        error: "この日の日記は他の端末で削除されていました。",
        diary: null,
        conflict: { current: null },
      })
      .mockResolvedValueOnce({ error: null, diary: savedDiary })
    render(
      <BabyDiaryEditSheet
        open={true}
        onOpenChange={() => {}}
        diaryDate="2026-07-20"
        initialContent="消される前の本文"
        initialUpdatedAt={SEED_VERSION}
        onSaved={() => {}}
      />,
    )
    fireEvent.change(textarea(), { target: { value: "書き足した本文" } })
    fireEvent.click(screen.getByRole("button", { name: "保存する" }))

    expect(
      await screen.findByText("この日の日記は他の端末で削除されていました"),
    ).toBeInTheDocument()
    expect(textarea().value).toBe("書き足した本文")

    // 衝突の表示は await 後の通常の更新で先に描かれ、isPending（transition）は遅れて解ける。
    // 「保存中...」のうちに同期で引くと負荷しだいで落ちる（実測）ゆえ、ラベルが戻るのを待つ。
    fireEvent.click(await screen.findByRole("button", { name: "保存する" }))
    await waitFor(() => expect(mockedUpsert).toHaveBeenCalledTimes(2))
    expect(mockedUpsert).toHaveBeenNthCalledWith(2, "2026-07-20", "書き足した本文", null)
  })
})
