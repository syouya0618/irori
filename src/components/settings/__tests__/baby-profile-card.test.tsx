/**
 * 赤ちゃん情報カード。
 *
 * ## P2-30: 保存の後に入力が古い値へ戻らぬこと
 * `<form action={fn}>` は React 19 が action の後で**無条件に**フォームを reset する。
 * select の defaultValue は初回描画の後は更新されぬゆえ、reset で初回の値（3時間）へ
 * 戻り、続けて名前だけを直して保存すると**授乳間隔が黙って巻き戻る**。
 * 実ブラウザと同じく保存ボタンを押して React の form 処理を通す（React は mock せぬ）。
 *
 * ## P2-31: 読めなかった時に空欄のフォームを出さぬこと
 * 世帯の取得に失敗した時に空欄で描けば、保存で名前と生年月日を NULL に上書きする。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { renderToString } from "react-dom/server"

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock("@/app/(main)/settings/actions", () => ({
  updateBabyProfile: vi.fn(),
}))

import { BabyProfileCard } from "../baby-profile-card"
import { updateBabyProfile } from "@/app/(main)/settings/actions"
import { toast } from "sonner"

const mockedUpdate = vi.mocked(updateBabyProfile)
const mockedToast = vi.mocked(toast)

const intervalSelect = () =>
  screen.getByLabelText("授乳間隔") as HTMLSelectElement
const nameInput = () => screen.getByLabelText("名前") as HTMLInputElement

/** n 回目の保存で送られた FormData */
const submitted = (n: number) => mockedUpdate.mock.calls[n][0] as FormData

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

describe("BabyProfileCard — 保存後に古い値へ戻らぬ（P2-30）", () => {
  it("間隔を保存した後も表示は保存値のまま、次の保存も保存値を送る", async () => {
    mockedUpdate.mockResolvedValue({ success: true })
    const initial = { name: "あかり", birthDate: "2026-05-01", feedingIntervalMin: 180 }
    const { rerender } = render(<BabyProfileCard initialProfile={initial} />)

    fireEvent.change(intervalSelect(), { target: { value: "150" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(mockedToast.success).toHaveBeenCalledTimes(1))
    expect(submitted(0).get("feeding_interval_min")).toBe("150")

    // router.refresh() の後、サーバの値（150）で描き直される
    rerender(
      <BabyProfileCard initialProfile={{ ...initial, feedingIntervalMin: 150 }} />,
    )
    expect(intervalSelect().value).toBe("150")

    // 続けて名前だけを直して保存しても、間隔は巻き戻らぬ
    fireEvent.change(nameInput(), { target: { value: "あかりちゃん" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2))
    expect(submitted(1).get("feeding_interval_min")).toBe("150")
    expect(submitted(1).get("baby_name")).toBe("あかりちゃん")
  })

  it("保存に失敗しても入力は残る（打ち直しを強いぬ）", async () => {
    mockedUpdate.mockResolvedValue({ error: "赤ちゃん情報の更新に失敗しました" })
    render(
      <BabyProfileCard
        initialProfile={{ name: "あかり", birthDate: null, feedingIntervalMin: 180 }}
      />,
    )

    fireEvent.change(nameInput(), { target: { value: "ひかり" } })
    fireEvent.change(intervalSelect(), { target: { value: "120" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith("赤ちゃん情報の更新に失敗しました"),
    )
    expect(nameInput().value).toBe("ひかり")
    expect(intervalSelect().value).toBe("120")
  })
})

describe("BabyProfileCard — hydration 前の送信（P2-30 の直し方の制約）", () => {
  it("SSR の form は action を javascript: の番兵にする（onSubmit 化で素の GET にせぬ）", () => {
    // onSubmit + preventDefault に替えると action 属性が消え、hydration 前の保存タップが
    // `/settings?baby_name=…&baby_birth_date=…` の GET になって入力が URL・履歴に載る
    const html = renderToString(
      <BabyProfileCard
        initialProfile={{ name: "あかり", birthDate: "2026-05-01", feedingIntervalMin: 180 }}
      />,
    )
    expect(html).toMatch(/<form[^>]*action="javascript:/)
  })
})

describe("BabyProfileCard — 読めなかった時（P2-31）", () => {
  it("initialProfile が null なら編集フォームも保存ボタンも出さず、失敗を示す", () => {
    render(<BabyProfileCard initialProfile={null} />)

    expect(screen.queryByRole("button", { name: "保存" })).toBeNull()
    expect(screen.queryByLabelText("名前")).toBeNull()
    expect(screen.queryByLabelText("授乳間隔")).toBeNull()
    expect(screen.getByRole("alert")).toHaveTextContent("取得できませんでした")
  })

  it("読めた時はフォームを出す（対照）", () => {
    render(
      <BabyProfileCard
        initialProfile={{ name: null, birthDate: null, feedingIntervalMin: 180 }}
      />,
    )
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
