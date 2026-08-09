/**
 * 予定への通知設定（B-2）の語彙と導出の回帰テスト。
 *
 * ## 導出の 3 例は pgTAP と**同じ期待値**を共有する
 * `remind_at` の正本は SQL 側（`derive_event_remind_at()`）で、ここの
 * `deriveRemindAtIso` は**画面に出す予告**専用の写しじゃ。両者がずれると
 * 「予告と実際の通知時刻が違う」という嘘になるため、
 * `supabase/tests/event_reminders_grants_rls.sql` の D 群が**同じ 3 例・同じ JST**
 * を assert しておる。片方の実装だけ触れば片方が赤くなる。
 *
 *   終日 8/15 の 30 分前     → 8/14 23:30 JST
 *   09:00 JST 8/15 の 10 分前 → 8/15 08:50 JST
 *   8/20 の前日 20 時         → 8/19 20:00 JST
 */

import { describe, it, expect } from "vitest"
import {
  EVENT_REMINDER_MINUTES,
  REMINDER_OPTIONS,
  defaultReminderChoice,
  deriveRemindAtIso,
  formatRemindAtLabel,
  isReminderChoice,
  minutesToChoice,
  reminderChoiceToPayload,
  reminderRowToState,
  reminderTargetFromCreateResult,
} from "../event-reminder"

const ALL_DAY = { isAllDay: true, startDate: "2026-08-15", startAt: null }
// 2026-08-15T00:00:00Z = 09:00 JST
const TIMED = {
  isAllDay: false,
  startDate: "2026-08-15",
  startAt: "2026-08-15T00:00:00.000Z",
}

describe("deriveRemindAtIso（pgTAP D 群と同じ 3 例）", () => {
  it("終日予定は start_date の 00:00 JST から逆算する（8/15 の 30 分前 = 8/14 23:30 JST）", () => {
    expect(deriveRemindAtIso(ALL_DAY, "m30")).toBe("2026-08-14T14:30:00.000Z")
  })

  it("時刻付き予定は start_at から逆算する（09:00 JST の 10 分前 = 08:50 JST）", () => {
    expect(deriveRemindAtIso(TIMED, "m10")).toBe("2026-08-14T23:50:00.000Z")
  })

  it("prev_day_20 は start_date の前日 20:00 JST（8/20 → 8/19 20:00 JST）", () => {
    expect(
      deriveRemindAtIso(
        { isAllDay: true, startDate: "2026-08-20", startAt: null },
        "prev_day_20",
      ),
    ).toBe("2026-08-19T11:00:00.000Z")
  })

  it("prev_day_20 は時刻付き予定でも start_date だけを見る（開始時刻に依存せぬ）", () => {
    expect(deriveRemindAtIso(TIMED, "prev_day_20")).toBe(
      deriveRemindAtIso(ALL_DAY, "prev_day_20"),
    )
  })

  it("月初をまたぐ前日計算（9/1 → 8/31 20:00 JST）", () => {
    expect(
      deriveRemindAtIso(
        { isAllDay: true, startDate: "2026-09-01", startAt: null },
        "prev_day_20",
      ),
    ).toBe("2026-08-31T11:00:00.000Z")
  })

  it("時刻ありと言いつつ start_at が無い行は終日と同じ 00:00 JST 起点へ倒す（SQL の分岐と同一）", () => {
    expect(
      deriveRemindAtIso(
        { isAllDay: false, startDate: "2026-08-15", startAt: null },
        "m30",
      ),
    ).toBe(deriveRemindAtIso(ALL_DAY, "m30"))
  })

  it("none は導出せぬ（行を作らぬ意味ゆえ null）", () => {
    expect(deriveRemindAtIso(ALL_DAY, "none")).toBeNull()
  })

  it("不正な start_at は null（画面を倒さぬ）", () => {
    expect(
      deriveRemindAtIso(
        { isAllDay: false, startDate: "2026-08-15", startAt: "not-a-date" },
        "m10",
      ),
    ).toBeNull()
  })
})

describe("reminderChoiceToPayload", () => {
  it("none は null（= 行を消す）", () => {
    expect(reminderChoiceToPayload("none")).toBeNull()
  })

  it("m30 は minutes + 30", () => {
    expect(reminderChoiceToPayload("m30")).toEqual({
      remind_kind: "minutes",
      remind_minutes_before: 30,
    })
  })

  it("prev_day_20 は分を持たぬ（DB の双方向 CHECK と同じ契約）", () => {
    expect(reminderChoiceToPayload("prev_day_20")).toEqual({
      remind_kind: "prev_day_20",
      remind_minutes_before: null,
    })
  })

  it("remind_at は**含めぬ**（BEFORE トリガの領分・列 GRANT も無い）", () => {
    for (const o of REMINDER_OPTIONS) {
      const payload = reminderChoiceToPayload(o.value)
      if (payload) expect(payload).not.toHaveProperty("remind_at")
    }
  })
})

describe("defaultReminderChoice（フォームの既定値）", () => {
  it("未設定（null）は「なし」", () => {
    expect(defaultReminderChoice(null)).toBe("none")
  })

  it("undefined でも「なし」（prefs の行が無い経路）", () => {
    expect(defaultReminderChoice(undefined)).toBe("none")
  })

  it.each([
    [10, "m10"],
    [30, "m30"],
    [60, "m60"],
  ])("%i 分は %s", (minutes, expected) => {
    expect(defaultReminderChoice(minutes)).toBe(expected)
  })

  it("提示していない分数（15）は「なし」へ倒す — B-5 は EVENT_REMINDER_MINUTES から選ばせること", () => {
    expect(defaultReminderChoice(15)).toBe("none")
  })

  it("EVENT_REMINDER_MINUTES の全要素が選択肢として解決できる（B-5 との契約）", () => {
    for (const m of EVENT_REMINDER_MINUTES) {
      expect(minutesToChoice(m)).not.toBeNull()
    }
  })
})

describe("reminderRowToState（未知値を「なし」と偽らぬ）", () => {
  it("行が無ければ ready + none", () => {
    expect(reminderRowToState(null)).toEqual({ status: "ready", choice: "none" })
  })

  it("minutes/30 は ready + m30", () => {
    expect(
      reminderRowToState({ remind_kind: "minutes", remind_minutes_before: 30 }),
    ).toEqual({ status: "ready", choice: "m30" })
  })

  it("prev_day_20 は ready + prev_day_20", () => {
    expect(
      reminderRowToState({ remind_kind: "prev_day_20", remind_minutes_before: null }),
    ).toEqual({ status: "ready", choice: "prev_day_20" })
  })

  it("未知の remind_kind は unsupported（「なし」に丸めると設定済みの通知を黙って消す）", () => {
    expect(
      reminderRowToState({ remind_kind: "on_arrival", remind_minutes_before: null }),
    ).toEqual({ status: "unsupported" })
  })

  it("minutes でも提示外の分数（15）は unsupported", () => {
    expect(
      reminderRowToState({ remind_kind: "minutes", remind_minutes_before: 15 }),
    ).toEqual({ status: "unsupported" })
  })
})

describe("isReminderChoice（Server Action の入力検証）", () => {
  it.each(REMINDER_OPTIONS.map((o) => o.value))("%s は受け入れる", (v) => {
    expect(isReminderChoice(v)).toBe(true)
  })

  it.each([["m15"], ["minutes"], [""], ["__proto__"]])(
    "%s は拒む",
    (v) => {
      expect(isReminderChoice(v)).toBe(false)
    },
  )

  it("文字列以外は拒む", () => {
    expect(isReminderChoice(30)).toBe(false)
    expect(isReminderChoice(null)).toBe(false)
    expect(isReminderChoice({ value: "m30" })).toBe(false)
  })
})

describe("formatRemindAtLabel", () => {
  it("JST の日付と時刻で出す（UTC の日にちを使うと 9 時間ずれる）", () => {
    expect(formatRemindAtLabel("2026-08-14T14:30:00.000Z")).toBe("8月14日 23:30")
  })

  it("JST 深夜 0 時を「24:00」と出さぬ（h23 固定・既知の ICU 罠）", () => {
    // 2026-08-14T15:00:00Z = 8/15 00:00 JST
    expect(formatRemindAtLabel("2026-08-14T15:00:00.000Z")).toBe("8月15日 00:00")
  })

  it("不正な ISO は null（画面を倒さぬ）", () => {
    expect(formatRemindAtLabel("not-a-date")).toBeNull()
  })
})

/**
 * 宛先の決定規則。単発と繰り返しは `handleSubmit` の別々の分岐に居るが、
 * **同じこの 1 関数**を呼ぶ。base-ui の Select は jsdom で `fireEvent` から選択できぬ
 * （option は描画されるが `onValueChange` が発火せぬ。実測）ため繰り返し経路を UI から
 * 駆動できず、規則の網羅はここが担う。
 */
describe("reminderTargetFromCreateResult（通知の宛先）", () => {
  it("単発は eventId を宛先にする", () => {
    expect(reminderTargetFromCreateResult({ error: null, eventId: "ev-1" })).toEqual({
      eventId: "ev-1",
    })
  })

  it("繰り返しは seriesId を宛先にする（400 件の UUID を URL に載せぬため）", () => {
    expect(
      reminderTargetFromCreateResult({ error: null, seriesId: "ser-1" }),
    ).toEqual({ seriesId: "ser-1" })
  })

  it("作成が失敗したら宛先なし（宛先の無い通知を作らぬ）", () => {
    expect(
      reminderTargetFromCreateResult({ error: "失敗", eventId: "ev-1" }),
    ).toBeNull()
  })

  it("id が返らねば宛先なし（黙って別の予定へ付けぬ）", () => {
    expect(reminderTargetFromCreateResult({ error: null })).toBeNull()
  })

  it("空文字の id は宛先なし扱い", () => {
    expect(
      reminderTargetFromCreateResult({ error: null, eventId: "", seriesId: "" }),
    ).toBeNull()
  })

  it("両方あれば単発を優先する（起こらぬが決定的にしておく）", () => {
    expect(
      reminderTargetFromCreateResult({
        error: null,
        eventId: "ev-1",
        seriesId: "ser-1",
      }),
    ).toEqual({ eventId: "ev-1" })
  })
})
