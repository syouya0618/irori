/**
 * BabyTemperatureCard（訴え③「体温を記載できる場所」）のコンポーネントテスト。
 *
 * 固定する契約:
 * - `＋ 記録` ボタンは **isToday のときだけ**出す（過去日は「記録なし」に留める）。
 *   過去日で出すと `baby-log-form-sheet.tsx:222` が新規を**今日固定**で作るため
 *   (a) 今日の行が保存され (b) 過去日の timeline へ混入する（F-03 の境界）
 * - 発熱域は**色だけに依存させぬ** — アイコン + テキストで示す
 * - aria-label は「体温」単独にせぬ（quick-actions の既存「体温」ボタンと割れる）
 * - タッチ領域 44px（min-h-11）
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { BabyTemperatureCard } from "../baby-temperature-card"
import type { BabyLogData } from "@/lib/types/baby"

const YMD = "2026-04-16"

const baseLog = {
  logged_by: "user-1",
  feeding_type: null,
  amount_ml: null,
  breast_left_count: null,
  breast_right_count: null,
  breast_left_sec: null,
  breast_right_sec: null,
  diaper_type: null,
  temperature: null,
  weight_g: null,
  height_cm: null,
  duration_min: null,
  duration_sec: null,
  memo: null,
  created_at: "2026-04-16T00:00:00+09:00",
} satisfies Omit<BabyLogData, "id" | "log_type" | "logged_at">

function temp(id: string, jstTime: string, temperature: number): BabyLogData {
  return {
    ...baseLog,
    id,
    log_type: "temperature",
    logged_at: `${YMD}T${jstTime}+09:00`,
    temperature,
  }
}

function renderCard(
  overrides: Partial<Parameters<typeof BabyTemperatureCard>[0]> = {},
) {
  const onEdit = vi.fn()
  const onCreate = vi.fn()
  const props = {
    logs: [] as BabyLogData[],
    date: YMD,
    isToday: true,
    onEdit,
    onCreate,
    ...overrides,
  }
  render(<BabyTemperatureCard {...props} />)
  return { onEdit, onCreate }
}

beforeEach(() => {
  cleanup()
})

describe("BabyTemperatureCard / 空状態", () => {
  it("今日で両枠が空なら朝・夜とも「記録」ボタンを出す", () => {
    renderCard()

    expect(
      screen.getByRole("button", { name: "今日の朝の体温を記録" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "今日の夜の体温を記録" }),
    ).toBeInTheDocument()
    expect(screen.getAllByText("未測定")).toHaveLength(2)
  })

  it("記録ボタンのタップで onCreate が呼ばれる（新規フォームシートを開く導線）", () => {
    const { onCreate } = renderCard()

    fireEvent.click(
      screen.getByRole("button", { name: "今日の朝の体温を記録" }),
    )

    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it("記録ボタンは 44px 以上のタッチ領域を持つ（min-h-11）", () => {
    renderCard()
    const button = screen.getByRole("button", { name: "今日の朝の体温を記録" })
    expect(button.className).toContain("min-h-11")
  })
})

describe("BabyTemperatureCard / 記録ボタンは今日のみ（対で固定する）", () => {
  it("今日は朝・夜の「記録」ボタンが 2 つ出る", () => {
    renderCard({ isToday: true })
    expect(
      screen.getAllByRole("button", { name: /体温を記録/ }),
    ).toHaveLength(2)
  })

  it("過去日は「記録」ボタンを 1 つも出さず「記録なし」に留める", () => {
    // 過去日で記録させると今日の行が保存され、過去日の timeline へ混入する
    // （baby-log-form-sheet は新規を今日固定で作る）。ゆえに出さぬのが契約。
    renderCard({ isToday: false })

    expect(
      screen.queryAllByRole("button", { name: /体温を記録/ }),
    ).toHaveLength(0)
    expect(screen.getAllByText("記録なし")).toHaveLength(2)
  })

  it("過去日でも記録済みのスロットは閲覧・編集できる", () => {
    const log = temp("t-am", "07:12:00", 36.7)
    const { onEdit } = renderCard({ isToday: false, logs: [log] })

    // 「今日の」接頭辞は付かない
    const button = screen.getByRole("button", {
      name: "朝の体温 36.7度 07:12 を編集",
    })
    fireEvent.click(button)

    expect(onEdit).toHaveBeenCalledWith(log)
    // 夜は空きだが過去日ゆえ記録ボタンではなく「記録なし」
    expect(screen.getByText("記録なし")).toBeInTheDocument()
  })
})

describe("BabyTemperatureCard / 埋まっているスロット", () => {
  it("体温と時刻を表示し、タップで onEdit に元のログを渡す", () => {
    const morning = temp("t-am", "07:12:00", 36.7)
    const night = temp("t-pm", "19:30:00", 36.9)
    const { onEdit } = renderCard({ logs: [morning, night] })

    expect(screen.getByText("36.7℃")).toBeInTheDocument()
    expect(screen.getByText("07:12")).toBeInTheDocument()
    expect(screen.getByText("36.9℃")).toBeInTheDocument()
    expect(screen.getByText("19:30")).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("button", { name: "今日の朝の体温 36.7度 07:12 を編集" }),
    )
    expect(onEdit).toHaveBeenCalledWith(morning)

    fireEvent.click(
      screen.getByRole("button", { name: "今日の夜の体温 36.9度 19:30 を編集" }),
    )
    expect(onEdit).toHaveBeenCalledWith(night)
  })

  it("体温は小数第 1 位で表示する（37.0 が 37 に潰れぬ）", () => {
    renderCard({ logs: [temp("t-am", "07:00:00", 37)] })
    expect(screen.getByText("37.0℃")).toBeInTheDocument()
  })

  it("同枠に複数あれば主表示は最新・+N バッジを出す", () => {
    renderCard({
      logs: [
        temp("t-am-1", "06:00:00", 36.5),
        temp("t-am-2", "08:00:00", 36.8),
        temp("t-am-3", "10:00:00", 36.9), // 最新
      ],
    })

    expect(screen.getByText("36.9℃")).toBeInTheDocument()
    expect(screen.queryByText("36.5℃")).not.toBeInTheDocument()
    expect(screen.getByText("+2")).toBeInTheDocument()
    // 追加件数は aria-label にも読める形で載せる
    expect(
      screen.getByRole("button", {
        name: "今日の朝の体温 36.9度 10:00 他2件 を編集",
      }),
    ).toBeInTheDocument()
  })

  it("同枠が 1 件だけなら +N バッジを出さない", () => {
    renderCard({ logs: [temp("t-am", "07:00:00", 36.6)] })
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
  })
})

describe("BabyTemperatureCard / 発熱域は色だけに依存させぬ（境界を対で固定する）", () => {
  it("37.5℃ は「発熱」テキストとアイコンを出す", () => {
    renderCard({ logs: [temp("t-am", "07:00:00", 37.5)] })

    const feverLabel = screen.getByText("発熱")
    expect(feverLabel).toBeInTheDocument()
    // 色以外の手がかり（アイコン）が「発熱」表記と**同じ入れ物**に併記されること。
    // lucide の内部クラス名（.lucide-triangle-alert）で照合すると、アイコン
    // ライブラリの bump だけで無関係に赤くなるため svg の実在で見る。
    expect(feverLabel.querySelector("svg")).not.toBeNull()
    expect(
      screen.getByRole("button", {
        name: "今日の朝の体温 37.5度 07:00 発熱 を編集",
      }),
    ).toBeInTheDocument()
  })

  it("37.4℃ は発熱として扱わない（>= と > の取り違えを検出する対）", () => {
    renderCard({ logs: [temp("t-am", "07:00:00", 37.4)] })
    expect(screen.queryByText("発熱")).not.toBeInTheDocument()
  })
})

describe("BabyTemperatureCard / 無視すべき行", () => {
  it("体温以外のログ・temperature が null の行では空状態のままになる", () => {
    renderCard({
      logs: [
        {
          ...baseLog,
          id: "feeding",
          log_type: "feeding",
          logged_at: `${YMD}T07:00:00+09:00`,
          feeding_type: "bottle",
        },
        {
          ...baseLog,
          id: "t-null",
          log_type: "temperature",
          logged_at: `${YMD}T08:00:00+09:00`,
          temperature: null,
        },
      ],
    })

    expect(screen.getAllByText("未測定")).toHaveLength(2)
    expect(
      screen.getByRole("button", { name: "今日の朝の体温を記録" }),
    ).toBeInTheDocument()
  })

  it("選択日と違う日のログは表示しない", () => {
    renderCard({ logs: [temp("t-am", "07:00:00", 36.6)], date: "2026-04-15" })
    expect(screen.queryByText("36.6℃")).not.toBeInTheDocument()
    expect(screen.getAllByText("未測定")).toHaveLength(2)
  })
})

describe("BabyTemperatureCard / デザイン規約", () => {
  it("glass カードの規約クラスを持ち、transition-all を使わない", () => {
    const { container } = render(
      <BabyTemperatureCard
        logs={[temp("t-am", "07:00:00", 36.6)]}
        date={YMD}
        isToday
        onEdit={vi.fn()}
        onCreate={vi.fn()}
      />,
    )

    const card = container.querySelector(".glass")
    expect(card).not.toBeNull()
    expect(card!.className).toContain("rounded-2xl")
    expect(card!.className).toContain("shadow-lg")
    expect(card!.className).toContain("shadow-black/[0.04]")

    // transition-all 禁止（transition-colors のみ）
    expect(container.innerHTML).not.toContain("transition-all")
    expect(container.innerHTML).toContain("transition-colors")
  })
})
