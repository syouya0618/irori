/**
 * 毎朝ダイジェスト（B-5）を配信ジョブ 1 周の**結果**で固定する。
 *
 * ## このテストの眼目 —— 「窓一致でない」ことの証明
 * 「`digest_time` が今の 5 分窓に入る利用者」で展開する実装は、**cron が 1 回
 * 落ちたその日のまとめを永久に失う**。それを検出できるのは
 * 「**行が先に立っておること**」を見る assert だけじゃ:
 *
 *   * tick 1（JST 0 時過ぎ）… 行が在る・まだ 1 通も送っておらぬ
 *   * tick 2（07:05。07:00 の実行は**丸ごと落とす**）… 送られる
 *
 * 1 回の tick（07:05）だけを撃つ形では、窓一致に grace を足した実装でも緑に
 * なってしまう。ゆえに**必ず 2 tick で書く**。
 *
 * fake は実データを保持してフィルタを評価するゆえ、ここで見ておるのは
 * 「この列で eq しておるか」という形ではなく「行が 2 本できたか」「他世帯が
 * 混ざったか」という結果じゃ。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { deliverDueNotifications } from "../deliver"
import type { PushSendResult, PushTarget, VapidConfig } from "../send-push"
import {
  createFakeNotifySupabase,
  emptyNotifyDb,
  type FakeNotifyDb,
} from "./fake-notify-db"

const H1 = "11111111-1111-1111-1111-111111111111"
const H2 = "33333333-3333-3333-3333-333333333333"
const U1 = "22222222-2222-2222-2222-222222222222"
const U2 = "88888888-8888-8888-8888-888888888888"
const U3 = "44444444-4444-4444-4444-444444444444"

/** まとめの対象日（JST 暦日）。 */
const DAY = "2026-08-10"
/** JST 00:05 = UTC 前日 15:05。**その日の最初の実行**。 */
const TICK_MIDNIGHT = "2026-08-09T15:05:00.000Z"
/** JST 07:00 = UTC 前日 22:00。まとめが鳴るべき瞬間。 */
const DIGEST_AT = "2026-08-09T22:00:00.000Z"
/** JST 07:05。**07:00 の実行が落ちた**あとの次の実行。 */
const TICK_LATE = "2026-08-09T22:05:00.000Z"

const VAPID: VapidConfig = {
  publicKey: "pub",
  privateKey: "priv",
  subject: "mailto:a@example.com",
}

interface SentRecord {
  target: PushTarget
  payload: unknown
}

/**
 * 夫婦 2 人（U1・U2）と別世帯（U3）。
 *
 * ⚠️ **2 人以上 seed する**のが要点じゃ。1 人だと「世帯に開いたつもりが自分のみ」
 * や「1 通しか作らぬ」といった縮退を永久に見逃す。
 */
function seed(): FakeNotifyDb {
  const db = emptyNotifyDb()
  db.profiles.push(
    { id: U1, household_id: H1 },
    { id: U2, household_id: H1 },
    { id: U3, household_id: H2 },
  )
  db.push_subscriptions.push(
    {
      id: "sub-u1",
      user_id: U1,
      endpoint: "https://fcm.googleapis.com/u1",
      p256dh: "k1",
      auth: "a1",
      failure_count: 0,
      last_success_at: null,
      last_failure_at: null,
    },
    {
      id: "sub-u2",
      user_id: U2,
      endpoint: "https://fcm.googleapis.com/u2",
      p256dh: "k2",
      auth: "a2",
      failure_count: 0,
      last_success_at: null,
      last_failure_at: null,
    },
  )
  // U1 だけが毎朝 07:00 のまとめを受け取る（TIME ゆえ DB は秒つきで返す）。
  db.notification_preferences.push(
    { user_id: U1, digest_time: "07:00:00", event_default_minutes: null },
    { user_id: U2, digest_time: null, event_default_minutes: 30 },
  )
  db.calendar_events.push(
    {
      household_id: H1,
      event_uid: "e1",
      title: "歯医者",
      memo: "銀歯のやり直し",
      is_all_day: false,
      start_date: DAY,
      end_date: DAY,
      start_at: "2026-08-10T01:00:00.000Z", // 10:00 JST
    },
    {
      household_id: H1,
      event_uid: "e2",
      title: "買い物",
      memo: null,
      is_all_day: false,
      start_date: DAY,
      end_date: DAY,
      start_at: "2026-08-10T05:00:00.000Z", // 14:00 JST
    },
  )
  return db
}

function tick(
  db: FakeNotifyDb,
  nowIso: string,
  options: { sent?: SentRecord[]; result?: PushSendResult } = {},
) {
  const fake = createFakeNotifySupabase(db)
  const sendPush = vi.fn(
    async (target: PushTarget, _vapid: VapidConfig, payload: unknown) => {
      options.sent?.push({ target, payload })
      return options.result ?? { ok: true as const }
    },
  )
  return {
    fake,
    promise: deliverDueNotifications(fake.client, {
      now: () => new Date(nowIso),
      readVapid: () => VAPID,
      sendPush,
    }),
  }
}

const digestRows = (db: FakeNotifyDb) =>
  db.notification_deliveries.filter((row) => row.kind === "digest")

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("展開 — その日ぶんの行を先に立てる（窓一致でない）", () => {
  it("JST 0 時過ぎの実行が行を 1 本立て、**まだ送らぬ**", async () => {
    const db = seed()
    const sent: SentRecord[] = []
    const result = await tick(db, TICK_MIDNIGHT, { sent }).promise

    expect(sent).toHaveLength(0)
    expect(result.sent).toBe(0)

    const rows = digestRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      household_id: H1,
      kind: "digest",
      // ダイジェストは予定 1 件に紐づかぬ。**この NULL 同士が衝突する**ことが
      // 1 日 1 通を成り立たせておる（UNIQUE NULLS NOT DISTINCT）。
      event_key: null,
      subscription_key: "sub-u1",
      sent_at: null,
      skipped_at: null,
    })
  })

  it("**JST で立てる**（UTC で組めば 9 時間ずれる）", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise

    const row = digestRows(db)[0]
    // 07:00 JST = 前日 22:00 UTC。素朴に UTC で組めば 2026-08-09T07:00Z になる。
    expect(row.scheduled_at).toBe(DIGEST_AT)
    // dedupe_day が 1 日ずれると冪等キーが割れ、同じまとめが 2 回鳴る。
    expect(row.dedupe_day).toBe(DAY)
  })

  it("同じ日に何度実行しても行は 1 本（重複排除）", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise
    await tick(db, "2026-08-09T16:05:00.000Z").promise
    await tick(db, "2026-08-09T17:05:00.000Z").promise

    expect(digestRows(db)).toHaveLength(1)
  })

  it("予定が 0 件の日は行を作らぬ（中身の無い通知を出さぬ）", async () => {
    const db = seed()
    db.calendar_events.length = 0
    const sent: SentRecord[] = []
    await tick(db, TICK_MIDNIGHT, { sent }).promise

    expect(digestRows(db)).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it("他世帯の予定を自世帯の「今日の予定」と数えぬ", async () => {
    const db = seed()
    // 自世帯は 0 件、別世帯には 2 件。世帯スコープが抜けておれば行が立つ。
    for (const event of db.calendar_events) event.household_id = H2

    await tick(db, TICK_MIDNIGHT).promise
    expect(digestRows(db)).toHaveLength(0)
  })

  it("まとめを有効にしておるのは 1 人ゆえ、行も 1 本（購読の数だけ配らぬ）", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise

    const rows = digestRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].subscription_key).toBe("sub-u1")
  })

  it("夫婦がそれぞれの時刻を選べば、行はそれぞれの瞬間を指す", async () => {
    const db = seed()
    db.notification_preferences[1].digest_time = "08:00:00"
    await tick(db, TICK_MIDNIGHT).promise

    const rows = digestRows(db).sort((a, b) =>
      String(a.subscription_key).localeCompare(String(b.subscription_key)),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      subscription_key: "sub-u1",
      scheduled_at: DIGEST_AT,
      dedupe_day: DAY,
    })
    expect(rows[1]).toMatchObject({
      subscription_key: "sub-u2",
      scheduled_at: "2026-08-09T23:00:00.000Z", // 08:00 JST
      dedupe_day: DAY,
    })
  })
})

describe("catch-up — cron を 1 回落としても届く", () => {
  it("**07:00 の実行が丸ごと落ちても、07:05 の実行が届ける**", async () => {
    const db = seed()

    // tick 1: JST 0 時過ぎ。行だけが立ち、まだ送らぬ。
    const first: SentRecord[] = []
    await tick(db, TICK_MIDNIGHT, { sent: first }).promise
    expect(first).toHaveLength(0)
    expect(digestRows(db)).toHaveLength(1)

    // ── ここで 07:00 の実行は**落ちる**（tick を撃たぬ）──

    // tick 2: 07:05。窓一致の実装ならここで何も起きぬ。
    const second: SentRecord[] = []
    const result = await tick(db, TICK_LATE, { sent: second }).promise

    expect(second).toHaveLength(1)
    expect(result.sent).toBe(1)
    expect(second[0].target.endpoint).toBe("https://fcm.googleapis.com/u1")
    expect(second[0].payload).toMatchObject({
      title: "今日の予定 2件",
      body: "歯医者 10:00 / 買い物 14:00",
      tag: `digest:${DAY}`,
    })
    expect(digestRows(db)[0].sent_at).toBe(TICK_LATE)
  })

  it("送った後にもう一度走らせても、二度は鳴らぬ", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise
    await tick(db, TICK_LATE).promise

    const again: SentRecord[] = []
    await tick(db, "2026-08-09T22:10:00.000Z", { sent: again }).promise

    expect(again).toHaveLength(0)
    expect(digestRows(db)).toHaveLength(1)
  })

  it("cron が止まったまま grace を過ぎたら、送らずに畳む", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise

    const sent: SentRecord[] = []
    // 07:16（grace = 15 分）。遅れて鳴るまとめは害にしかならぬ。
    await tick(db, "2026-08-09T22:16:00.000Z", { sent }).promise

    expect(sent).toHaveLength(0)
    expect(digestRows(db)[0]).toMatchObject({
      sent_at: null,
      skip_reason: "expired",
    })
  })

  it("復帰が grace を過ぎておれば、行すら作らぬ（作れば即 expired ゆえ）", async () => {
    const db = seed()
    // その日の実行が 1 度も無いまま 07:30 に復帰した。
    await tick(db, "2026-08-09T22:30:00.000Z").promise

    expect(digestRows(db)).toHaveLength(0)
  })
})

describe("設定の変更に追随する", () => {
  it("行を立てた後に「送らない」へ戻したら、送らず畳む", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise
    db.notification_preferences[0].digest_time = null

    const sent: SentRecord[] = []
    await tick(db, TICK_LATE, { sent }).promise

    expect(sent).toHaveLength(0)
    expect(digestRows(db)[0]).toMatchObject({
      sent_at: null,
      skip_reason: "rescheduled",
    })
  })

  it("**時刻を後ろへ動かした日も、その日のまとめは失われぬ**（行は付け替わる）", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise
    // 主が 07:00 → 08:00 へ変えた。
    db.notification_preferences[0].digest_time = "08:00:00"

    // 07:05 では鳴らぬ（古い時刻で鳴らせば嘘になる）。
    const early: SentRecord[] = []
    await tick(db, TICK_LATE, { sent: early }).promise
    expect(early).toHaveLength(0)
    expect(digestRows(db)).toHaveLength(1)
    expect(digestRows(db)[0].scheduled_at).toBe("2026-08-09T23:00:00.000Z")

    // 08:05 に届く。行を作り直しておれば冪等キーが同じゆえ
    // `DO NOTHING` に吸われ、この 1 通は永久に来ぬ。
    const late: SentRecord[] = []
    await tick(db, "2026-08-09T23:05:00.000Z", { sent: late }).promise
    expect(late).toHaveLength(1)
    expect(digestRows(db)).toHaveLength(1)
  })

  /**
   * ⚠️ **上の「後ろへ動かす」と対で置いてある。片方だけにするな。**
   *
   * 前方向（早める）は後ろ方向と**機構が別物**じゃ。裁定は
   * `scheduled_at <= now` で行を拾うゆえ、狙いが古い（遅い）ままだと新しい時刻が
   * 来ても行は裁定の視界に入らぬ —— 旧い時刻が来てから過去へ付け替え、次の実行の
   * 期限切れ掃除が `expired` にする ＝ **その日のまとめが 1 通も来ぬ**。しかも
   * 冪等キーが終端行に取られておるゆえ、同じ日に何度設定し直しても戻らぬ。
   * 30 分刻みの選択肢では前方向の変更は必ず 30 分以上過去へ落ちる ＝ 例外ではなく
   * 既定の挙動じゃった。
   *
   * ⚠️ **救えるのは「新しい時刻がまだ来ておらぬ」場合だけじゃ。** 既に過ぎた
   * （grace より深く過去の）時刻へ早めた日は、下の対照テストのとおり**届かぬ**
   * —— それは主が承知のうえで採った fail-closed で、直すべき穴ではない。
   * 名前を「早めた日は失われぬ」と広く書くと、その承知が消える。
   */
  it("**まだ来ておらぬ時刻へ早めた日は、その日のまとめは失われぬ**（前方向の対照）", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise
    // 主が朝 05:00 に「07:00 は遅い、06:30 にしよう」と変えた。
    db.notification_preferences[0].digest_time = "06:30:00"

    // JST 05:05。新しい時刻はまだ来ておらぬが、狙いは**この時点で**付け替わる
    // （来てから付け替えるのでは、もう間に合わぬ）。
    const before: SentRecord[] = []
    await tick(db, "2026-08-09T20:05:00.000Z", { sent: before }).promise
    expect(before).toHaveLength(0)
    expect(digestRows(db)).toHaveLength(1)
    expect(digestRows(db)[0].scheduled_at).toBe("2026-08-09T21:30:00.000Z")

    // 06:30 に届く。狙いが 07:00 のまま眠っておれば、ここは 0 通じゃ。
    const at: SentRecord[] = []
    await tick(db, "2026-08-09T21:30:00.000Z", { sent: at }).promise
    expect(at).toHaveLength(1)
    expect(at[0].payload).toMatchObject({ title: "今日の予定 2件" })
    // **`expired` で終端しておらぬこと**まで見る（穴が開いた時の姿がこれじゃ）。
    expect(digestRows(db)[0]).toMatchObject({
      sent_at: "2026-08-09T21:30:00.000Z",
      skipped_at: null,
      skip_reason: null,
    })
  })

  it("望みの無い時刻へは付け替えぬ（思い直して未来へ戻せば、その日はまだ届く）", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise

    // JST 06:05 に「05:00」（もう過ぎておる）へ変えた。付け替えれば即 expired ゆえ、
    // 行は旧い狙いのまま**生かしておく** —— 殺せば復帰の余地まで失う。
    db.notification_preferences[0].digest_time = "05:00:00"
    await tick(db, "2026-08-09T21:05:00.000Z").promise
    expect(digestRows(db)[0]).toMatchObject({
      scheduled_at: DIGEST_AT,
      skipped_at: null,
    })

    // 思い直して 08:00 へ。行が生きておるゆえ付け替わり、その日のまとめは届く。
    db.notification_preferences[0].digest_time = "08:00:00"
    await tick(db, "2026-08-09T21:10:00.000Z").promise
    const sent: SentRecord[] = []
    await tick(db, "2026-08-09T23:00:00.000Z", { sent }).promise
    expect(sent).toHaveLength(1)
    expect(digestRows(db)).toHaveLength(1)
  })

  /**
   * ★ **既に過ぎた時刻へ早めた日は届かぬ（fail-closed）。主が承知で採った姿じゃ。**
   *
   * ⚠️ **これは「穴」ではなく決定じゃ。** 上の 2 本（後ろへ動かす／まだ来ておらぬ
   * 時刻へ早める）は「失われぬ」を守っておるが、**過ぎた時刻へ早めた日だけは
   * 別物**で、そこを埋めるには「旧い時刻で鳴らす」か「grace を無視して遅れて
   * 鳴らす」しかない —— どちらも主が最も嫌う「頼んでおらぬ時刻に鳴る」じゃ。
   * ゆえに届けぬ側へ倒しておる。
   *
   * ⚠️ **テストが無ければ、この決定は次の改修で無音で反転する。** 展開側の下限
   * （`scheduledMs <= graceStartMs` で aims から落とす）を外せば「過ぎた時刻へ
   * 付け替える」ようになり、旧い時刻を過ぎた行がそのまま送られて**朝 5 時の
   * まとめが 7 時に鳴る**。それを誰も赤で気付けぬ形にせぬために置く。
   *
   * 経路（3 tick 要る。2 tick では `expired` まで届かぬ）:
   *   1. JST 00:05 … 07:00 を狙う行が立つ
   *   2. JST 06:05 … 05:00（もう過ぎた）へ変更 → 望みが無いゆえ**付け替えぬ**
   *   3. JST 07:00 … 旧い狙いで拾われ、裁定が過去（05:00）へ reaim。**送らぬ**
   *   4. JST 07:20 … 期限切れ掃除（`scheduled_at < now - GRACE`）が `expired`
   */
  it("**既に過ぎた時刻へ早めた日は届かぬ**（fail-closed。承知のうえの対照）", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise
    expect(digestRows(db)[0].scheduled_at).toBe(DIGEST_AT)

    // JST 06:05 に「05:00」（15 分の grace より深く過去）へ変えた。
    db.notification_preferences[0].digest_time = "05:00:00"
    const atSix: SentRecord[] = []
    await tick(db, "2026-08-09T21:05:00.000Z", { sent: atSix }).promise
    expect(atSix).toHaveLength(0)
    // 付け替えておらぬ（望みの無い狙いへ動かせば行を殺すだけゆえ）。
    expect(digestRows(db)[0].scheduled_at).toBe(DIGEST_AT)

    // 旧い時刻（07:00）が来ても**鳴らぬ**。裁定が過去へ reaim するだけじゃ。
    const atSeven: SentRecord[] = []
    await tick(db, DIGEST_AT, { sent: atSeven }).promise
    expect(atSeven).toHaveLength(0)
    expect(digestRows(db)[0]).toMatchObject({
      scheduled_at: "2026-08-09T20:00:00.000Z",
      sent_at: null,
      skipped_at: null,
    })

    // 次の実行の期限切れ掃除が畳む。**その日のまとめは 1 通も来ぬ。**
    const after: SentRecord[] = []
    await tick(db, "2026-08-09T22:20:00.000Z", { sent: after }).promise
    expect(after).toHaveLength(0)
    expect(digestRows(db)).toHaveLength(1)
    expect(digestRows(db)[0]).toMatchObject({
      sent_at: null,
      skip_reason: "expired",
    })
  })

  it("行を立てた後に予定が全部消えても畳まぬ（入り直せば届く）", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise
    const removed = db.calendar_events.splice(0, db.calendar_events.length)

    const empty: SentRecord[] = []
    await tick(db, TICK_LATE, { sent: empty }).promise
    expect(empty).toHaveLength(0)
    // **skip にしてはならぬ**。skipped_at が立てば同じ冪等キーの行は二度と作れず、
    // その日のまとめが永久に失われる。
    expect(digestRows(db)[0]).toMatchObject({ sent_at: null, skipped_at: null })

    // grace の内に予定が入り直せば、そのまま届く。
    db.calendar_events.push(removed[0])
    const recovered: SentRecord[] = []
    await tick(db, "2026-08-09T22:10:00.000Z", { sent: recovered }).promise
    expect(recovered).toHaveLength(1)
    expect(recovered[0].payload).toMatchObject({ title: "今日の予定 1件" })
  })
})

describe("ロック画面に機微を出さぬ", () => {
  it("**メモは本文に出ず、問い合わせる列にも入っておらぬ**", async () => {
    const db = seed()
    await tick(db, TICK_MIDNIGHT).promise

    const sent: SentRecord[] = []
    const run = tick(db, TICK_LATE, { sent })
    await run.promise

    // 1. 本文に漏れておらぬ（組み立て側の守り）
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent[0].payload)).not.toContain("銀歯")

    // 2. そもそも取ってきておらぬ（構造の守り）。fake は列を無視して全列返すゆえ、
    //    1 だけでは `select` を広げた変更を捕まえられぬ。
    const digestSelects = run.fake
      .recordsOf("calendar_events", "select")
      .filter(
        (record) =>
          (record.columns ?? "").includes("start_date") &&
          // 予定通知の問い合わせ（EVENT_COLUMNS）と見分ける
          !(record.columns ?? "").includes("event_uid"),
      )
    // 走査が空回りしておらぬこと（正規表現ならぬ条件の書き損じで偽緑にせぬ）
    expect(digestSelects.length).toBeGreaterThan(0)
    for (const record of digestSelects) {
      expect(record.columns).not.toContain("memo")
    }
  })
})
