/**
 * 掃除ルーティーンの周期計算の契約（要件台帳 B-03 / B-05 / B-06 / B-07a〜f、V-B）。
 *
 * 暦の前提: 2026-11-11 は水曜。2026-11-07 / 11-14 / 11-21 は土曜、11-15 は日曜。
 */
import { describe, expect, it } from "vitest"
import {
  addCadence,
  bucketOf,
  CLEANING_FILTERS,
  closeKeyLimit,
  describeCadence,
  formatYmdJa,
  isDueSoonBucket,
  marksOfLogs,
  matchesCleaningFilter,
  routineStatus,
  routineStatusFromMarks,
  scheduledDates,
  type CleaningLog,
  type CleaningRoutine,
} from "../cleaning-schedule"

const R = "f5000000-0000-4000-8000-000000000001"
const OTHER = "f5000000-0000-4000-8000-000000000002"
const V = "2026-11-01T00:00:00.000000+00:00"
const WED = "2026-11-11"

let seq = 0
function routine(over: Partial<CleaningRoutine> = {}): CleaningRoutine {
  return {
    id: R,
    name: "浴室の排水口",
    location: "浴室",
    cadence_unit: "week",
    cadence_interval: 1,
    schedule_mode: "fixed",
    anchor_date: "2026-11-07",
    postponed_occurrence: null,
    postponed_until: null,
    paused_at: null,
    resume_floor: null,
    archived: false,
    updated_at: V,
    created_at: V,
    ...over,
  }
}
function log(over: Partial<CleaningLog>): CleaningLog {
  seq += 1
  return {
    id: `f5000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    routine_id: R,
    kind: "done",
    done_on: null,
    occurrence: null,
    note: null,
    voided_at: null,
    created_by: null,
    updated_at: V,
    created_at: V,
    ...over,
  }
}
const done = (doneOn: string, occurrence: string | null = null, over: Partial<CleaningLog> = {}) =>
  log({ kind: "done", done_on: doneOn, occurrence, ...over })
const skip = (occurrence: string, over: Partial<CleaningLog> = {}) =>
  log({ kind: "skip", done_on: null, occurrence, ...over })

const weeklySat = () => routine()
const afterDone = (over: Partial<CleaningRoutine> = {}) =>
  routine({ schedule_mode: "after_done", anchor_date: WED, ...over })

describe("B-07a 固定「毎週土曜」を日曜に実施しても次回は次の土曜", () => {
  it("日曜の時点では土曜の回が 1 日超過しており、完了すると次回は次の土曜になる", () => {
    const sunday = "2026-11-15"
    const saturdays = routine({ anchor_date: "2026-11-14" })
    expect(describeCadence(saturdays)).toBe("毎週土曜")
    const before = routineStatus(saturdays, [], sunday)
    expect(before.currentOccurrence).toBe("2026-11-14")
    expect(before.overdueDays).toBe(1)
    expect(before.nextAfterCompletion(sunday)).toBe("2026-11-21")

    const after = routineStatus(saturdays, [done(sunday, "2026-11-14")], sunday)
    expect(after.dueOn).toBe("2026-11-21")
    expect(after.currentOccurrence).toBe("2026-11-21")
    expect(after.lastDoneOn).toBe(sunday)
    expect(after.overdueDays).toBe(0)
  })

  it("対照: 同じ操作を実施基準で行うと次回は翌日曜になる（固定とは結果が違う）", () => {
    const sunday = "2026-11-15"
    const r = afterDone({ anchor_date: "2026-11-14" })
    expect(routineStatus(r, [done(sunday, "2026-11-14")], sunday).dueOn).toBe("2026-11-22")
  })
})

describe("B-07b 実施基準「7 日ごと」を日曜に実施したら次回は翌日曜", () => {
  it("水曜が期限の回を日曜に実施すると、次回は実施日の 7 日後", () => {
    const sunday = "2026-11-15"
    const before = routineStatus(afterDone(), [], sunday)
    expect(before.dueOn).toBe(WED)
    expect(before.overdueDays).toBe(4)
    expect(before.nextAfterCompletion(sunday)).toBe("2026-11-22")
    const after = routineStatus(afterDone(), [done(sunday, WED)], sunday)
    expect(after.dueOn).toBe("2026-11-22")
    expect(after.daysSinceLastDone).toBe(0)
  })

  it("期限より前に実施しても、次回は実施日から数える", () => {
    const r = afterDone({ anchor_date: "2026-11-18" })
    const status = routineStatus(r, [done(WED, "2026-11-18")], WED)
    expect(status.dueOn).toBe("2026-11-18")
    // 表示上の期限は閉じた回と同じ日付だが、鍵は未閉鎖の日付へ逃がす（さもなくば二度と完了できぬ）
    expect(status.currentOccurrence).toBe("2026-11-19")
  })
})

describe("B-07c 月・年を 30 日・365 日へ換算しない", () => {
  it("実施基準の 1 ヶ月後は暦の翌月（1/31 → 2/28。30 日後の 3/2 ではない）", () => {
    expect(addCadence("2026-01-31", "month", 1)).toBe("2026-02-28")
    const r = afterDone({ cadence_unit: "month", anchor_date: "2026-01-10" })
    expect(routineStatus(r, [done("2026-01-31", "2026-01-10")], "2026-02-01").dueOn).toBe("2026-02-28")
  })

  it("実施基準の 1 年後は暦の翌年同日（うるう日を挟んでも 365 日後の 2/29 にならぬ）", () => {
    expect(addCadence("2027-03-01", "year", 1)).toBe("2028-03-01")
    const r = afterDone({ cadence_unit: "year", anchor_date: "2027-03-01" })
    expect(routineStatus(r, [done("2027-03-01", "2027-03-01")], "2027-03-02").dueOn).toBe("2028-03-01")
  })

  it("固定の毎月 15 日は、月の長さに関わらず毎月 15 日", () => {
    const r = routine({ cadence_unit: "month", anchor_date: "2026-01-15" })
    expect(scheduledDates(r, "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      "2026-04-15",
    ])
  })
})

describe("B-07d 月末・うるう日は元の基準日を保ち、永久にずれない", () => {
  it("毎月 31 日: 1/31 → 2/28 → 3/31 → 4/30 → 5/31", () => {
    const r = routine({ cadence_unit: "month", anchor_date: "2026-01-31" })
    expect(scheduledDates(r, "2026-01-01", "2026-05-31")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ])
  })

  it("毎年 2/29: 平年は 2/28、次のうるう年に 2/29 へ戻る", () => {
    const r = routine({ cadence_unit: "year", anchor_date: "2024-02-29" })
    expect(scheduledDates(r, "2024-01-01", "2028-12-31")).toEqual([
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
    ])
  })

  it("2/28 に寄った回を完了しても、3 月の予定日は 31 日のまま", () => {
    const r = routine({ cadence_unit: "month", anchor_date: "2026-01-31" })
    const status = routineStatus(r, [done("2026-02-28", "2026-02-28")], "2026-02-28")
    expect(status.dueOn).toBe("2026-03-31")
  })

  it("実施基準の月・年は実施日が新しい基準になる（2/28 に実施 → 3/28）", () => {
    const monthly = afterDone({ cadence_unit: "month", anchor_date: "2026-01-31" })
    expect(routineStatus(monthly, [done("2026-02-28", "2026-01-31")], "2026-03-01").dueOn).toBe("2026-03-28")
    const yearly = afterDone({ cadence_unit: "year", anchor_date: "2024-02-29" })
    expect(routineStatus(yearly, [done("2025-03-01", "2024-02-29")], "2025-03-02").dueOn).toBe("2026-03-01")
  })

  it("2 年ごと・3 ヶ月ごとの間隔も基準日から数える", () => {
    expect(
      scheduledDates(routine({ cadence_unit: "year", cadence_interval: 2, anchor_date: "2024-02-29" }), "2024-01-01", "2030-12-31"),
    ).toEqual(["2024-02-29", "2026-02-28", "2028-02-29", "2030-02-28"])
    expect(
      scheduledDates(routine({ cadence_unit: "month", cadence_interval: 3, anchor_date: "2026-11-30" }), "2026-11-01", "2027-08-31"),
    ).toEqual(["2026-11-30", "2027-02-28", "2027-05-30", "2027-08-30"])
  })
})

describe("B-07e 数周期遅れた完了は現在の回だけを閉じる", () => {
  const r = routine({ anchor_date: "2026-10-03" })

  it("固定: 6 回逃した状態では最も新しい回が対象で、超過は最も古い回から数える", () => {
    const status = routineStatus(r, [], WED)
    expect(status.currentOccurrence).toBe("2026-11-07")
    expect(status.scheduledOn).toBe("2026-10-03")
    expect(status.openCount).toBe(6)
    expect(status.overdueDays).toBe(39)
    expect(status.nextAfterCompletion(WED)).toBe("2026-11-14")
  })

  it("固定: 完了すると次の未来の期日へ進み、逃した回の履歴は作られず前回実施日は今日だけ", () => {
    const logs = [done(WED, "2026-11-07")]
    const status = routineStatus(r, logs, WED)
    expect(status.dueOn).toBe("2026-11-14")
    expect(status.overdueDays).toBe(0)
    expect(status.openCount).toBe(0)
    expect(status.lastDoneOn).toBe(WED)
    // 逃した回を実施済みにしておらぬ: 回を閉じた履歴は 1 件だけ
    expect(marksOfLogs(logs).maxOccurrence).toBe("2026-11-07")
    expect(logs).toHaveLength(1)
  })

  it("実施基準: 何周期遅れても回は 1 つで、完了すると実施日から数え直す", () => {
    const late = afterDone({ anchor_date: "2026-10-03" })
    const before = routineStatus(late, [], WED)
    expect(before.openCount).toBe(0)
    expect(before.overdueDays).toBe(39)
    expect(routineStatus(late, [done(WED, "2026-10-03")], WED).dueOn).toBe("2026-11-18")
  })
})

describe("B-07f 延期・スキップは実施記録と分離し、基準を変えない", () => {
  it("延期は現在の回の期限だけを動かす（前回実施日・予定日の並びは不変）", () => {
    const plain = routineStatus(weeklySat(), [], WED)
    expect(plain.overdueDays).toBe(4)
    const postponedRoutine = routine({ postponed_occurrence: "2026-11-07", postponed_until: "2026-11-13" })
    const status = routineStatus(postponedRoutine, [], WED)
    expect(status.postponed).toBe(true)
    expect(status.dueOn).toBe("2026-11-13")
    expect(status.overdueDays).toBe(0)
    expect(status.currentOccurrence).toBe("2026-11-07")
    expect(status.lastDoneOn).toBeNull()
    expect(scheduledDates(postponedRoutine, "2026-11-01", "2026-11-30")).toEqual(
      scheduledDates(weeklySat(), "2026-11-01", "2026-11-30"),
    )
    // 完了後の次回は元の曜日のまま
    expect(status.nextAfterCompletion(WED)).toBe("2026-11-14")
  })

  it("延期は次の回には及ばない（次の予定日が来たら通常の期限へ戻る）", () => {
    const postponedRoutine = routine({ postponed_occurrence: "2026-11-07", postponed_until: "2026-11-13" })
    const status = routineStatus(postponedRoutine, [], "2026-11-14")
    expect(status.currentOccurrence).toBe("2026-11-14")
    expect(status.postponed).toBe(false)
  })

  it("延期した回を完了すれば、延期の印は次の回へ持ち越されない", () => {
    const postponedRoutine = routine({ postponed_occurrence: "2026-11-07", postponed_until: "2026-11-13" })
    const status = routineStatus(postponedRoutine, [done("2026-11-12", "2026-11-07")], "2026-11-12")
    expect(status.postponed).toBe(false)
    expect(status.dueOn).toBe("2026-11-14")
  })

  it("実施基準の延期も期限だけを動かし、完了後は実施日から数える", () => {
    const r = afterDone({ postponed_occurrence: WED, postponed_until: "2026-11-20" })
    const status = routineStatus(r, [], "2026-11-12")
    expect(status.dueOn).toBe("2026-11-20")
    expect(status.overdueDays).toBe(0)
    expect(status.nextAfterCompletion("2026-11-12")).toBe("2026-11-19")
  })

  it("固定のスキップは次の予定日へ進み、前回実施日を動かさない", () => {
    const logs = [done("2026-10-31", "2026-10-31"), skip("2026-11-07")]
    const status = routineStatus(routine({ anchor_date: "2026-10-31" }), logs, WED)
    expect(status.dueOn).toBe("2026-11-14")
    expect(status.lastDoneOn).toBe("2026-10-31")
    expect(status.daysSinceLastDone).toBe(11)
  })

  it("実施基準のスキップは、その回の予定日から次周期へ進む（スキップした日からではない）", () => {
    const before = routineStatus(afterDone(), [], "2026-11-13")
    expect(before.nextAfterSkip()).toBe("2026-11-18")
    const status = routineStatus(afterDone(), [skip(WED)], "2026-11-13")
    expect(status.dueOn).toBe("2026-11-18")
    expect(status.lastDoneOn).toBeNull()
    expect(status.daysSinceLastDone).toBeNull()
  })
})

describe("R17 実施基準の起点は「最後の閉鎖」（日付の大きい方ではない）", () => {
  // 週 1・前回 11/01（予定 11/08）。11/03 に 11/08 の回をスキップ（次回 11/15）
  const r = afterDone({ anchor_date: "2026-10-25" })
  const base = [done("2026-11-01", "2026-10-25"), skip("2026-11-08")]

  it("先の回をスキップした後に早めに実施したら、次回はスキップした予定日からではなく実施日から数える", () => {
    const before = routineStatus(r, base, "2026-11-05")
    expect(before.dueOn).toBe("2026-11-15")
    // 「今日やると、次回は…」の予告も実施日から
    expect(before.nextAfterCompletion("2026-11-05")).toBe("2026-11-12")
    const key = before.currentOccurrence
    expect(key).toBe("2026-11-15")
    const after = routineStatus(r, [...base, done("2026-11-05", key)], "2026-11-05")
    expect(after.dueOn).toBe("2026-11-12")
    expect(after.lastDoneOn).toBe("2026-11-05")
    // 鍵は閉じた回（11/15）より後へ逃がす
    expect(after.currentOccurrence).toBe("2026-11-16")
  })

  it("年 1 回でも同じ（先の回をスキップしてから実施 → 実施日の 1 年後）", () => {
    const yearly = afterDone({ cadence_unit: "year", anchor_date: "2027-09-10" })
    const logs = [done("2028-09-10", "2027-09-10"), skip("2029-09-10")]
    const before = routineStatus(yearly, logs, "2028-12-17")
    expect(before.dueOn).toBe("2030-09-10")
    const after = routineStatus(yearly, [...logs, done("2028-12-17", before.currentOccurrence)], "2028-12-17")
    expect(after.dueOn).toBe("2029-12-17")
  })

  it("対照: スキップが最後の閉鎖なら、スキップした回の日付から次周期へ進む", () => {
    expect(routineStatus(r, base, "2026-11-05").dueOn).toBe("2026-11-15")
    // 続けてスキップしても 1 周期ずつ進む
    const twice = routineStatus(r, [...base, skip("2026-11-15")], "2026-11-05")
    expect(twice.dueOn).toBe("2026-11-22")
    expect(twice.lastDoneOn).toBe("2026-11-01")
  })

  it("対照: スキップの後の過去日の追記（回を閉じぬ）は、スキップを無かったことにせぬ", () => {
    const older = routineStatus(r, [...base, done("2026-10-30")], "2026-11-05")
    expect(older.dueOn).toBe("2026-11-15")
    // スキップした回より新しい実施日の追記は、その実施日が起点になる
    const newer = routineStatus(r, [...base, done("2026-11-10")], "2026-11-11")
    expect(newer.dueOn).toBe("2026-11-17")
  })

  it("実施を取り消せば、その前のスキップが再び最後の閉鎖になる", () => {
    const voided = done("2026-11-05", "2026-11-15", { voided_at: "2026-11-05T03:00:00+00:00" })
    expect(routineStatus(r, [...base, voided], "2026-11-05").dueOn).toBe("2026-11-15")
  })

  it("スキップの後に実施しても、予告（nextAfterCompletion / nextAfterSkip）と実際が一致する", () => {
    const before = routineStatus(r, base, "2026-11-05")
    const key = before.currentOccurrence ?? ""
    expect(routineStatus(r, [...base, done("2026-11-05", key)], "2026-11-05").dueOn).toBe(
      before.nextAfterCompletion("2026-11-05"),
    )
    expect(routineStatus(r, [...base, skip(key)], "2026-11-05").dueOn).toBe(before.nextAfterSkip())
  })
})

describe("B-07f 実施基準のスキップは、対象回の予定日から次周期へ（鍵が予定日から逃げた回でも）", () => {
  // 最初の予定日 11/11・週 1・履歴なし → 11/04 に早めに実施して鍵 11/11 を閉じる。
  // 次の予定日は 11/04 + 7 = 11/11 で、閉じた鍵と重なるゆえ、鍵は 11/12 へ逃げる（予定日は 11/11 のまま）
  const r = afterDone({ anchor_date: WED })
  const early = [done("2026-11-04", WED)]
  const today = "2026-11-05"

  it("前提: 予定日は 11/11、鍵は 11/12（表示は予定日）", () => {
    const status = routineStatus(r, early, today)
    expect(status.scheduledOn).toBe(WED)
    expect(status.dueOn).toBe(WED)
    expect(status.currentOccurrence).toBe("2026-11-12")
  })

  it("スキップの予告は予定日から数える（11/18。鍵の 11/12 からの 11/19 ではない）", () => {
    expect(routineStatus(r, early, today).nextAfterSkip()).toBe("2026-11-18")
  })

  it("スキップした後の次回も予定日から数え、前回実施日は動かさない（履歴は予定日を持つ）", () => {
    const before = routineStatus(r, early, today)
    const skipped = skip("2026-11-12", { scheduled_on: WED })
    const after = routineStatus(r, [...early, skipped], today)
    expect(after.dueOn).toBe("2026-11-18")
    expect(after.dueOn).toBe(before.nextAfterSkip())
    expect(after.lastDoneOn).toBe("2026-11-04")
    // 新しい鍵は閉じた鍵より後ろ（同じ回を二度閉じぬ）
    expect(after.currentOccurrence).toBe("2026-11-18")
    expect(marksOfLogs([...early, skipped]).lastSkipScheduledOn).toBe(WED)
  })

  it("要約（cleaning_log_marks）から計算しても同じ。対照: 予定日を持たぬ要約は鍵へ退化する", () => {
    const marks = { lastDoneOn: "2026-11-04", maxOccurrence: "2026-11-12", maxSkipOccurrence: "2026-11-12" }
    expect(routineStatusFromMarks(r, { ...marks, lastSkipScheduledOn: WED }, today).dueOn).toBe("2026-11-18")
    expect(routineStatusFromMarks(r, marks, today).dueOn).toBe("2026-11-19")
  })

  it("延期中の回をスキップしても、延期前の予定日から数える", () => {
    const postponed = afterDone({ anchor_date: WED, postponed_occurrence: "2026-11-12", postponed_until: "2026-11-14" })
    const before = routineStatus(postponed, early, today)
    expect(before.postponed).toBe(true)
    expect(before.dueOn).toBe("2026-11-14")
    expect(before.scheduledOn).toBe(WED)
    expect(before.nextAfterSkip()).toBe("2026-11-18")
    const after = routineStatus(postponed, [...early, skip("2026-11-12", { scheduled_on: WED })], today)
    expect(after.dueOn).toBe("2026-11-18")
    expect(after.postponed).toBe(false)
  })

  it("続けてスキップしても 1 周期ずつ進む（11/18 → 11/25）", () => {
    const logs = [...early, skip("2026-11-12", { scheduled_on: WED })]
    const second = routineStatus(r, logs, today)
    expect(second.nextAfterSkip()).toBe("2026-11-25")
    const after = routineStatus(r, [...logs, skip("2026-11-18", { scheduled_on: "2026-11-18" })], today)
    expect(after.dueOn).toBe("2026-11-25")
  })

  it("対照: 鍵が逃げぬ普通の回（前回実施 11/04 → 予定 11/11）も 11/18", () => {
    const plain = afterDone({ anchor_date: "2026-10-28" })
    const logs = [done("2026-11-04", "2026-10-28")]
    const before = routineStatus(plain, logs, today)
    expect(before.currentOccurrence).toBe(WED)
    expect(before.nextAfterSkip()).toBe("2026-11-18")
    expect(routineStatus(plain, [...logs, skip(WED, { scheduled_on: WED })], today).dueOn).toBe("2026-11-18")
  })

  it("月末: 1/31 に 2/28 の回を早めに実施 → 予定 2/28・鍵 3/1 → スキップ後は 3/28（DB の pgTAP と同じ入力）", () => {
    const monthly = afterDone({ cadence_unit: "month", anchor_date: "2026-01-01" })
    const logs = [done("2026-01-31", "2026-02-28")]
    const before = routineStatus(monthly, logs, "2026-02-01")
    expect(before.scheduledOn).toBe("2026-02-28")
    expect(before.currentOccurrence).toBe("2026-03-01")
    expect(before.nextAfterSkip()).toBe("2026-03-28")
    const after = routineStatus(monthly, [...logs, skip("2026-03-01", { scheduled_on: "2026-02-28" })], "2026-02-01")
    expect(after.dueOn).toBe("2026-03-28")
  })

  it("閏日: 2024-02-29 に翌年の回を早めに実施 → 予定 2025-02-28・鍵 3/1 → スキップ後は 2026-02-28", () => {
    const yearly = afterDone({ cadence_unit: "year", anchor_date: "2024-02-29" })
    const logs = [done("2024-02-29", "2025-02-28")]
    const before = routineStatus(yearly, logs, "2024-03-01")
    expect(before.scheduledOn).toBe("2025-02-28")
    expect(before.currentOccurrence).toBe("2025-03-01")
    expect(before.nextAfterSkip()).toBe("2026-02-28")
    const after = routineStatus(yearly, [...logs, skip("2025-03-01", { scheduled_on: "2025-02-28" })], "2024-03-01")
    expect(after.dueOn).toBe("2026-02-28")
  })

  it("再開日（対象開始日）で予定日が後ろへ寄った回のスキップは、寄せた予定日から数える", () => {
    const resumed = afterDone({ anchor_date: "2026-11-01", resume_floor: "2026-11-08" })
    const logs = [done("2026-10-30", "2026-11-01")]
    const before = routineStatus(resumed, logs, "2026-11-08")
    expect(before.scheduledOn).toBe("2026-11-08")
    expect(before.nextAfterSkip()).toBe("2026-11-15")
    const after = routineStatus(resumed, [...logs, skip("2026-11-08", { scheduled_on: "2026-11-08" })], "2026-11-08")
    expect(after.dueOn).toBe("2026-11-15")
  })

  it("対照: 固定の周期はスキップの予定日に依らず、格子の次の予定日（月末の寄せも従来どおり）", () => {
    const monthEnd = routine({ cadence_unit: "month", anchor_date: "2026-01-31" })
    const before = routineStatus(monthEnd, [], "2026-02-28")
    expect(before.currentOccurrence).toBe("2026-02-28")
    expect(before.nextAfterSkip()).toBe("2026-03-31")
    expect(routineStatus(monthEnd, [skip("2026-02-28", { scheduled_on: "2026-02-28" })], "2026-02-28").dueOn).toBe(
      "2026-03-31",
    )
  })
})

describe("R16 周期を変えた後の予定（要約の鍵は今の周期の世代だけ = cleaning_log_marks の契約）", () => {
  // 「毎月 30 日」の回を 11/11 に早めに完了（鍵 11/30）→ 同じ日に「毎週土曜（基準 11/14）」へ変更。
  // DB は世代を進め、今日実施済みゆえ対象開始日を明日（11/12）にする
  const changed = routine({ anchor_date: "2026-11-14", resume_floor: "2026-11-12" })

  it("変更前の格子で閉じた鍵を含まぬ要約なら、次回は新しい格子の最初の予定日", () => {
    const marks = { lastDoneOn: WED, maxOccurrence: null, maxSkipOccurrence: null }
    for (const today of [WED, "2026-11-13"]) {
      const status = routineStatusFromMarks(changed, marks, today)
      expect(status.dueOn).toBe("2026-11-14")
      expect(status.currentOccurrence).toBe("2026-11-14")
      expect(status.lastDoneOn).toBe(WED)
    }
    // 予定日を過ぎれば期限超過として出る（黙って飛ばぬ）
    const late = routineStatusFromMarks(changed, marks, "2026-11-16")
    expect(late.overdueDays).toBe(2)
    expect(late.openCount).toBe(1)
  })

  it("対照: 変更前の鍵（11/30）を要約に混ぜると、11/14・11/21・11/28 が一度も出ずに 12/05 まで飛ぶ", () => {
    const stale = { lastDoneOn: WED, maxOccurrence: "2026-11-30", maxSkipOccurrence: null }
    for (const today of [WED, "2026-11-14", "2026-11-28"]) {
      const status = routineStatusFromMarks(changed, stale, today)
      expect(status.dueOn).toBe("2026-12-05")
      expect(status.openCount).toBe(0)
    }
  })

  it("実施基準へ変えた時も、変更前の格子のスキップは起点にせぬ（前回実施日 + 新しい周期）", () => {
    const toAfterDone = afterDone({ anchor_date: "2026-11-14" })
    const marks = { lastDoneOn: "2026-11-01", maxOccurrence: null, maxSkipOccurrence: null }
    expect(routineStatusFromMarks(toAfterDone, marks, WED).dueOn).toBe("2026-11-08")
  })
})

describe("R18 閉じられる回は今日（基準日が未来なら基準日）から 2 周期先まで（DB の record_cleaning_log と同じ規則）", () => {
  it("上限の日付は周期の暦で数える（月末は寄せる）", () => {
    expect(closeKeyLimit(weeklySat(), WED)).toBe("2026-11-25")
    expect(closeKeyLimit(routine({ anchor_date: "2026-12-05" }), WED)).toBe("2026-12-19")
    expect(closeKeyLimit(routine({ cadence_unit: "month", anchor_date: "2026-01-31" }), "2026-12-31")).toBe("2027-02-28")
    expect(closeKeyLimit(routine({ cadence_unit: "year", cadence_interval: 2, anchor_date: "2024-02-29" }), WED)).toBe(
      "2030-11-11",
    )
    expect(closeKeyLimit(routine({ cadence_interval: 0 }), WED)).toBeNull()
  })

  it("実施基準: 今日完了し、先の 2 回をスキップした後は、次の回を閉じられぬと分かる", () => {
    const r = afterDone({ anchor_date: WED })
    const logs = [done(WED, WED)]
    const first = routineStatus(r, logs, WED)
    expect(first.currentOccurrence).toBe("2026-11-18")
    expect(first.closeLimitReached).toBe(false)
    logs.push(skip("2026-11-18"))
    const second = routineStatus(r, logs, WED)
    expect(second.currentOccurrence).toBe("2026-11-25")
    expect(second.closeLimitReached).toBe(false)
    logs.push(skip("2026-11-25"))
    const third = routineStatus(r, logs, WED)
    expect(third.currentOccurrence).toBe("2026-12-02")
    expect(third.closeLimitReached).toBe(true)
    // 予定日が近づけば（上限は今日から 2 周期）、また閉じられる
    expect(routineStatus(r, logs, "2026-11-18").closeLimitReached).toBe(false)
  })

  it("固定: 先の回を 2 回閉じた後の 3 回目は閉じられぬ。対照: 期日を迎えた回・休止中は対象外", () => {
    const logs = [done(WED, "2026-11-07"), skip("2026-11-14"), skip("2026-11-21")]
    const status = routineStatus(weeklySat(), logs, WED)
    expect(status.currentOccurrence).toBe("2026-11-28")
    expect(status.closeLimitReached).toBe(true)
    expect(routineStatus(weeklySat(), [], WED).closeLimitReached).toBe(false)
    expect(routineStatus(routine({ paused_at: "2026-11-01T00:00:00+00:00" }), logs, WED).closeLimitReached).toBe(false)
  })
})

describe("B-03 / B-05 前回実施日の正本は有効な履歴", () => {
  it("履歴が無ければ「未記録」（作成日・基準日を実施日にしない）", () => {
    const status = routineStatus(weeklySat(), [], WED)
    expect(status.lastDoneOn).toBeNull()
    expect(status.daysSinceLastDone).toBeNull()
  })

  it("取り消した履歴は数えず、前回実施日と対象回が元へ戻る", () => {
    const first = done("2026-11-01", "2026-10-31")
    const second = done(WED, "2026-11-07")
    const r = routine({ anchor_date: "2026-10-31" })
    expect(routineStatus(r, [first, second], WED).lastDoneOn).toBe(WED)
    const voided = { ...second, voided_at: "2026-11-11T03:00:00+00:00" }
    const status = routineStatus(r, [first, voided], WED)
    expect(status.lastDoneOn).toBe("2026-11-01")
    expect(status.daysSinceLastDone).toBe(10)
    expect(status.currentOccurrence).toBe("2026-11-07")
    expect(status.overdueDays).toBe(4)
  })

  it("実施日の訂正で日数と（実施基準の）次回が再計算される", () => {
    const entry = done("2026-11-10", WED)
    expect(routineStatus(afterDone(), [entry], "2026-11-12").dueOn).toBe("2026-11-17")
    const corrected = { ...entry, done_on: "2026-11-08" }
    const status = routineStatus(afterDone(), [corrected], "2026-11-12")
    expect(status.dueOn).toBe("2026-11-15")
    expect(status.daysSinceLastDone).toBe(4)
  })

  it("他の項目の履歴は数えない", () => {
    const status = routineStatus(weeklySat(), [done(WED, "2026-11-07", { routine_id: OTHER })], WED)
    expect(status.lastDoneOn).toBeNull()
    expect(status.overdueDays).toBe(4)
  })

  it("この版が知らぬ種類の履歴は回を閉じるが、実施としては数えない", () => {
    const unknownKind = log({ kind: "other", occurrence: "2026-11-07" })
    const status = routineStatus(weeklySat(), [unknownKind], WED)
    expect(status.lastDoneOn).toBeNull()
    expect(status.dueOn).toBe("2026-11-14")
  })
})

describe("B-06 過去日の追記", () => {
  it("固定: 過去日の追記（occurrence なし）は現在の回を閉じない", () => {
    const status = routineStatus(weeklySat(), [done("2026-11-01")], WED)
    expect(status.lastDoneOn).toBe("2026-11-01")
    expect(status.currentOccurrence).toBe("2026-11-07")
    expect(status.overdueDays).toBe(4)
  })

  it("対照: 同じ日付でも回を閉じる履歴なら次の回へ進む", () => {
    expect(routineStatus(weeklySat(), [done("2026-11-01", "2026-11-07")], WED).dueOn).toBe("2026-11-14")
  })

  it("実施基準: 最新の実施日より新しい追記は次回を再計算する", () => {
    const r = afterDone({ cadence_unit: "month", anchor_date: "2026-09-01" })
    const base = [done("2026-10-01", "2026-09-01")]
    expect(routineStatus(r, base, WED).dueOn).toBe("2026-11-01")
    expect(routineStatus(r, [...base, done("2026-10-20")], WED).dueOn).toBe("2026-11-20")
  })

  it("実施基準: 最新の実施日より古い追記は次回を変えない", () => {
    const r = afterDone({ cadence_unit: "month", anchor_date: "2026-09-01" })
    const logs = [done("2026-10-01", "2026-09-01"), done("2026-09-15")]
    expect(routineStatus(r, logs, WED).dueOn).toBe("2026-11-01")
  })
})

describe("休止と再開", () => {
  it("休止中は期限を数えず、区分は paused", () => {
    const status = routineStatus(routine({ anchor_date: "2026-09-05", paused_at: "2026-10-01T00:00:00+00:00" }), [], WED)
    expect(status.isPaused).toBe(true)
    expect(status.currentOccurrence).toBeNull()
    expect(status.overdueDays).toBe(0)
    expect(bucketOf(status, WED)).toBe("paused")
    expect(status.nextAfterCompletion(WED)).toBeNull()
  })

  it("固定: 再開日より前の予定日は超過として積み上げない", () => {
    const resumed = routine({ anchor_date: "2026-09-05", resume_floor: WED })
    const status = routineStatus(resumed, [], WED)
    expect(status.currentOccurrence).toBe("2026-11-14")
    expect(status.overdueDays).toBe(0)
    expect(status.openCount).toBe(0)
    // 対照: 下限が無ければ 9 月からの回が超過として残る
    expect(routineStatus(routine({ anchor_date: "2026-09-05" }), [], WED).overdueDays).toBe(67)
  })

  it("固定: 再開日がちょうど予定日なら、その日の回が対象になる", () => {
    const resumed = routine({ anchor_date: "2026-09-05", resume_floor: "2026-11-07" })
    expect(routineStatus(resumed, [], "2026-11-07").currentOccurrence).toBe("2026-11-07")
  })

  it("実施基準: 休止中に過ぎた期限は、再開日が期限になる", () => {
    const resumed = afterDone({ anchor_date: "2026-09-05", resume_floor: WED })
    const status = routineStatus(resumed, [done("2026-09-05", "2026-09-05")], "2026-11-12")
    expect(status.dueOn).toBe(WED)
    expect(status.overdueDays).toBe(1)
    expect(status.lastDoneOn).toBe("2026-09-05")
    // スキップは再開後の予定日から次周期へ
    expect(status.nextAfterSkip()).toBe("2026-11-18")
  })
})

describe("回の鍵は必ず未閉鎖の日付になる（同じ鍵を返すと二度と完了できなくなる）", () => {
  it("固定: 予定日より前に完了したら、次の鍵はその次の予定日", () => {
    const status = routineStatus(weeklySat(), [done("2026-11-12", "2026-11-14")], "2026-11-12")
    expect(status.currentOccurrence).toBe("2026-11-21")
    expect(status.dueOn).toBe("2026-11-21")
  })

  it("実施基準: 実施日の訂正で起点が戻っても、閉じた鍵は返さない", () => {
    const first = done("2026-11-01", "2026-10-25")
    const second = done("2026-10-20", "2026-11-08") // 11/8 の回を閉じた履歴の実施日を過去へ訂正した
    const r = afterDone({ anchor_date: "2026-10-25" })
    const status = routineStatus(r, [first, second], WED)
    expect(status.dueOn).toBe("2026-11-08")
    expect(status.currentOccurrence).toBe("2026-11-09")
    expect(marksOfLogs([first, second]).maxOccurrence).toBe("2026-11-08")
  })

  it("基準日が未来なら、最初の回の鍵は基準日", () => {
    const status = routineStatus(routine({ anchor_date: "2026-12-05" }), [], WED)
    expect(status.currentOccurrence).toBe("2026-12-05")
    expect(status.overdueDays).toBe(0)
  })
})

describe("nextAfterCompletion は、完了後に計算し直した期限と一致する", () => {
  const cases: Array<[string, CleaningRoutine, CleaningLog[], string]> = [
    ["固定・週", weeklySat(), [], WED],
    ["固定・月末", routine({ cadence_unit: "month", anchor_date: "2026-01-31" }), [], "2026-02-28"],
    ["固定・うるう日", routine({ cadence_unit: "year", anchor_date: "2024-02-29" }), [], "2026-03-05"],
    ["固定・予定日前", routine({ anchor_date: "2026-11-14" }), [], WED],
    ["実施基準・週", afterDone(), [], "2026-11-15"],
    ["実施基準・月", afterDone({ cadence_unit: "month", anchor_date: "2026-01-31" }), [], "2026-01-31"],
    ["実施基準・再開後", afterDone({ anchor_date: "2026-09-05", resume_floor: WED }), [], WED],
  ]
  it.each(cases)("%s", (_name, r, logs, today) => {
    const before = routineStatus(r, logs, today)
    const key = before.currentOccurrence
    expect(key).not.toBeNull()
    const predicted = before.nextAfterCompletion(today)
    const after = routineStatus(r, [...logs, done(today, key)], today)
    expect(after.dueOn).toBe(predicted)
    expect(after.currentOccurrence).not.toBe(key)
  })

  it.each(cases)("%s: スキップ後の期限も nextAfterSkip と一致する", (_name, r, logs, today) => {
    const before = routineStatus(r, logs, today)
    const key = before.currentOccurrence
    const predicted = before.nextAfterSkip()
    const after = routineStatus(r, [...logs, skip(key ?? "")], today)
    expect(after.dueOn).toBe(predicted)
  })
})

describe("bucketOf（週は月曜始まり・日曜終わり）", () => {
  const dueOn = (date: string, today = WED) =>
    bucketOf(routineStatus(afterDone({ anchor_date: date }), [], today), today)

  it("今日・今週・来週以降・期限超過を分ける", () => {
    expect(dueOn("2026-11-10")).toBe("overdue")
    expect(dueOn("2026-11-11")).toBe("today")
    expect(dueOn("2026-11-12")).toBe("this_week")
    expect(dueOn("2026-11-15")).toBe("this_week") // 日曜は同じ週の末尾
    expect(dueOn("2026-11-16")).toBe("later") // 月曜は翌週
  })

  it("今日が日曜なら、翌日の月曜は来週", () => {
    expect(dueOn("2026-11-15", "2026-11-15")).toBe("today")
    expect(dueOn("2026-11-16", "2026-11-15")).toBe("later")
  })

  it("B-01 年 1 回の項目でも、期限が今週なら今週に出る（フィルターの単位に依らない）", () => {
    const yearly = routine({ cadence_unit: "year", anchor_date: "2025-11-13", resume_floor: "2026-01-01" })
    const status = routineStatus(yearly, [], WED)
    expect(status.dueOn).toBe("2026-11-13")
    const bucket = bucketOf(status, WED)
    expect(bucket).toBe("this_week")
    expect(isDueSoonBucket(bucket)).toBe(true)
    // フィルターは周期の単位の絞り込み。「今日・今週」の判定には関与せぬ
    expect(CLEANING_FILTERS.map((filter) => matchesCleaningFilter(yearly, filter))).toEqual([true, false, false, true])
  })

  it("対照: 来月が期限の年次項目は今週に出ない", () => {
    const yearly = routine({ cadence_unit: "year", anchor_date: "2025-12-13", resume_floor: "2026-01-01" })
    const bucket = bucketOf(routineStatus(yearly, [], WED), WED)
    expect(bucket).toBe("later")
    expect(isDueSoonBucket(bucket)).toBe(false)
    expect(isDueSoonBucket("paused")).toBe(false)
  })
})

describe("入力が不正でも例外にせず、計算できないと返す", () => {
  it("基準日・間隔・今日が不正なら対象回は null", () => {
    for (const broken of [
      routine({ anchor_date: "2026-02-30" }),
      routine({ cadence_interval: 0 }),
      routine({ cadence_interval: 53 }),
      routine({ cadence_unit: "day" as never }),
      routine({ schedule_mode: "weekly" as never }),
    ]) {
      const status = routineStatus(broken, [], WED)
      expect(status.currentOccurrence).toBeNull()
      expect(status.dueOn).toBeNull()
      expect(bucketOf(status, WED)).toBe("later")
    }
    expect(routineStatus(weeklySat(), [], "2026-13-01").currentOccurrence).toBeNull()
  })

  it("不正な日付の履歴・要約は数えない", () => {
    const status = routineStatusFromMarks(
      weeklySat(),
      { lastDoneOn: "2026-02-30", maxOccurrence: "not-a-date", maxSkipOccurrence: null },
      WED,
    )
    expect(status.lastDoneOn).toBeNull()
    expect(status.currentOccurrence).toBe("2026-11-07")
  })

  it("scheduledDates は実施基準・不正な範囲で空を返す", () => {
    expect(scheduledDates(afterDone(), "2026-11-01", "2026-11-30")).toEqual([])
    expect(scheduledDates(weeklySat(), "2026-11-30", "2026-11-01")).toEqual([])
    expect(scheduledDates(weeklySat(), "2026-11-31", "2026-12-01")).toEqual([])
    // 基準日より前は含めぬ
    expect(scheduledDates(weeklySat(), "2026-10-01", "2026-11-14")).toEqual(["2026-11-07", "2026-11-14"])
    expect(scheduledDates(weeklySat(), "2026-11-07", "2027-11-07", 3)).toHaveLength(3)
  })
})

describe("読み下し", () => {
  it("固定は曜日・日付、実施基準は期間で読み下す", () => {
    expect(describeCadence(weeklySat())).toBe("毎週土曜")
    expect(describeCadence(routine({ cadence_interval: 2 }))).toBe("2週間ごとの土曜")
    expect(describeCadence(routine({ cadence_unit: "month", anchor_date: "2026-01-31" }))).toBe(
      "毎月31日（無い月は月末）",
    )
    expect(describeCadence(routine({ cadence_unit: "month", anchor_date: "2026-01-15" }))).toBe("毎月15日")
    expect(describeCadence(routine({ cadence_unit: "month", cadence_interval: 3, anchor_date: "2026-01-15" }))).toBe(
      "3ヶ月ごとの15日",
    )
    expect(describeCadence(routine({ cadence_unit: "year", anchor_date: "2024-02-29" }))).toBe(
      "毎年2月29日（うるう年でない年は2月28日）",
    )
    expect(describeCadence(routine({ cadence_unit: "year", cadence_interval: 2, anchor_date: "2026-03-15" }))).toBe(
      "2年ごとの3月15日",
    )
    expect(describeCadence(afterDone({ cadence_unit: "month", cadence_interval: 3 }))).toBe("実施した日から3ヶ月後")
    expect(describeCadence(routine({ anchor_date: "bad" }))).toBeNull()
  })

  it("暦日は曜日つきで、年が違う時だけ年を出す", () => {
    expect(formatYmdJa("2026-11-14", WED)).toBe("11月14日（土）")
    expect(formatYmdJa("2027-03-01", WED)).toBe("2027年3月1日（月）")
    expect(formatYmdJa("2026-02-30", WED)).toBeNull()
    expect(formatYmdJa(null)).toBeNull()
  })
})
