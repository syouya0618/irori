import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * 共有カレンダー E2E: login → 世帯作成 → /calendar → 予定を作成 → 反映 → 削除。
 * 一覧反映は楽観更新 + Realtime 依存のため、DB 断面を poll してから reload して
 * SSR 断面を assert する(golden-path と同じフレーク対策)。
 */

test.setTimeout(180_000)

/** 「今日」(Asia/Tokyo) の YYYY-MM-DD。playwright.config の timezoneId と一致。 */
function todayJst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

/** YYYY-MM-DD を日数シフト(TZ 非依存)。繰り返し終了日の算出に使う。 */
function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** login(マジックリンク)→ 世帯作成 → BottomNav「予定」で /calendar を開く。 */
async function loginAndOpenCalendar(page: Page, email: string): Promise<void> {
  await loginViaMagicLink(page, email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E カレンダー世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/meals/, { timeout: 15_000 })
  await page.getByRole("link", { name: "予定" }).click()
  await expect(page).toHaveURL(/\/calendar/, { timeout: 15_000 })
}

async function reloadHydrated(page: Page): Promise<void> {
  const ws = page.waitForEvent("websocket", { timeout: 20_000 })
  await page.reload()
  await ws
}

async function openOverlay(trigger: Locator, readySignal: Locator): Promise<void> {
  // Base UI Dialog は close 後も exit transition 中(~200ms)旧 Popup を DOM に残す
  // (data-open が外れ data-closed/data-ending-style が付く。popupStateMapping.js)。
  // opacity フェード中の旧シートは Playwright の isVisible() では true のため、
  // 同一テスト内で「シート close → 即再オープン」すると下の readySignal 判定が
  // 旧シートの見出しで満たされ、trigger クリックがスキップされる。fill/click は
  // 死にゆく DOM に入り、unmount で detached になる(決定論的)。
  // → 退場中シートの消滅を待ってから開く。entering/open 中のシートは
  // data-open が付いているため誤ブロックしない。
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

async function waitForEventCount(
  userId: string,
  title: string,
  expected: number,
): Promise<void> {
  const admin = adminClient()
  await expect(async () => {
    const { data: profile } = await admin
      .from("profiles")
      .select("household_id")
      .eq("id", userId)
      .single()
    if (!profile?.household_id) throw new Error("household not ready")
    const { data, error } = await admin
      .from("calendar_events")
      .select("id")
      .eq("household_id", profile.household_id)
      .eq("title", title)
    if (error) throw new Error(`calendar lookup failed: ${error.message}`)
    if ((data?.length ?? 0) !== expected)
      throw new Error(`expected ${expected} "${title}", got ${data?.length ?? 0}`)
  }).toPass({ timeout: 15_000 })
}

/**
 * その利用者の世帯の `event_reminders` が期待の姿になるまで待つ。
 *
 * ⚠️ **`event_uid` を解決せぬ**。テスト世帯はこのテストが作った 1 件しか予定を
 * 持たぬゆえ、世帯で絞れば行は一意じゃ。uid を引くと「予定→uid→通知」の 2 段が
 * 増え、どちらが壊れて赤くなったのか読めなくなる。
 */
async function waitForReminders(
  userId: string,
  expected: { remind_kind: string; remind_minutes_before: number | null }[],
): Promise<void> {
  const admin = adminClient()
  await expect(async () => {
    const { data: profile } = await admin
      .from("profiles")
      .select("household_id")
      .eq("id", userId)
      .single()
    if (!profile?.household_id) throw new Error("household not ready")
    const { data, error } = await admin
      .from("event_reminders")
      .select("remind_kind, remind_minutes_before")
      .eq("household_id", profile.household_id)
      .order("remind_kind")
    if (error) throw new Error(`reminder lookup failed: ${error.message}`)
    expect(data ?? []).toEqual(expected)
  }).toPass({ timeout: 15_000 })
}

test("共有カレンダー: 予定を作成 → 反映 → 削除", async ({ page, approvedUser }) => {
  await loginAndOpenCalendar(page, approvedUser.email)

  // 3. FAB → フォーム → 追加（終日・今日）
  const addSheet = page.getByRole("heading", { name: "予定を追加" })
  await openOverlay(page.getByRole("button", { name: "予定を追加" }), addSheet)
  await page.getByLabel("タイトル").fill("検診")
  await page.getByRole("button", { name: "追加", exact: true }).click()

  // 4. DB 断面で作成完了を待ち、reload して SSR でアジェンダに出る
  await waitForEventCount(approvedUser.id, "検診", 1)
  await reloadHydrated(page)
  await expect(page.getByText("検診")).toBeVisible({ timeout: 15_000 })

  // 5. アジェンダの予定をタップ → 編集シート → 削除
  await page.getByText("検診").click()
  await expect(page.getByRole("heading", { name: "予定を編集" })).toBeVisible({
    timeout: 5_000,
  })
  await page.getByRole("button", { name: "削除" }).click()

  // 6. DB から消えたことを待ち、reload して SSR で消えている
  await waitForEventCount(approvedUser.id, "検診", 0)
  await reloadHydrated(page)
  await expect(page.getByText("検診")).toHaveCount(0)
})

test("繰り返し予定: 毎週×3週を作成 → 3件生成 → シリーズ一括削除で全消滅", async ({
  page,
  approvedUser,
}) => {
  await loginAndOpenCalendar(page, approvedUser.email)

  const today = todayJst()
  // 今日から2週間後まで(毎週) = 今日 / +7 / +14 の 3 開催日。
  const until = shiftYmd(today, 14)

  // FAB → フォーム。終日・毎週・終了日 = 今日+14日。
  const addSheet = page.getByRole("heading", { name: "予定を追加" })
  await openOverlay(page.getByRole("button", { name: "予定を追加" }), addSheet)
  await page.getByLabel("タイトル").fill("毎週予定")
  // 繰り返し select を「毎週」に。
  await page.locator("#cal-repeat").click()
  await page.getByRole("option", { name: "毎週" }).click()
  // 終了日(既定は開始日+3ヶ月)を今日+14日へ上書きし、3 開催日に固定する。
  await page.locator("#cal-repeat-until").fill(until)
  await page.getByRole("button", { name: "追加", exact: true }).click()

  // DB 断面で 3 行生成を待つ(date 非依存 = household + title で数える)。
  await waitForEventCount(approvedUser.id, "毎週予定", 3)
  await reloadHydrated(page)
  // 今日の開催回はアジェンダ(選択日 = 今日)に必ず出る(範囲内の1件のみ assert)。
  await expect(page.getByText("毎週予定")).toBeVisible({ timeout: 15_000 })

  // アジェンダの予定をタップ → 編集シート → シリーズ一括削除。
  await page.getByText("毎週予定").click()
  await expect(page.getByRole("heading", { name: "予定を編集" })).toBeVisible({
    timeout: 5_000,
  })
  await page.getByRole("button", { name: /すべて削除/ }).click()

  // DB からシリーズ全体(3 行)が消えたことを待ち、reload で SSR でも消えている。
  await waitForEventCount(approvedUser.id, "毎週予定", 0)
  await reloadHydrated(page)
  await expect(page.getByText("毎週予定")).toHaveCount(0)
})

test("世帯分離: 別世帯の予定は見えない（RLS 回帰ガード）", async ({
  page,
  approvedUser,
}) => {
  const today = todayJst()
  const admin = adminClient()
  // 別世帯 B と、そこに「今日」の予定を service_role(RLS バイパス)で seed。
  // RLS が漏れていれば A のアジェンダ(今日)に出てしまうため、今日に置く。
  const otherHouseholdId = crypto.randomUUID()
  {
    const { error: hErr } = await admin
      .from("households")
      .insert({ id: otherHouseholdId, name: "他世帯" })
    expect(hErr, "他世帯 seed 失敗").toBeNull()
    const { error: eErr } = await admin.from("calendar_events").insert({
      household_id: otherHouseholdId,
      title: "他世帯の秘密予定",
      is_all_day: true,
      start_date: today,
      end_date: today,
      source: "native",
    })
    expect(eErr, "他世帯イベント seed 失敗").toBeNull()
  }
  try {
    await loginAndOpenCalendar(page, approvedUser.email)
    // A の /calendar には B の予定が出ない(RLS の household 分離)
    await expect(page.getByText("他世帯の秘密予定")).toHaveCount(0)
  } finally {
    // households の CASCADE で calendar_events も消える
    await admin.from("households").delete().eq("id", otherHouseholdId)
  }
})

test("時刻付き予定の作成→HH:MM 表示、編集でタイトル変更が反映", async ({
  page,
  approvedUser,
}) => {
  await loginAndOpenCalendar(page, approvedUser.email)

  // 時刻付き予定(終日を外す → 14:00)
  const addSheet = page.getByRole("heading", { name: "予定を追加" })
  await openOverlay(page.getByRole("button", { name: "予定を追加" }), addSheet)
  await page.getByLabel("タイトル").fill("保育園見学")
  await page.getByRole("button", { name: "時刻あり", exact: true }).click() // 終日を外す
  await page.locator("#cal-start-time").fill("14:00")
  await page.getByRole("button", { name: "追加", exact: true }).click()

  await waitForEventCount(approvedUser.id, "保育園見学", 1)
  await reloadHydrated(page)
  await expect(page.getByText("保育園見学")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("14:00")).toBeVisible()

  // 編集: タイトル変更 → 反映
  await page.getByText("保育園見学").click()
  await expect(page.getByRole("heading", { name: "予定を編集" })).toBeVisible({
    timeout: 5_000,
  })
  await page.getByLabel("タイトル").fill("保育園見学（変更）")
  await page.getByRole("button", { name: "更新" }).click()

  await waitForEventCount(approvedUser.id, "保育園見学（変更）", 1)
  await reloadHydrated(page)
  await expect(page.getByText("保育園見学（変更）")).toBeVisible({
    timeout: 15_000,
  })
})

test("検証に弾かれてもシートは閉じず、入力が保持される", async ({
  page,
  approvedUser,
}) => {
  await loginAndOpenCalendar(page, approvedUser.email)

  const addSheet = page.getByRole("heading", { name: "予定を追加" })
  await openOverlay(page.getByRole("button", { name: "予定を追加" }), addSheet)
  await page.locator("#cal-title").fill("入力保持テスト")
  await page.locator("#cal-memo").fill("母子手帳と診察券")
  // 終了日を開始日より前にする(サーバー往復で弾かれていた代表ケース)。
  await page.locator("#cal-end-date").fill(shiftYmd(todayJst(), -1))
  await page.getByRole("button", { name: "追加", exact: true }).click()

  // data-open が付いた「生きているシート」に限定して assert する。
  // close 開始で data-open は同期的に外れるため、退場アニメーション中の
  // 旧シート(isVisible() は true のまま)でこの assert は満たされない。
  // エラー文言も**シート内**に限定する — 同じ文言をサーバーが返して
  // sonner トーストに出すだけの実装ではこの assert は通らない。
  const openSheet = page.locator('[data-slot="sheet-content"][data-open]')
  await expect(openSheet).toBeVisible()
  await expect(
    openSheet.getByText("終了日は開始日以降にしてください"),
  ).toBeVisible()
  await expect(openSheet.locator("#cal-title")).toHaveValue("入力保持テスト")
  await expect(openSheet.locator("#cal-memo")).toHaveValue("母子手帳と診察券")
  await expect(openSheet.locator("#cal-end-date")).toHaveAttribute(
    "aria-invalid",
    "true",
  )

  // 終了日を直せばそのまま保存でき、入力し直しは不要。
  await page.locator("#cal-end-date").fill(todayJst())
  await page.getByRole("button", { name: "追加", exact: true }).click()
  await waitForEventCount(approvedUser.id, "入力保持テスト", 1)
})

test("時刻付き予定は終了時刻も表示し、アジェンダは終日→時刻順に並ぶ", async ({
  page,
  approvedUser,
}) => {
  await loginAndOpenCalendar(page, approvedUser.email)

  const addSheet = page.getByRole("heading", { name: "予定を追加" })

  // 終日イベント(今日)
  await openOverlay(page.getByRole("button", { name: "予定を追加" }), addSheet)
  await page.getByLabel("タイトル").fill("終日イベント")
  await page.getByRole("button", { name: "追加", exact: true }).click()
  await waitForEventCount(approvedUser.id, "終日イベント", 1)

  // 時刻付きイベント(今日 14:00〜15:00) — 開始・終了の両時刻を入れる
  await openOverlay(page.getByRole("button", { name: "予定を追加" }), addSheet)
  await page.getByLabel("タイトル").fill("面談")
  await page.getByRole("button", { name: "時刻あり", exact: true }).click() // 終日を外す
  await page.locator("#cal-start-time").fill("14:00")
  await page.locator("#cal-end-time").fill("15:00")
  await page.getByRole("button", { name: "追加", exact: true }).click()
  await waitForEventCount(approvedUser.id, "面談", 1)

  await reloadHydrated(page)

  // 終了時刻(2 段目「〜15:00」)と開始時刻(14:00)が両方見える
  await expect(page.getByText("14:00")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText("〜15:00")).toBeVisible()

  // 並び順: 終日 → 時刻付き(sortDayEvents)。時刻文字列でなくタイトルの DOM 順で検証。
  const agenda = page.locator("section").filter({ hasText: "の予定" })
  const items = agenda.getByRole("button")
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toContainText("終日イベント")
  await expect(items.nth(1)).toContainText("面談")
})

/**
 * ★ **既存予定の通知は「Select を変えた瞬間」に保存される**（B-2 の
 * `handleReminderChange`）。google の read-only 詳細シートには保存ボタンが無く、
 * この経路が唯一の書き込み口ゆえ、壊れれば通知設定そのものが死ぬ。
 *
 * ⚠️ **なぜ e2e でしか塞げぬのか。** base-ui の Select は jsdom では
 * `fireEvent` で `onValueChange` が発火せぬ（`event-reminder.ts` の注記・実測）。
 * ゆえに「Select を変える」という**起点**を持つこの経路は、単体テストからは
 * 一度も駆動できておらぬ。`#cal-repeat` を実操作しておる上のテストと同じ形で撃つ。
 *
 * 見ておるのは 2 つ:
 *   1. **更新ボタンを押さずに** DB へ行が立つ（＝変更が即時に保存される）
 *   2. reload して開き直しても残る（＝読み戻しの経路まで繋がっておる）
 * 1 だけでは楽観表示との区別がつかず、2 だけでは submit 時保存の実装でも緑になる。
 */
test("既存予定の通知は Select を変えた瞬間に保存される", async ({
  page,
  approvedUser,
}) => {
  await loginAndOpenCalendar(page, approvedUser.email)

  const addSheet = page.getByRole("heading", { name: "予定を追加" })
  await openOverlay(page.getByRole("button", { name: "予定を追加" }), addSheet)
  await page.getByLabel("タイトル").fill("予防接種")
  await page.getByRole("button", { name: "追加", exact: true }).click()

  await waitForEventCount(approvedUser.id, "予防接種", 1)
  // 作成時の既定は「なし」ゆえ、この時点で通知の行は無い(下の assert の対照)。
  await waitForReminders(approvedUser.id, [])
  await reloadHydrated(page)

  const editSheet = page.getByRole("heading", { name: "予定を編集" })
  await openOverlay(page.getByText("予防接種"), editSheet)

  // ⚠️ **enabled を待つ**。開いた直後は state が "loading" で Select は
  // disabled じゃが、その間も表示は「なし」ゆえ文言だけ見ると読み込み中に撃つ。
  const reminder = page.locator("#cal-reminder")
  await expect(reminder).toBeEnabled({ timeout: 15_000 })
  await expect(reminder).toHaveText(/なし/)

  // 通知を「30分前」へ。**更新ボタンは押さぬ。**
  await reminder.click()
  await page.getByRole("option", { name: "30分前" }).click()

  await waitForReminders(approvedUser.id, [
    { remind_kind: "minutes", remind_minutes_before: 30 },
  ])

  // reload → 開き直しても残っておる(サーバから読み直した値じゃ)。
  await reloadHydrated(page)
  await openOverlay(page.getByText("予防接種"), editSheet)
  const reopened = page.locator("#cal-reminder")
  await expect(reopened).toBeEnabled({ timeout: 15_000 })
  await expect(reopened).toHaveText(/30分前/)

  // 「なし」へ戻せば行が消える(同じハンドラの削除側。ここも即時じゃ)。
  await reopened.click()
  await page.getByRole("option", { name: "なし" }).click()
  await waitForReminders(approvedUser.id, [])
})
