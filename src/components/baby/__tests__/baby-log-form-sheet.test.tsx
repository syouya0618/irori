import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"

import { BabyLogFormSheet } from "../baby-log-form-sheet"
import {
  updateLog,
  deleteLog,
  recordFeeding,
  recordMemo,
} from "@/app/(main)/baby/actions"
import { toast } from "sonner"
import { FUTURE_LOG_TIME_ERROR } from "@/lib/domain/baby-log-time"
import type { BabyLogData } from "@/lib/types/baby"

vi.mock("@/app/(main)/baby/actions", () => ({
  updateLog: vi.fn(),
  deleteLog: vi.fn(),
  recordFeeding: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const mockedUpdateLog = vi.mocked(updateLog)
const mockedDeleteLog = vi.mocked(deleteLog)
const mockedRecordFeeding = vi.mocked(recordFeeding)
const mockedRecordMemo = vi.mocked(recordMemo)
const mockedToast = vi.mocked(toast)

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

function bottleFeedingLog(overrides: Partial<BabyLogData> = {}): BabyLogData {
  return {
    id: "log-1",
    log_type: "feeding",
    logged_at: "2026-07-18T12:00:00+09:00",
    logged_by: "user-1",
    feeding_type: "bottle",
    amount_ml: 80,
    diaper_type: null,
    ended_at: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: null,
    created_at: "2026-07-18T12:00:00+09:00",
    ...overrides,
  }
}

describe("BabyLogFormSheet の amountMl 0ml falsy 衝突", () => {
  it("量に「0」を入力して更新すると amountMl: 0 が updateLog に渡る", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet userId="u1" open={true} onOpenChange={() => {}} log={bottleFeedingLog()} />,
    )

    const input = screen.getByLabelText("量 (ml)")
    fireEvent.change(input, { target: { value: "0" } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
    expect(mockedUpdateLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ amountMl: 0 }),
    )
  })

  it("量を空文字にして更新すると amountMl: null が updateLog に渡る（回帰）", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet userId="u1" open={true} onOpenChange={() => {}} log={bottleFeedingLog()} />,
    )

    const input = screen.getByLabelText("量 (ml)")
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
    expect(mockedUpdateLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ amountMl: null }),
    )
  })
})

describe("BabyLogFormSheet の搾乳（pumped）作成 + 量プリセット", () => {
  it("搾乳を create モードで開くと量プリセット（10〜100）が並ぶ", () => {
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={null}
        createLogType="feeding"
        createFeedingType="pumped"
      />,
    )
    // 10刻み・10〜100mL の 10 個のプリセット
    for (const ml of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      expect(
        screen.getByRole("button", { name: String(ml) }),
      ).toBeInTheDocument()
    }
  })

  it("プリセットを押すと量入力欄に反映され、記録で recordFeeding に pumped + amountMl が渡る", async () => {
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "feed-1" })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={null}
        createLogType="feeding"
        createFeedingType="pumped"
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "60" }))
    // プリセットは自由入力欄へ反映される（100mL 超も入力欄で指定可能なため）
    expect((screen.getByLabelText("量 (ml)") as HTMLInputElement).value).toBe(
      "60",
    )

    fireEvent.click(screen.getByRole("button", { name: "記録する" }))
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalled())
    expect(mockedRecordFeeding).toHaveBeenCalledWith(
      expect.objectContaining({ feedingType: "pumped", amountMl: 60 }),
    )
  })

  it("プリセットを使わず自由入力（120mL）でも記録できる（プリセットは天井でない）", async () => {
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "feed-2" })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={null}
        createLogType="feeding"
        createFeedingType="pumped"
      />,
    )

    fireEvent.change(screen.getByLabelText("量 (ml)"), {
      target: { value: "120" },
    })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalled())
    expect(mockedRecordFeeding).toHaveBeenCalledWith(
      expect.objectContaining({ feedingType: "pumped", amountMl: 120 }),
    )
  })
})

describe("BabyLogFormSheet の記録時刻の編集・指定（タスクB）", () => {
  it("編集: 時刻入力は既存 logged_at を JST HH:mm で seed する", () => {
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={bottleFeedingLog()}
      />,
    )
    // logged_at 2026-07-18T12:00:00+09:00 → "12:00"
    expect((screen.getByLabelText("時刻") as HTMLInputElement).value).toBe(
      "12:00",
    )
  })

  it("編集: 時刻を変更すると updateLog に loggedAt(ISO)が渡る", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={bottleFeedingLog()}
      />,
    )
    fireEvent.change(screen.getByLabelText("時刻"), {
      target: { value: "13:30" },
    })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
    // jstWallClockToIso("2026-07-18","13:30") = 2026-07-18T04:30Z（JST 罠回避）
    expect(mockedUpdateLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ loggedAt: "2026-07-18T04:30:00.000Z" }),
    )
  })

  it("編集: 時刻を未来に変更するとクライアントで拒否し updateLog を呼ばない", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    // 遠未来の日付のログで時刻を（seed から）変更して保存 → 未来として弾かれる。
    // 新仕様では時刻検証は「時刻を触った時のみ」走るため、seed と異なる値に変更する。
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={bottleFeedingLog({
          logged_at: "2099-06-15T10:00:00+09:00",
        })}
      />,
    )
    fireEvent.change(screen.getByLabelText("時刻"), {
      target: { value: "11:00" },
    })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(FUTURE_LOG_TIME_ERROR),
    )
    expect(mockedUpdateLog).not.toHaveBeenCalled()
  })

  it("編集: 時刻を変更せず量のみ編集すると updateLog に loggedAt を含めない（秒丸め防止の回帰）", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={bottleFeedingLog()}
      />,
    )
    // 時刻入力は触らず、量だけ変更して更新する
    fireEvent.change(screen.getByLabelText("量 (ml)"), {
      target: { value: "120" },
    })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
    const updates = mockedUpdateLog.mock.calls[0][1]
    // loggedAt を送らなければ updateLog は既存 logged_at（秒精度含む）を変更しない
    expect(updates).not.toHaveProperty("loggedAt")
    expect(updates).toMatchObject({ amountMl: 120 })
  })

  it("編集: 時刻を seed から変更→元に戻すと loggedAt を含めない（同値なら未 dirty）", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={bottleFeedingLog()}
      />,
    )
    // seed は "12:00"。一度変えてから元に戻す
    fireEvent.change(screen.getByLabelText("時刻"), {
      target: { value: "13:30" },
    })
    fireEvent.change(screen.getByLabelText("時刻"), {
      target: { value: "12:00" },
    })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
    expect(mockedUpdateLog.mock.calls[0][1]).not.toHaveProperty("loggedAt")
  })

  it("作成(メモ): loggedAt が recordMemo に渡る", async () => {
    mockedRecordMemo.mockResolvedValue({ error: null, id: "memo-1" })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={null}
        createLogType="memo"
      />,
    )
    fireEvent.change(screen.getByLabelText("メモ"), {
      target: { value: "メモ本文" },
    })
    // 当日の早朝時刻は未来にならない（+5 分許容内）
    fireEvent.change(screen.getByLabelText("時刻"), {
      target: { value: "00:01" },
    })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))

    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalled())
    const arg = mockedRecordMemo.mock.calls[0][0]
    expect(arg.memo).toBe("メモ本文")
    expect(typeof arg.loggedAt).toBe("string")
  })

  it("作成(搾乳): 楽観 append する行の logged_at が record に渡した loggedAt と一致", async () => {
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "feed-1" })
    const onLogRecorded = vi.fn()
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={null}
        createLogType="feeding"
        createFeedingType="pumped"
        onLogRecorded={onLogRecorded}
      />,
    )
    fireEvent.change(screen.getByLabelText("時刻"), {
      target: { value: "00:01" },
    })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))

    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalled())
    const sentLoggedAt = mockedRecordFeeding.mock.calls[0][0].loggedAt
    expect(sentLoggedAt).toBeTruthy()
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalled())
    // 楽観 append 行の logged_at が DB へ送った loggedAt と一致（表示と DB の整合）
    expect(onLogRecorded.mock.calls[0][0].logged_at).toBe(sentLoggedAt)
  })
})

describe("BabyLogFormSheet のメモ複数行入力（textarea）", () => {
  it("メモ欄は textarea で、改行を含む本文をそのまま recordMemo へ渡す", async () => {
    mockedRecordMemo.mockResolvedValue({ error: null, id: "memo-1" })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={null}
        createLogType="memo"
      />,
    )

    const memoField = screen.getByLabelText("メモ")
    // Input(text) ではなく Textarea に置き換わっている
    expect(memoField.tagName).toBe("TEXTAREA")

    fireEvent.change(memoField, { target: { value: "1行目\n2行目\n3行目" } })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))

    await waitFor(() => expect(mockedRecordMemo).toHaveBeenCalled())
    // 時刻指定（#151）との合流後、作成時は loggedAt が併送されるため memo のみの厳密一致は見ない
    expect(mockedRecordMemo).toHaveBeenCalledWith(
      expect.objectContaining({ memo: "1行目\n2行目\n3行目" }),
    )
  })
})

// B-07: startTransition 内の Server Action が reject（通信断）すると error boundary へ
// bubble する（error-handling.md:375）。作成/更新/削除の 3 ハンドラが try/catch で
// 握り、圏外トーストへ倒すことを固定する。toast.error(OFFLINE_MESSAGE) が呼ばれる
// こと自体が catch 発火（= reject 未処理漏れなし）の証跡。
const OFFLINE_MESSAGE =
  "通信できませんでした。電波の良い場所でもう一度お試しください"

describe("BabyLogFormSheet の通信断 reject 握り（B-07）", () => {
  it("作成（メモ）の recordMemo が reject → 圏外トースト", async () => {
    mockedRecordMemo.mockRejectedValue(new Error("network down"))
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={null}
        createLogType="memo"
      />,
    )
    fireEvent.change(screen.getByLabelText("メモ"), {
      target: { value: "テストメモ" },
    })
    fireEvent.click(screen.getByRole("button", { name: "記録する" }))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("更新（updateLog）が reject → 圏外トースト", async () => {
    mockedUpdateLog.mockRejectedValue(new Error("network down"))
    render(
      <BabyLogFormSheet userId="u1" open={true} onOpenChange={() => {}} log={bottleFeedingLog()} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("削除（deleteLog）が reject → 圏外トースト", async () => {
    mockedDeleteLog.mockRejectedValue(new Error("network down"))
    render(
      <BabyLogFormSheet userId="u1" open={true} onOpenChange={() => {}} log={bottleFeedingLog()} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "この記録を削除" }))
    fireEvent.click(screen.getByRole("button", { name: "削除する" }))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })
})

describe("BabyLogFormSheet の授乳時間（duration）編集", () => {
  function breastFeedingLog(overrides: Partial<BabyLogData> = {}): BabyLogData {
    return bottleFeedingLog({
      feeding_type: "breast_left",
      amount_ml: null,
      duration_sec: 330,
      duration_min: 6,
      ...overrides,
    })
  }

  it("母乳の編集で時間欄が duration_sec から分・秒に seed される", () => {
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={breastFeedingLog()}
      />,
    )
    expect(
      (screen.getByLabelText("時間（分）") as HTMLInputElement).value,
    ).toBe("5")
    expect(
      (screen.getByLabelText("時間（秒）") as HTMLInputElement).value,
    ).toBe("30")
  })

  it("#140 以前の旧行（duration_min のみ）は min*60 で seed され、未変更保存で durationSec を送らない", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={breastFeedingLog({ duration_sec: null, duration_min: 5 })}
      />,
    )
    // 旧行の分精度が 5分0秒 として seed される（silent 消滅の防止）
    expect(
      (screen.getByLabelText("時間（分）") as HTMLInputElement).value,
    ).toBe("5")
    expect(
      (screen.getByLabelText("時間（秒）") as HTMLInputElement).value,
    ).toBe("0")

    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
    // 時間を触っていないので durationSec は送らない（dirty check）
    expect(mockedUpdateLog.mock.calls[0][1]).not.toHaveProperty("durationSec")
  })

  it("時間を変更して保存すると durationSec（合算秒）が updateLog に渡る", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={breastFeedingLog()}
      />,
    )
    fireEvent.change(screen.getByLabelText("時間（分）"), {
      target: { value: "12" },
    })
    fireEvent.change(screen.getByLabelText("時間（秒）"), {
      target: { value: "15" },
    })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
    expect(mockedUpdateLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ durationSec: 12 * 60 + 15 }),
    )
  })

  it("両方空にして保存すると durationSec: null（時間なしへ戻す）", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={breastFeedingLog()}
      />,
    )
    fireEvent.change(screen.getByLabelText("時間（分）"), {
      target: { value: "" },
    })
    fireEvent.change(screen.getByLabelText("時間（秒）"), {
      target: { value: "" },
    })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
    expect(mockedUpdateLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ durationSec: null }),
    )
  })

  it("母乳以外へ種類変更すると durationSec: null を明示送信し時間欄は消える", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={breastFeedingLog()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    expect(screen.queryByLabelText("時間（分）")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => expect(mockedUpdateLog).toHaveBeenCalled())
    expect(mockedUpdateLog).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ feedingType: "bottle", durationSec: null }),
    )
  })

  it("0分0秒はクライアントで拒否し updateLog を呼ばない", async () => {
    mockedUpdateLog.mockResolvedValue({ error: null })
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={breastFeedingLog()}
      />,
    )
    fireEvent.change(screen.getByLabelText("時間（分）"), {
      target: { value: "0" },
    })
    fireEvent.change(screen.getByLabelText("時間（秒）"), {
      target: { value: "0" },
    })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(
        expect.stringContaining("1秒以上"),
      ),
    )
    expect(mockedUpdateLog).not.toHaveBeenCalled()
  })

  it("ミルクの編集では時間欄を表示しない", () => {
    render(
      <BabyLogFormSheet
        userId="u1"
        open={true}
        onOpenChange={() => {}}
        log={bottleFeedingLog()}
      />,
    )
    expect(screen.queryByLabelText("時間（分）")).toBeNull()
  })
})
