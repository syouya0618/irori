import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * 家事機能 A「ごみと予定の区別・前日通知」の E2E（V-A）。
 *
 * - 同じ日の通常の予定とごみの予定の識別（月のマスの読み上げ・一覧の行）
 * - 分類の保存 → 再読込 → 解除（ごみの画面から）
 * - 繰り返しのシリーズ既定と、この回だけ通常へ戻す例外
 * - 前日 20:00 JST の通知が既存の event_reminders に 1 件だけ入ること
 * - R35 遅れて届いた保存の応答が、後から開いた別の回のシートを閉じず、選んだ内容を消さぬこと
 *
 * 一覧への反映は楽観更新と取り直しに依るゆえ、DB の断面を poll してから reload して
 * SSR の断面を assert する（calendar.spec.ts と同じフレーク対策）。
 */

test.setTimeout(180_000)

/** 44px（DESIGN_SYSTEM.md の値）。フォームの中の押下対象を実測する。 */
const MIN_TOUCH_PX = 44

function todayJst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

async function loginAndOpenCalendar(page: Page, email: string): Promise<void> {
  await loginViaMagicLink(page, email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E ごみ世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  await page.getByRole("link", { name: "予定" }).click()
  await expect(page).toHaveURL(/\/calendar/, { timeout: 15_000 })
}

async function reloadHydrated(page: Page): Promise<void> {
  const ws = page.waitForEvent("websocket", { timeout: 20_000 })
  await page.reload()
  await ws
}

/** 退場中のシートが消えるのを待ってから開く（calendar.spec.ts の openOverlay と同じ理由）。 */
async function openOverlay(trigger: Locator, readySignal: Locator): Promise<void> {
  await expect(
    trigger.page().locator('[data-slot="sheet-content"]:not([data-open])'),
  ).toHaveCount(0, { timeout: 10_000 })
  await expect(async () => {
    if (!(await readySignal.isVisible())) {
      await trigger.click({ timeout: 2_000 })
    }
    await expect(readySignal).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

async function householdOf(userId: string): Promise<string> {
  const { data, error } = await adminClient()
    .from("profiles")
    .select("household_id")
    .eq("id", userId)
    .single()
  if (error || !data?.household_id) throw new Error("household not ready")
  return data.household_id as string
}

async function waitForEventCount(userId: string, title: string, expected: number): Promise<void> {
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("calendar_events")
      .select("id")
      .eq("household_id", await householdOf(userId))
      .eq("title", title)
    if (error) throw new Error(`calendar lookup failed: ${error.message}`)
    expect(data?.length ?? 0).toBe(expected)
  }).toPass({ timeout: 15_000 })
}

/** 世帯の分類（event_purposes）が期待の姿になるまで待つ。 */
async function waitForPurposes(
  userId: string,
  expected: { scope: string; purpose: string | null; garbage_kind: string | null; remind_default: string | null }[],
): Promise<void> {
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("event_purposes")
      .select("scope, purpose, garbage_kind, remind_default")
      .eq("household_id", await householdOf(userId))
      .order("scope")
    if (error) throw new Error(`purpose lookup failed: ${error.message}`)
    expect(data ?? []).toEqual(expected)
  }).toPass({ timeout: 15_000 })
}

/** 世帯の通知設定（event_reminders）の種別と通知時刻。 */
async function waitForReminders(
  userId: string,
  expected: { remind_kind: string; remind_at: string }[],
): Promise<void> {
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("event_reminders")
      .select("remind_kind, remind_at")
      .eq("household_id", await householdOf(userId))
      .order("remind_at")
    if (error) throw new Error(`reminder lookup failed: ${error.message}`)
    expect(
      (data ?? []).map((r) => ({
        remind_kind: r.remind_kind,
        remind_at: new Date(r.remind_at as string).toISOString(),
      })),
    ).toEqual(expected)
  }).toPass({ timeout: 15_000 })
}

/** その日の前日 20:00 JST（= 11:00 UTC）。 */
function prevDay20Jst(ymd: string): string {
  return new Date(`${shiftYmd(ymd, -1)}T20:00:00+09:00`).toISOString()
}

async function addAllDayEvent(page: Page, title: string): Promise<void> {
  const addSheet = page.getByRole("heading", { name: "予定を追加" })
  await openOverlay(page.getByRole("button", { name: /^\d+月\d+日（.）に予定を追加$/ }), addSheet)
  await page.getByLabel("タイトル").fill(title)
  await page.getByRole("button", { name: "追加", exact: true }).click()
}

const dayCell = (page: Page, ymd: string) => page.locator(`button[data-date="${ymd}"]`)
const agenda = (page: Page) => page.getByRole("region", { name: /の予定$/ })

test("ごみの日: 同じ日の予定と区別でき、分類 → 再読込 → 解除ができる", async ({ page, approvedUser }) => {
  const today = todayJst()
  await loginAndOpenCalendar(page, approvedUser.email)

  // 1. 同じ日（今日）に、ごみにする予定と通常の予定を作る
  await addAllDayEvent(page, "収集の日")
  await waitForEventCount(approvedUser.id, "収集の日", 1)
  await addAllDayEvent(page, "歯医者")
  await waitForEventCount(approvedUser.id, "歯医者", 1)
  await reloadHydrated(page)

  // 題からは自動で分類せぬ: まだどちらも通常の予定
  await expect(dayCell(page, today)).toHaveAttribute("aria-label", /、予定2件$/)
  await waitForPurposes(approvedUser.id, [])

  // 2. 予定を開き、ごみの日にする（通知の初期選択は前日 20:00）
  await openOverlay(agenda(page).getByText("収集の日"), page.getByRole("heading", { name: "予定を編集" }))
  const field = page.getByTestId("garbage-purpose-field")
  await expect(field).toContainText("ごみの日ではありません。")
  await field.getByRole("button", { name: "ごみの日にする" }).click()
  await expect(field.getByRole("button", { name: "前日 20:00 に通知する" })).toHaveAttribute("aria-pressed", "true")
  await field.getByRole("button", { name: "燃えるごみ", exact: true }).click()

  // フォームの中の押下対象は 44px 以上（片手操作の実寸で測る）
  await page.setViewportSize({ width: 390, height: 844 })
  for (const button of await field.getByRole("button").all()) {
    const box = await button.boundingBox()
    if (!box) continue
    expect(box.height, await button.innerText()).toBeGreaterThanOrEqual(MIN_TOUCH_PX)
    expect(box.width, await button.innerText()).toBeGreaterThanOrEqual(MIN_TOUCH_PX)
  }

  await field.getByRole("button", { name: "分類を保存" }).click()

  // 3. DB: 分類は event の 1 行。通知は既存の event_reminders に前日 20:00 JST が 1 件だけ
  await waitForPurposes(approvedUser.id, [
    { scope: "event", purpose: "garbage", garbage_kind: "燃えるごみ", remind_default: null },
  ])
  await waitForReminders(approvedUser.id, [{ remind_kind: "prev_day_20", remind_at: prevDay20Jst(today) }])
  await expect(field).toContainText("ごみ・燃えるごみ")

  // 4. 再読込（SSR）: 月のマスの読み上げと一覧の行で、ごみと通常の予定を区別できる
  await reloadHydrated(page)
  await expect(dayCell(page, today)).toHaveAttribute("aria-label", /、予定2件、ごみ（燃えるごみ）$/)
  await expect(dayCell(page, today).locator("[data-garbage-mark]")).toContainText("燃える")
  const garbageRow = agenda(page).getByRole("button", { name: /収集の日/ })
  const normalRow = agenda(page).getByRole("button", { name: /歯医者/ })
  await expect(garbageRow).toContainText("ごみ・燃えるごみ")
  await expect(normalRow).not.toContainText("ごみ")

  // 5. 育児ホームの「今日・明日の予定」でも区別できる
  await page.goto("/baby")
  const upcoming = page.getByRole("link", { name: "今日・明日の予定（カレンダーを開く）" })
  await expect(upcoming.locator("li", { hasText: "収集の日" })).toContainText("ごみ・燃えるごみ")
  await expect(upcoming.locator("li", { hasText: "歯医者" })).not.toContainText("ごみ")

  // 6. ごみの画面: 次の収集日に名称・日付・通知の有無が出る
  await page.goto("/chores/garbage")
  const collections = page.getByTestId("garbage-collections")
  await expect(collections).toContainText("燃えるごみ")
  await expect(collections).toContainText("（今日）")
  // 今日の予定の前日 20:00 は昨日 = もう過ぎておる。設定の行は在る（上の waitForReminders）が、
  // 「通知します」とは言わず、これからは届かぬことを言う
  await expect(collections).toContainText("前日 20:00 は過ぎています（この回の通知は、これからは届きません）")
  await expect(collections).not.toContainText("前日 20:00 に通知")

  // 7. 解除（通知設定は変えない）
  await page.getByRole("button", { name: "燃えるごみ（この回だけ）を解除" }).click()
  const form = page.getByTestId("garbage-purpose-form")
  await expect(form.getByRole("button", { name: "分類を解除する" })).toHaveAttribute("aria-pressed", "true")
  await expect(form.getByRole("button", { name: "通知設定は変えない" })).toHaveAttribute("aria-pressed", "true")
  // 名前の一致は既定で部分一致。「分類を解除する」（操作の選択）と紛れぬよう完全一致で引く
  await form.getByRole("button", { name: "解除する", exact: true }).click()
  await waitForPurposes(approvedUser.id, [])
  // 「通知設定は変えない」ゆえ通知は残る（予定の通知の欄から変えられる）
  await waitForReminders(approvedUser.id, [{ remind_kind: "prev_day_20", remind_at: prevDay20Jst(today) }])

  // 8. 再読込: 未登録の案内と、予定の作成（カレンダー）への導線
  await page.reload()
  await expect(page.getByText("ごみの日はまだ登録されていません")).toBeVisible({ timeout: 15_000 })
  await page.getByRole("link", { name: "カレンダーで予定を作る" }).click()
  await expect(page).toHaveURL(/\/calendar/, { timeout: 15_000 })
  await expect(dayCell(page, today)).toHaveAttribute("aria-label", /、予定2件$/)
})

test("既存のGoogle同期済みごみ予定: シリーズ分類が保存直後・家事・再読込へ反映し、通知は変えない", async ({ page, approvedUser }) => {
  const today = todayJst()
  const next = shiftYmd(today, 7)
  await loginAndOpenCalendar(page, approvedUser.email)
  const householdId = await householdOf(approvedUser.id)
  const googleCalendarId = "existing-garbage@example.invalid"
  const recurringEventId = `existing-${crypto.randomUUID()}`
  const events = [
    { id: crypto.randomUUID(), household_id: householdId, title: "既存の燃えるごみ", source: "google",
      is_all_day: true, start_date: today, end_date: today,
      google_calendar_id: googleCalendarId, google_event_id: `occ-a-${crypto.randomUUID()}`, recurring_event_id: recurringEventId },
    { id: crypto.randomUUID(), household_id: householdId, title: "既存の燃えるごみ", source: "google",
      is_all_day: true, start_date: next, end_date: next,
      google_calendar_id: googleCalendarId, google_event_id: `occ-b-${crypto.randomUUID()}`, recurring_event_id: recurringEventId },
  ]
  const { error: seedError } = await adminClient().from("calendar_events").insert(events)
  expect(seedError, "existing Google events seed").toBeNull()
  await reloadHydrated(page)

  await openOverlay(agenda(page).getByText("既存の燃えるごみ").first(), page.getByRole("heading", { name: "予定の詳細" }))
  const field = page.getByTestId("garbage-purpose-field")
  await expect(field).toContainText("ごみの日ではありません。")
  await field.getByRole("button", { name: "ごみの日にする" }).click()
  await field.getByRole("button", { name: "シリーズ全体" }).click()
  await field.getByRole("button", { name: "燃えるごみ", exact: true }).click()
  await field.getByRole("button", { name: "通知設定は変えない" }).click()
  await field.getByRole("button", { name: "分類を保存" }).click()

  await waitForPurposes(approvedUser.id, [
    { scope: "series", purpose: "garbage", garbage_kind: "燃えるごみ", remind_default: "none" },
  ])
  await waitForReminders(approvedUser.id, [])
  await expect(field).toContainText("繰り返しのすべての回に付けた分類です。")
  await page.goto("/chores/garbage")
  const collections = page.getByTestId("garbage-collections")
  await expect(collections.getByRole("listitem")).toHaveCount(2)
  await expect(collections).toContainText("燃えるごみ")
  await page.reload()
  await expect(page.getByTestId("garbage-collections").getByRole("listitem")).toHaveCount(2)
  await page.goto("/calendar")
  await expect(dayCell(page, today)).toHaveAttribute("aria-label", /ごみ（燃えるごみ）$/)
})

test("ごみの日: シリーズ全体の分類と、この回だけ通常へ戻す例外", async ({ page, approvedUser }) => {
  const today = todayJst()
  const second = shiftYmd(today, 7)
  const third = shiftYmd(today, 14)
  await loginAndOpenCalendar(page, approvedUser.email)

  // 1. 毎週 × 3 回の繰り返しを作る
  const addSheet = page.getByRole("heading", { name: "予定を追加" })
  await openOverlay(page.getByRole("button", { name: /^\d+月\d+日（.）に予定を追加$/ }), addSheet)
  await page.getByLabel("タイトル").fill("プラごみ")
  await page.locator("#cal-repeat").click()
  await page.getByRole("option", { name: "毎週" }).click()
  await page.locator("#cal-repeat-until").fill(third)
  await page.getByRole("button", { name: "追加", exact: true }).click()
  await waitForEventCount(approvedUser.id, "プラごみ", 3)
  await reloadHydrated(page)

  // 2. 今日の回を開き、範囲を選ばねば保存できぬことを確かめてから、シリーズ全体をごみにする
  await openOverlay(agenda(page).getByText("プラごみ"), page.getByRole("heading", { name: "予定を編集" }))
  const field = page.getByTestId("garbage-purpose-field")
  await field.getByRole("button", { name: "ごみの日にする" }).click()
  await field.getByRole("button", { name: "プラスチック" }).click()
  await field.getByRole("button", { name: "分類を保存" }).click()
  await expect(field.getByRole("alert")).toContainText("変更する範囲")
  await waitForPurposes(approvedUser.id, [])
  await field.getByRole("button", { name: "シリーズ全体" }).click()
  await field.getByRole("button", { name: "分類を保存" }).click()

  await waitForPurposes(approvedUser.id, [
    { scope: "series", purpose: "garbage", garbage_kind: "プラスチック", remind_default: "prev_day_20" },
  ])
  // 3 回それぞれの前日 20:00 JST に 1 件ずつ
  await waitForReminders(approvedUser.id, [
    { remind_kind: "prev_day_20", remind_at: prevDay20Jst(today) },
    { remind_kind: "prev_day_20", remind_at: prevDay20Jst(second) },
    { remind_kind: "prev_day_20", remind_at: prevDay20Jst(third) },
  ])

  // 3. この回だけ通常の予定に戻す（通知は止める）
  await expect(field).toContainText("繰り返しのすべての回に付けた分類です。")
  await field.getByRole("button", { name: "分類を変更・解除" }).click()
  await field.getByRole("button", { name: "この回だけ", exact: true }).click()
  await field.getByRole("button", { name: "この回だけ通常の予定に戻す", exact: true }).click()
  await expect(field.getByRole("button", { name: "通知を止める" })).toHaveAttribute("aria-pressed", "true")
  // 「この回だけ通常の予定に戻す」（操作の選択）と紛れぬよう完全一致で引く
  await field.getByRole("button", { name: "通常の予定に戻す", exact: true }).click()

  await waitForPurposes(approvedUser.id, [
    { scope: "event", purpose: "normal", garbage_kind: null, remind_default: null },
    { scope: "series", purpose: "garbage", garbage_kind: "プラスチック", remind_default: "prev_day_20" },
  ])
  // 今日の回の通知だけが消える
  await waitForReminders(approvedUser.id, [
    { remind_kind: "prev_day_20", remind_at: prevDay20Jst(second) },
    { remind_kind: "prev_day_20", remind_at: prevDay20Jst(third) },
  ])

  // 4. ごみの画面: 次の収集日は 2 回目から。例外は一覧に出て取り消せる
  await page.goto("/chores/garbage")
  const collections = page.getByTestId("garbage-collections")
  await expect(collections.getByRole("listitem")).toHaveCount(2)
  await expect(collections).not.toContainText("（今日）")
  const entries = page.getByTestId("garbage-entries")
  await expect(entries).toContainText("プラスチック")
  await expect(entries).toContainText("この回だけ通常の予定に戻しています")
  await expect(entries).toContainText("これから追加される回にも、前日 20:00 の通知を付けます")
})

test("ごみの日 R35: 遅れて届いた分類の保存の応答は、後から開いた別の回のシートを閉じず、選んだ内容を消さない", async ({
  page,
  approvedUser,
}) => {
  const today = todayJst()
  await loginAndOpenCalendar(page, approvedUser.email)
  const householdId = await householdOf(approvedUser.id)
  const admin = adminClient()
  const burnable = crypto.randomUUID()
  const resource = crypto.randomUUID()
  {
    // 分類済みの 2 つの回（明日・明後日）を用意する（画面の操作で作る経路は上のテストが通しておる）
    const { error: eErr } = await admin.from("calendar_events").insert([
      { id: burnable, household_id: householdId, title: "可燃の回収", is_all_day: true, start_date: shiftYmd(today, 1), end_date: shiftYmd(today, 1), source: "native" },
      { id: resource, household_id: householdId, title: "資源の回収", is_all_day: true, start_date: shiftYmd(today, 2), end_date: shiftYmd(today, 2), source: "native" },
    ])
    expect(eErr, "予定の seed 失敗").toBeNull()
    const { error: pErr } = await admin.from("event_purposes").insert([
      { household_id: householdId, scope: "event", target_key: burnable, purpose: "garbage", garbage_kind: "燃えるごみ" },
      { household_id: householdId, scope: "event", target_key: resource, purpose: "garbage", garbage_kind: "資源" },
    ])
    expect(pErr, "分類の seed 失敗").toBeNull()
  }
  await page.goto("/chores/garbage")
  const collections = page.getByTestId("garbage-collections")
  await expect(collections.getByRole("listitem")).toHaveCount(2, { timeout: 15_000 })

  // 1. 明日の回の分類を「びん・缶」へ変えて保存。応答だけを止める（サーバーには届いて保存される）
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false
  await page.route("**/chores/garbage", async (route) => {
    const request = route.request()
    // 分類の保存（Server Action の POST）だけを 1 回止める。ほかの Server Action は止めぬ
    if (
      !held &&
      request.method() === "POST" &&
      request.headers()["next-action"] &&
      (request.postData() ?? "").includes('"op":"save"')
    ) {
      held = true
      const response = await route.fetch()
      await gate
      await route.fulfill({ response })
      return
    }
    await route.fallback()
  })
  const form = page.getByTestId("garbage-purpose-form")
  await openOverlay(collections.getByRole("button", { name: /の燃えるごみを変更$/ }), form)
  await form.getByRole("button", { name: "びん・缶", exact: true }).click()
  await form.getByRole("button", { name: "分類を保存" }).click()
  await expect.poll(() => held, { timeout: 15_000 }).toBe(true)

  // 2. 応答を待つ間にシートを閉じ、明後日の回の変更を開いて「古紙」を選び始める
  await form.getByRole("button", { name: "やめる" }).click()
  await expect(form).toHaveCount(0)
  await openOverlay(collections.getByRole("button", { name: /の資源を変更$/ }), form)
  await form.getByRole("button", { name: "古紙", exact: true }).click()

  // 3. 先の応答を渡す。開いておるシートは閉じず、選んだ内容も残る。先の結果はシートに出さぬ
  release()
  await expect(form.getByRole("button", { name: "分類を保存" })).toBeEnabled({ timeout: 15_000 })
  await expect(form).toBeVisible()
  await expect(form.getByRole("button", { name: "古紙", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("dialog").getByText("保存しました。")).toHaveCount(0)
  await page.unroute("**/chores/garbage")

  // 4. このシートの保存は、このシートを閉じる。DB と再読込（SSR）で両方の分類を確かめる
  await form.getByRole("button", { name: "分類を保存" }).click()
  await expect(form).toHaveCount(0, { timeout: 15_000 })
  await expect(async () => {
    const { data, error } = await admin
      .from("event_purposes")
      .select("target_key, garbage_kind")
      .eq("household_id", householdId)
    if (error) throw new Error(`purpose lookup failed: ${error.message}`)
    const byEvent = Object.fromEntries((data ?? []).map((row) => [row.target_key, row.garbage_kind]))
    expect(byEvent).toEqual({ [burnable]: "びん・缶", [resource]: "古紙" })
  }).toPass({ timeout: 15_000 })
  await page.reload()
  await expect(collections).toContainText("びん・缶", { timeout: 15_000 })
  await expect(collections).toContainText("古紙")
  await expect(collections).not.toContainText("燃えるごみ")
})

test("ごみの日: 別の世帯の分類は見えぬ（RLS 回帰ガード）", async ({ page, approvedUser }) => {
  const today = todayJst()
  const admin = adminClient()
  const otherHouseholdId = crypto.randomUUID()
  const otherEventId = crypto.randomUUID()
  {
    const { error: hErr } = await admin.from("households").insert({ id: otherHouseholdId, name: "他世帯" })
    expect(hErr, "他世帯 seed 失敗").toBeNull()
    const { error: eErr } = await admin.from("calendar_events").insert({
      id: otherEventId,
      household_id: otherHouseholdId,
      title: "他世帯の収集日",
      is_all_day: true,
      start_date: today,
      end_date: today,
      source: "native",
    })
    expect(eErr, "他世帯の予定 seed 失敗").toBeNull()
    const { error: pErr } = await admin.from("event_purposes").insert({
      household_id: otherHouseholdId,
      scope: "event",
      target_key: otherEventId,
      purpose: "garbage",
      garbage_kind: "他世帯のごみ",
    })
    expect(pErr, "他世帯の分類 seed 失敗").toBeNull()
  }
  try {
    await loginAndOpenCalendar(page, approvedUser.email)
    await page.goto("/chores/garbage")
    await expect(page.getByText("ごみの日はまだ登録されていません")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("他世帯のごみ")).toHaveCount(0)
  } finally {
    // households の CASCADE で予定と分類も消える
    await admin.from("households").delete().eq("id", otherHouseholdId)
  }
})
