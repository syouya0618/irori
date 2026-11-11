/**
 * ごみの分類のフォームと、予定のシートに置く欄の契約（A-03 / A-04 / A-07）。
 *
 * - タイトルから用途を決めぬ（押して選ぶまで名称は未選択）
 * - 繰り返しの回では範囲を明示して選ばせる（既定を置かぬ）
 * - 今回の保存での通知の扱いを画面に出す。新しくごみにする時の初期選択は前日 20:00、
 *   既に分類済み・個別に止めた回では「変えない」
 * - 分類を読めておらぬ予定は、読めぬまま書き換えさせぬ
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GarbageRequest, ResolvedEventPurpose } from "@/lib/domain/garbage"
import type { UseChoreSaveResult } from "@/components/chores/shared/use-chore-save"
import { GarbagePurposeField } from "../garbage-purpose-field"
import { GarbagePurposeForm, type GarbageFormTarget } from "../garbage-purpose-form"

const EVENT = "c5000000-0000-4000-8000-000000000001"
// 開始日は十分に先（前日 20:00 を過ぎておらぬ）。過ぎた回の表示は下の専用の describe で確かめる
const single: GarbageFormTarget = {
  id: EVENT,
  title: "燃えるごみ",
  whenLabel: "11月12日（木）・終日",
  isSeries: false,
  startDate: "2099-11-12",
}
const series: GarbageFormTarget = { ...single, title: "収集", isSeries: true }

type Known = Exclude<ResolvedEventPurpose, { kind: "unknown" }>
/** 見ておった版（行なし） */
const NOTHING_SEEN = { series: null, event: null }
/** シリーズ既定の行を見ておった版（マイクロ秒つきの表記のまま） */
const SERIES_SEEN = { series: "2026-11-10T00:00:00.123456+00:00", event: null }

const NORMAL: Known = { kind: "normal", exception: false, seriesLabel: null, seriesRemindDefault: null, seen: NOTHING_SEEN }
const SERIES_GARBAGE: Extract<Known, { kind: "garbage" }> = {
  kind: "garbage",
  label: "プラスチック",
  scope: "series",
  purposeId: "d5000000-0000-4000-8000-000000000001",
  seriesLabel: "プラスチック",
  seriesRemindDefault: "prev_day_20",
  reminderOptOut: false,
  seen: SERIES_SEEN,
}

afterEach(() => cleanup())

const pressed = (name: string | RegExp) => screen.getByRole("button", { name, pressed: true })
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }))
const effect = () => screen.getByTestId("garbage-reminder-effect")

describe("GarbagePurposeForm: 新しく分類する", () => {
  it("題が「燃えるごみ」でも名称を自動で選ばぬ。選ばずに保存すると止める", () => {
    const onSubmit = vi.fn()
    render(<GarbagePurposeForm target={single} current={NORMAL} onSubmit={onSubmit} />)
    const kinds = screen.getByRole("group", { name: "ごみの名称" })
    expect(within(kinds).queryByRole("button", { pressed: true })).toBeNull()
    press("分類を保存")
    expect(screen.getByRole("alert")).toHaveTextContent("ごみの名称を選んでください")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("通知の初期選択は前日 20:00 で、何が起きるかを保存の前に文で言う", () => {
    render(<GarbagePurposeForm target={single} current={NORMAL} onSubmit={vi.fn()} />)
    expect(pressed("前日 20:00 に通知する")).toBeInTheDocument()
    expect(effect()).toHaveTextContent("すでに通知を設定している場合は、その時刻のまま変えません")
    // 3 つの扱いが全て画面に在る
    expect(screen.getByRole("button", { name: "通知を止める" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "通知設定は変えない" })).toBeInTheDocument()
  })

  it("単発の予定: 名称を選んで保存すると、この予定だけ・前日 20:00 の要求になる", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    render(<GarbagePurposeForm target={single} current={NORMAL} onSubmit={onSubmit} />)
    // 単発では範囲を選ばせぬ
    expect(screen.queryByRole("group", { name: "変更する範囲" })).toBeNull()
    press("古紙")
    press("分類を保存")
    expect(onSubmit).toHaveBeenCalledWith(
      { op: "save", eventId: EVENT, scope: "event", action: "garbage", garbageKind: "古紙", reminder: "prev_day_20", seen: NOTHING_SEEN },
      "「燃えるごみ」をごみの日（古紙）にする",
    )
  })

  it("通知の扱いを変えると、その選択で送る", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    render(<GarbagePurposeForm target={single} current={NORMAL} onSubmit={onSubmit} />)
    press("資源")
    press("通知設定は変えない")
    expect(effect()).toHaveTextContent("通知の設定は今のまま変えません")
    press("分類を保存")
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ garbageKind: "資源", reminder: "keep" })
  })

  it("自由入力: 前後の空白を除いて送る。21 文字は止める", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    render(<GarbagePurposeForm target={single} current={NORMAL} onSubmit={onSubmit} />)
    press("その他（入力する）")
    const input = screen.getByRole("textbox", { name: /ごみの名称/ })
    fireEvent.change(input, { target: { value: "あ".repeat(21) } })
    press("分類を保存")
    expect(screen.getByRole("alert")).toHaveTextContent("1〜20 文字")
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: "  乾電池 " } })
    press("分類を保存")
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ garbageKind: "乾電池" })
  })

  it("保存を受けられぬ間（送信中・確認待ち）は保存ボタンを止める", () => {
    render(<GarbagePurposeForm target={single} current={NORMAL} disabled onSubmit={vi.fn()} />)
    expect(screen.getByRole("button", { name: "分類を保存" })).toBeDisabled()
  })
})

describe("GarbagePurposeForm: 繰り返しの回（範囲の明示）", () => {
  it("未分類の回では範囲に既定を置かず、選ぶまで保存できぬ", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    render(<GarbagePurposeForm target={series} current={NORMAL} onSubmit={onSubmit} />)
    const scope = screen.getByRole("group", { name: "変更する範囲" })
    expect(within(scope).queryByRole("button", { pressed: true })).toBeNull()
    press("プラスチック")
    press("分類を保存")
    expect(screen.getByRole("alert")).toHaveTextContent("変更する範囲")
    expect(onSubmit).not.toHaveBeenCalled()

    press("シリーズ全体")
    expect(effect()).toHaveTextContent("今日以降のすべての回")
    press("分類を保存")
    expect(onSubmit).toHaveBeenCalledWith(
      { op: "save", eventId: EVENT, scope: "series", action: "garbage", garbageKind: "プラスチック", reminder: "prev_day_20", seen: NOTHING_SEEN },
      "「収集」をごみの日（プラスチック）にする（シリーズ全体）",
    )
  })

  it("「この回だけ」を選べば event の要求になる（対照）", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    render(<GarbagePurposeForm target={series} current={NORMAL} onSubmit={onSubmit} />)
    press("この回だけ")
    press("古紙")
    press("分類を保存")
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ scope: "event", garbageKind: "古紙" })
  })

  it("シリーズ既定が在る回: この回だけ通常の予定へ戻せる（通知は止めるが初期選択）", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    render(<GarbagePurposeForm target={series} current={SERIES_GARBAGE} onSubmit={onSubmit} />)
    // 今効いておる範囲（シリーズ全体）から始まる。その範囲には「通常へ戻す」は無い
    expect(pressed("シリーズ全体")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "この回だけ通常の予定に戻す" })).toBeNull()
    press("この回だけ")
    press("この回だけ通常の予定に戻す")
    // 通常へ戻す時に「前日 20:00 に通知する」は出さぬ
    expect(screen.queryByRole("button", { name: "前日 20:00 に通知する" })).toBeNull()
    expect(pressed("通知を止める")).toBeInTheDocument()
    press("通常の予定に戻す")
    expect(onSubmit).toHaveBeenCalledWith(
      { op: "save", eventId: EVENT, scope: "event", action: "normal", garbageKind: null, reminder: "off", seen: SERIES_SEEN },
      "「収集」をこの回だけ通常の予定に戻す",
    )
  })

  it("シリーズ既定が在る回: この回だけ別の名称にできる", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    render(<GarbagePurposeForm target={series} current={SERIES_GARBAGE} onSubmit={onSubmit} />)
    press("この回だけ")
    press("粗大ごみ")
    press("分類を保存")
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ scope: "event", action: "garbage", garbageKind: "粗大ごみ" })
  })

  it("分類済みのシリーズを直す時は、通知は「変えない」から始める（止めた通知・変えた時刻を書き換えぬ）", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    render(<GarbagePurposeForm target={series} current={SERIES_GARBAGE} onSubmit={onSubmit} />)
    expect(pressed("プラスチック")).toBeInTheDocument()
    expect(pressed("通知設定は変えない")).toBeInTheDocument()
    press("資源")
    press("分類を保存")
    expect(onSubmit.mock.calls[0][0]).toEqual({
      op: "save",
      eventId: EVENT,
      scope: "series",
      action: "garbage",
      garbageKind: "資源",
      reminder: "keep",
      seen: SERIES_SEEN,
    })
  })

  it("個別に通知を止めた回へ例外を足す時も、通知は「変えない」から始める", () => {
    render(
      <GarbagePurposeForm
        target={series}
        current={{ ...SERIES_GARBAGE, reminderOptOut: true }}
        onSubmit={vi.fn()}
      />,
    )
    press("この回だけ")
    expect(pressed("通知設定は変えない")).toBeInTheDocument()
    // 対照: 止めておらぬ回では前日 20:00 から始まる
    cleanup()
    render(<GarbagePurposeForm target={series} current={SERIES_GARBAGE} onSubmit={vi.fn()} />)
    press("この回だけ")
    expect(pressed("前日 20:00 に通知する")).toBeInTheDocument()
  })

  it("解除: 範囲を明示し、通知は「変えない」が初期選択。前日 20:00 は選べぬ", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    render(
      <GarbagePurposeForm
        target={series}
        current={SERIES_GARBAGE}
        lockedScope="series"
        initialMode="clear"
        onSubmit={onSubmit}
      />,
    )
    // 範囲は固定（選ばせぬ）が、文で言う
    expect(screen.queryByRole("group", { name: "変更する範囲" })).toBeNull()
    expect(screen.getByText(/シリーズ全体。/)).toBeInTheDocument()
    expect(pressed("分類を解除する")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "前日 20:00 に通知する" })).toBeNull()
    expect(screen.queryByRole("group", { name: "ごみの名称" })).toBeNull()
    press("通知を止める")
    expect(effect()).toHaveTextContent("個別に設定した通知も消えます")
    press("解除する")
    expect(onSubmit).toHaveBeenCalledWith(
      { op: "save", eventId: EVENT, scope: "series", action: "clear", garbageKind: null, reminder: "off", seen: SERIES_SEEN },
      "「収集」のごみの分類を解除（シリーズ全体）",
    )
  })

  it("分類の無い予定に「解除」「通常へ戻す」は出さぬ（操作は 1 つだけ）", () => {
    render(<GarbagePurposeForm target={single} current={NORMAL} onSubmit={vi.fn()} />)
    expect(screen.queryByRole("group", { name: "操作" })).toBeNull()
  })
})

describe("GarbagePurposeForm: 止めてある通知を、分類の変更のついでに付け直さぬ（R10）", () => {
  const SERIES_MUTED: typeof SERIES_GARBAGE = { ...SERIES_GARBAGE, seriesRemindDefault: "none" }

  it("シリーズ全体の通知を止めてあるシリーズの回へ「この回だけ」の分類を足す時、通知は「変えない」から始まる", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    render(<GarbagePurposeForm target={series} current={SERIES_MUTED} onSubmit={onSubmit} />)
    press("この回だけ")
    expect(pressed("通知設定は変えない")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "前日 20:00 に通知する" })).toHaveAttribute("aria-pressed", "false")
    press("粗大ごみ")
    press("分類を保存")
    // 名称だけを変える要求になる（通知を付けぬ）
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ scope: "event", garbageKind: "粗大ごみ", reminder: "keep" })
  })

  it("対照: 前日通知が既定のシリーズの回では、前日 20:00 から始まる", () => {
    render(<GarbagePurposeForm target={series} current={SERIES_GARBAGE} onSubmit={vi.fn()} />)
    press("この回だけ")
    expect(pressed("前日 20:00 に通知する")).toBeInTheDocument()
  })

  it("シリーズの通知の既定を読めぬ（知らぬ値）時も「変えない」から始まる", () => {
    render(
      <GarbagePurposeForm target={series} current={{ ...SERIES_GARBAGE, seriesRemindDefault: null }} onSubmit={vi.fn()} />,
    )
    press("この回だけ")
    expect(pressed("通知設定は変えない")).toBeInTheDocument()
  })

  it("この回だけ通常へ戻した回を、ごみの日へ戻す時も「変えない」から始まる（戻した時に止めた通知を付け直さぬ）", () => {
    render(
      <GarbagePurposeForm
        target={series}
        current={{
          kind: "normal",
          exception: true,
          seriesLabel: "プラスチック",
          seriesRemindDefault: "prev_day_20",
          seen: { ...SERIES_SEEN, event: "2026-11-11T00:00:00.000001+00:00" },
        }}
        onSubmit={vi.fn()}
      />,
    )
    // 例外の在る回は「この回だけ」から始まる
    expect(pressed("この回だけ")).toBeInTheDocument()
    expect(pressed("通知設定は変えない")).toBeInTheDocument()
  })
})

describe("GarbagePurposeForm: この回の通知だけ止める（R12）", () => {
  it("シリーズ既定の回では、分類を作らずに通知だけを止められる", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    render(<GarbagePurposeForm target={series} current={SERIES_GARBAGE} onSubmit={onSubmit} />)
    // シリーズ全体の範囲には出さぬ
    expect(screen.queryByRole("button", { name: "この回の通知だけ止める" })).toBeNull()
    press("この回だけ")
    press("この回の通知だけ止める")
    // 名称も通知の選択も出さぬ（止めるだけ）。何が起きるかは文で言う
    expect(screen.queryByRole("group", { name: "ごみの名称" })).toBeNull()
    expect(screen.queryByRole("button", { name: "前日 20:00 に通知する" })).toBeNull()
    expect(screen.queryByRole("button", { name: "通知設定は変えない" })).toBeNull()
    expect(effect()).toHaveTextContent("この回の通知だけを止めます。ごみの日の分類は変えません")
    press("通知だけ止める")
    // 用途を書かぬ要求（この回だけ・解除・止める）= RPC は明示 OFF だけの行を残す。
    // 「ごみの日にする + 通知を止める」（この回だけの分類の行ができる）ではない
    expect(onSubmit).toHaveBeenCalledWith(
      { op: "save", eventId: EVENT, scope: "event", action: "clear", garbageKind: null, reminder: "off", seen: SERIES_SEEN },
      "「収集」のこの回の通知を止める",
    )
  })

  it("出さぬ場面: 既に止めてある回・この回だけの分類を持つ回・単発の予定・未分類の回", () => {
    const absent = () => expect(screen.queryByRole("button", { name: "この回の通知だけ止める" })).toBeNull()
    render(<GarbagePurposeForm target={series} current={{ ...SERIES_GARBAGE, reminderOptOut: true }} onSubmit={vi.fn()} />)
    press("この回だけ")
    absent()
    cleanup()
    // この回だけの分類を持つ回は「名称・通知を変える」で通知を止められる（分岐は既に在る）
    render(
      <GarbagePurposeForm
        target={series}
        current={{ ...SERIES_GARBAGE, scope: "event", label: "粗大ごみ", seen: { ...SERIES_SEEN, event: "2026-11-11T00:00:00.000001+00:00" } }}
        onSubmit={vi.fn()}
      />,
    )
    absent()
    cleanup()
    render(
      <GarbagePurposeForm
        target={single}
        current={{ ...SERIES_GARBAGE, scope: "event", seriesLabel: null, seriesRemindDefault: null, seen: { series: null, event: "2026-11-11T00:00:00.000001+00:00" } }}
        onSubmit={vi.fn()}
      />,
    )
    absent()
    cleanup()
    render(<GarbagePurposeForm target={series} current={NORMAL} onSubmit={vi.fn()} />)
    press("この回だけ")
    absent()
  })
})

describe("GarbagePurposeForm: 前日 20:00 を過ぎた回（R09）", () => {
  // 開始日が過去 = 前日 20:00 は必ず過ぎておる（当日の予定・前日 20:00 より後に分類する予定と同じ扱い）
  const lateSingle: GarbageFormTarget = { ...single, startDate: "2020-01-02" }
  const lateSeries: GarbageFormTarget = { ...series, startDate: "2020-01-02" }

  it("単発: 「通知します」と言わず、届かぬことを言う", () => {
    render(<GarbagePurposeForm target={lateSingle} current={NORMAL} onSubmit={vi.fn()} />)
    expect(pressed("前日 20:00 に通知する")).toBeInTheDocument()
    expect(effect()).toHaveTextContent("この予定の前日 20:00 はすでに過ぎているため、これから通知は届きません")
    expect(effect()).not.toHaveTextContent("に通知します")
  })

  it("対照: 過ぎておらぬ回では「通知します」と言う", () => {
    render(<GarbagePurposeForm target={single} current={NORMAL} onSubmit={vi.fn()} />)
    expect(effect()).toHaveTextContent("この予定の前日 20:00 に通知します")
    expect(effect()).not.toHaveTextContent("届きません")
  })

  it("境目: 前日 20:00 ちょうどから「届かぬ」と言う（予定のシートの通知の欄と同じ基準）", () => {
    // 11/12 の予定 → 境は 11/11 20:00 JST = 11:00 UTC
    const target: GarbageFormTarget = { ...single, startDate: "2026-11-12" }
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-11-11T10:59:00.000Z"))
      render(<GarbagePurposeForm target={target} current={NORMAL} onSubmit={vi.fn()} />)
      expect(effect()).toHaveTextContent("この予定の前日 20:00 に通知します")
      cleanup()
      vi.setSystemTime(new Date("2026-11-11T11:00:00.000Z"))
      render(<GarbagePurposeForm target={target} current={NORMAL} onSubmit={vi.fn()} />)
      expect(effect()).toHaveTextContent("これから通知は届きません")
    } finally {
      vi.useRealTimers()
    }
  })

  it("シリーズ全体: この回は届かず、次の回から届くと言う", () => {
    render(<GarbagePurposeForm target={lateSeries} current={NORMAL} onSubmit={vi.fn()} />)
    press("シリーズ全体")
    expect(effect()).toHaveTextContent("この回は前日 20:00 をすでに過ぎているため、この回の通知は届きません（次の回から届きます）")
  })

  it("通知を止める・変えないを選んだ時は、過ぎておることを言わぬ（関係が無い）", () => {
    render(<GarbagePurposeForm target={lateSingle} current={NORMAL} onSubmit={vi.fn()} />)
    press("通知設定は変えない")
    expect(effect()).toHaveTextContent("通知の設定は今のまま変えません")
    expect(effect()).not.toHaveTextContent("届きません")
  })
})

describe("GarbagePurposeForm: 見ておった版を開いた時点で固定して送る（R38）", () => {
  it("開いたままの間に分類が新しい版へ差し替わっても、送るのは開いた時点の版", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    const { rerender } = render(<GarbagePurposeForm target={series} current={SERIES_GARBAGE} onSubmit={onSubmit} />)
    press("資源")
    // 家族が名称を変え、背景の取り直しで props が新しい版になった
    rerender(
      <GarbagePurposeForm
        target={series}
        current={{ ...SERIES_GARBAGE, label: "古紙", seriesLabel: "古紙", seen: { series: "2026-11-11T09:00:00.999999+00:00", event: null } }}
        onSubmit={onSubmit}
      />,
    )
    press("分類を保存")
    // 「開いた時点の入力 + 最新の版」を送らぬ（送れば RPC の照合を素通りして家族の変更を巻き戻す）
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ garbageKind: "資源", seen: SERIES_SEEN })
  })

  it("この回だけの分類・明示 OFF の行を見ておった時は、その版も送る", () => {
    const onSubmit = vi.fn<(request: GarbageRequest, label: string) => void>()
    const seen = { series: SERIES_SEEN.series, event: "2026-11-11T00:00:00.000001+00:00" }
    render(
      <GarbagePurposeForm
        target={series}
        current={{ ...SERIES_GARBAGE, scope: "event", label: "粗大ごみ", seen }}
        onSubmit={onSubmit}
      />,
    )
    press("古紙")
    press("分類を保存")
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ scope: "event", garbageKind: "古紙", seen })
  })
})

function fakeSave(overrides: Partial<UseChoreSaveResult<GarbageRequest>> = {}): UseChoreSaveResult<GarbageRequest> {
  return {
    send: vi.fn(() => "op"),
    retry: vi.fn(),
    discard: vi.fn(),
    discardUnreadable: vi.fn(),
    pending: [],
    unreadable: 0,
    storageOk: true,
    ready: true,
    saving: false,
    blocked: false,
    message: "",
    messageTone: "status",
    messageSession: null,
    ...overrides,
  }
}

describe("GarbagePurposeField（予定のシートの欄）", () => {
  it("未分類: 文で言い、押すまでフォームを出さぬ（何も保存せぬ）", () => {
    const save = fakeSave()
    render(<GarbagePurposeField target={single} purpose={undefined} save={save} settledCount={0} />)
    expect(screen.getByText("ごみの日ではありません。")).toBeInTheDocument()
    expect(screen.queryByTestId("garbage-purpose-form")).toBeNull()
    press("ごみの日にする")
    expect(screen.getByTestId("garbage-purpose-form")).toBeInTheDocument()
    expect(save.send).not.toHaveBeenCalled()
  })

  it("保存を押すと、共通の保存手順へ要求と説明を渡す", () => {
    const save = fakeSave()
    render(<GarbagePurposeField target={single} purpose={undefined} save={save} settledCount={0} />)
    press("ごみの日にする")
    press("びん・缶")
    press("分類を保存")
    expect(save.send).toHaveBeenCalledWith(
      { op: "save", eventId: EVENT, scope: "event", action: "garbage", garbageKind: "びん・缶", reminder: "prev_day_20", seen: NOTHING_SEEN },
      "「燃えるごみ」をごみの日（びん・缶）にする",
    )
  })

  it("保存が確定したら（settledCount が増えたら）フォームを畳む", () => {
    const save = fakeSave()
    const { rerender } = render(
      <GarbagePurposeField target={single} purpose={undefined} save={save} settledCount={0} />,
    )
    press("ごみの日にする")
    expect(screen.getByTestId("garbage-purpose-form")).toBeInTheDocument()
    rerender(
      <GarbagePurposeField
        target={single}
        purpose={{
          kind: "garbage",
          label: "びん・缶",
          scope: "event",
          purposeId: "p",
          seriesLabel: null,
          seriesRemindDefault: null,
          reminderOptOut: false,
          seen: { series: null, event: "2026-11-11T00:00:00.000001+00:00" },
        }}
        save={save}
        settledCount={1}
      />,
    )
    expect(screen.queryByTestId("garbage-purpose-form")).toBeNull()
    // 分類は文字で言う（アイコン・色だけにせぬ）
    expect(screen.getByText("ごみ・びん・缶")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "分類を変更・解除" })).toBeInTheDocument()
  })

  it("分類を読めておらぬ時は「ごみの日ではない」と言わず、変更もさせぬ", () => {
    const onReload = vi.fn()
    render(
      <GarbagePurposeField
        target={single}
        purpose={{ kind: "unknown" }}
        save={fakeSave()}
        settledCount={0}
        onReload={onReload}
      />,
    )
    expect(screen.getByText(/分類を読み込めていません/)).toBeInTheDocument()
    expect(screen.queryByText("ごみの日ではありません。")).toBeNull()
    expect(screen.queryByRole("button", { name: "ごみの日にする" })).toBeNull()
    press("分類を読み直す")
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it("この回だけ通常へ戻した例外と、止めた通知を文で言う", () => {
    const { rerender } = render(
      <GarbagePurposeField
        target={series}
        purpose={{
          kind: "normal",
          exception: true,
          seriesLabel: "プラスチック",
          seriesRemindDefault: "prev_day_20",
          seen: { ...SERIES_SEEN, event: "2026-11-11T00:00:00.000001+00:00" },
        }}
        save={fakeSave()}
        settledCount={0}
      />,
    )
    expect(screen.getByText(/この回だけ通常の予定に戻しています（ほかの回は「プラスチック」）/)).toBeInTheDocument()
    rerender(
      <GarbagePurposeField
        target={series}
        purpose={{ ...SERIES_GARBAGE, reminderOptOut: true }}
        save={fakeSave()}
        settledCount={0}
      />,
    )
    expect(screen.getByText(/この回の通知は止めています/)).toBeInTheDocument()
  })

  it("結果不明の控えが在る間は、欄の中で確かめ直せる（保存ボタンは止まる）", () => {
    const save = fakeSave({
      blocked: true,
      message: "保存結果を確認できません。同じ操作で確認し直してください。",
      messageTone: "alert",
      pending: [
        {
          schema: 1,
          id: "e5000000-0000-4000-8000-000000000001",
          owner: { userId: "u", householdId: "h" },
          kind: "garbage",
          label: "「燃えるごみ」をごみの日（古紙）にする",
          payload: { op: "save", eventId: EVENT, scope: "event", action: "garbage", garbageKind: "古紙", reminder: "keep", seen: NOTHING_SEEN },
          phase: "unknown",
          firstAttemptAt: "2026-11-11T00:00:00.000Z",
        },
      ],
    })
    render(<GarbagePurposeField target={single} purpose={undefined} save={save} settledCount={0} />)
    expect(screen.getByRole("alert")).toHaveTextContent("保存結果を確認できません")
    press("同じ操作で確認")
    expect(save.retry).toHaveBeenCalledTimes(1)
    press("ごみの日にする")
    expect(screen.getByRole("button", { name: "分類を保存" })).toBeDisabled()
  })
})
