import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * 掃除ルーティーン E2E（要件台帳 B-01〜B-05 / V-B / V-BROWSER）。
 *
 * login → 世帯作成 → /chores/cleaning → テンプレートから項目を追加（実績は作られぬ）→ 再読込
 * → 1 タップ完了 → 直後の取り消し → もう一度完了 → 履歴で実施日を昨日へ訂正 → 再読込
 * → 44px の実測（項目つき・詳細シートを開いた状態）。
 *
 * 日付に依らぬよう、項目は「実施してから一定期間後・最初の予定日 = 今日」で作る（必ず今日が期限）。
 * 世帯は fixture（approvedUser）がテストごとに作って消す（households の CASCADE で掃除の行も消える）。
 *
 * ほかに:
 * - B-07f 早めに実施した直後の回（鍵が予定日の翌日へ逃げた回）をスキップしても、次回は予定日 + 周期
 * - R35 遅れて届いた保存の応答は、送信中に開いた別のシートを閉じず、入力も保存中の表示も変えない
 */

test.setTimeout(180_000)

const MIN_TOUCH_PX = 44

/** "YYYY-MM-DD" の暦日を days 日ずらす（`new Date("YYYY-MM-DD")` を使わぬ）。 */
function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** login → 世帯作成 → 掃除の画面を開く。世帯 ID を返す。 */
async function openCleaningWithHousehold(page: Page, email: string, userId: string, name: string): Promise<string> {
  await loginViaMagicLink(page, email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill(name)
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(userId)
  await page.goto("/chores/cleaning")
  return householdId
}

/**
 * この画面の次の保存（Server Action の POST。本文に `bodyIncludes` を含むもの）を 1 回だけ、サーバーには
 * 届けて記録させたうえで応答だけを止める（回線が遅い・応答が遅れて届く形）。`release` で応答を渡す。
 * 履歴の読み足しなど、ほかの Server Action は止めぬ。
 */
async function holdNextSave(
  page: Page,
  url: string,
  bodyIncludes: string,
): Promise<{ held: () => boolean; release: () => void }> {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false
  await page.route(url, async (route) => {
    const request = route.request()
    if (
      !held &&
      request.method() === "POST" &&
      request.headers()["next-action"] &&
      (request.postData() ?? "").includes(bodyIncludes)
    ) {
      held = true
      const response = await route.fetch()
      await gate
      await route.fulfill({ response })
      return
    }
    await route.fallback()
  })
  return { held: () => held, release }
}

/** approvedUser の世帯 ID を DB 断面で待つ。 */
async function waitForHouseholdId(userId: string): Promise<string> {
  const admin = adminClient()
  let householdId = ""
  await expect(async () => {
    const { data: profile, error } = await admin.from("profiles").select("household_id").eq("id", userId).single()
    if (error) throw new Error(`profile lookup failed: ${error.message}`)
    if (!profile?.household_id) throw new Error("household not ready")
    householdId = profile.household_id
  }).toPass({ timeout: 15_000 })
  return householdId
}

/** 履歴の行数（有効 / 取り消し済み）が期待どおりになるのを DB 断面で待つ。 */
async function expectLogCounts(householdId: string, expected: { valid: number; voided: number }): Promise<void> {
  const admin = adminClient()
  await expect(async () => {
    const { data, error } = await admin.from("cleaning_logs").select("id, voided_at").eq("household_id", householdId)
    if (error) throw new Error(`cleaning_logs lookup failed: ${error.message}`)
    const rows = data ?? []
    const valid = rows.filter((row) => row.voided_at === null).length
    const voided = rows.length - valid
    if (valid !== expected.valid || voided !== expected.voided) {
      throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify({ valid, voided })}`)
    }
  }).toPass({ timeout: 15_000 })
}

test("掃除: 追加 → 再読込 → 1 タップ完了 → 取り消し → 再完了 → 履歴の訂正", async ({ page, approvedUser }) => {
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E掃除世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(approvedUser.id)
  await page.setViewportSize({ width: 390, height: 844 })

  // ── 1. ナビの「家事」→ 掃除。空の案内から追加する ─────────────────────────────
  await page.getByRole("link", { name: "家事", exact: true }).click()
  await expect(page).toHaveURL(/\/chores$/, { timeout: 15_000 })
  await page.getByRole("link", { name: /^掃除/ }).click()
  await expect(page).toHaveURL(/\/chores\/cleaning$/, { timeout: 15_000 })
  await expect(page.getByRole("heading", { level: 1, name: "掃除" })).toBeVisible()
  await expect(page.getByText("掃除の項目がまだありません")).toBeVisible()

  await page.getByRole("button", { name: "最初の項目を追加" }).click()
  const createSheet = page.getByRole("dialog")
  await expect(createSheet.getByRole("heading", { name: "掃除の項目を追加" })).toBeVisible()
  // テンプレートは入力欄を埋めるだけ（この時点で DB に行は無い）
  await createSheet.getByRole("button", { name: "浴室の排水口", exact: true }).click()
  await expect(createSheet.getByLabel("名前")).toHaveValue("浴室の排水口")
  const admin = adminClient()
  {
    const { data, error } = await admin.from("cleaning_routines").select("id").eq("household_id", householdId)
    expect(error).toBeNull()
    expect(data ?? []).toHaveLength(0)
  }
  await createSheet.getByRole("button", { name: /実施してから一定期間後/ }).click()
  await expect(createSheet.getByTestId("cadence-reading")).toContainText("実施した日から1週間後")
  await createSheet.getByRole("button", { name: "この内容で追加" }).click()
  await expect(page.getByRole("status").filter({ hasText: "「浴室の排水口」を追加しました。" })).toBeVisible({
    timeout: 15_000,
  })

  // ── 2. 今日が期限・履歴なしは「未記録」。再読込しても残り、実績は作られておらぬ ──
  const due = page.getByRole("region", { name: "今日・今週やること" })
  const item = due.getByTestId("cleaning-item").filter({ hasText: "浴室の排水口" })
  await expect(item).toBeVisible({ timeout: 15_000 })
  await expect(item).toContainText("未記録")
  await expect(item).toContainText("今日")
  await page.reload()
  await expect(item).toBeVisible({ timeout: 15_000 })
  await expect(item).toContainText("未記録")
  await expectLogCounts(householdId, { valid: 0, voided: 0 })

  // ── 3. 1 タップ完了 → 次回へ進み、前回は今日 ────────────────────────────────
  await page.getByRole("checkbox", { name: "浴室の排水口を完了にする" }).click()
  await expect(page.getByRole("status").filter({ hasText: "「浴室の排水口」を完了にしました。" })).toBeVisible({
    timeout: 15_000,
  })
  await expectLogCounts(householdId, { valid: 1, voided: 0 })
  const rest = page.getByRole("region", { name: "このあとの項目" })
  const moved = rest.getByTestId("cleaning-item").filter({ hasText: "浴室の排水口" })
  await expect(moved).toBeVisible({ timeout: 15_000 })
  await expect(moved).toContainText("（今日）")
  await expect(moved).toContainText("（7日後）")

  // ── 4. 直後の取り消し → 前回実施日が「未記録」へ戻る（行は取り消し済みとして残る）──
  await page.getByTestId("cleaning-inline-undo").getByRole("button", { name: "直前の記録を取り消す" }).click()
  await expect(page.getByRole("status").filter({ hasText: "記録を取り消しました。" })).toBeVisible({ timeout: 15_000 })
  await expectLogCounts(householdId, { valid: 0, voided: 1 })
  await expect(item).toBeVisible({ timeout: 15_000 })
  await expect(item).toContainText("未記録")
  await expect(page.getByTestId("cleaning-inline-undo")).toHaveCount(0)

  // ── 5. 取り消した回は、もう一度完了できる ────────────────────────────────────
  await page.getByRole("checkbox", { name: "浴室の排水口を完了にする" }).click()
  await expectLogCounts(householdId, { valid: 1, voided: 1 })
  await expect(moved).toBeVisible({ timeout: 15_000 })

  // ── 6. 44px の実測（項目つきの画面）─────────────────────────────────────────
  const violations: string[] = []
  async function measure(label: string) {
    const targets = page.locator('button, [role="button"], a[href], input[type="checkbox"], input[type="radio"]')
    const count = await targets.count()
    for (let i = 0; i < count; i++) {
      const element = targets.nth(i)
      const box = await element.boundingBox()
      if (box === null || box.width === 0 || box.height === 0) continue
      if (box.width >= MIN_TOUCH_PX && box.height >= MIN_TOUCH_PX) continue
      const name =
        (await element.getAttribute("aria-label")) ?? (await element.textContent())?.trim().slice(0, 24) ?? "(名前不明)"
      violations.push(`${label}: "${name}" = ${Math.round(box.width)}x${Math.round(box.height)}px`)
    }
  }
  await measure("一覧")

  // ── 7. 詳細の履歴から実施日を昨日へ訂正 → 次回は実施日から数え直す ──────────────
  await page.getByRole("button", { name: "浴室の排水口の詳細を開く" }).click()
  const detail = page.getByRole("dialog")
  await expect(detail.getByRole("heading", { name: "浴室の排水口" })).toBeVisible()
  await measure("詳細シート")
  // 「過去にやった日を記録」の初期値が昨日（サーバーの今日 - 1 日）。その値を訂正先に使う
  // （訂正の入力欄を開く前に読む。開くと同じラベルの欄が 2 つになる）
  const yesterday = await detail.getByLabel("実施した日").inputValue()
  const logRow = detail.getByTestId("cleaning-log").first()
  await logRow.getByRole("button", { name: /を訂正$/ }).click()
  const doneOn = logRow.getByLabel("実施した日")
  const today = (await doneOn.getAttribute("max")) ?? ""
  expect(yesterday < today).toBe(true)
  await doneOn.fill(yesterday)
  await logRow.getByRole("button", { name: "訂正を保存" }).click()
  await expect(page.getByRole("status").filter({ hasText: "の履歴を訂正しました。" })).toBeVisible({ timeout: 15_000 })
  // 次回は昨日 + 7 日 = 6 日後。今日が月曜なら今週の日曜に当たり「今日・今週やること」へ移るゆえ、
  // 区画に依らず項目そのものを見る
  const anywhere = page.getByTestId("cleaning-item").filter({ hasText: "浴室の排水口" })
  await expect(anywhere).toContainText("（昨日）", { timeout: 15_000 })
  await expect(anywhere).toContainText("（6日後）")
  {
    const { data, error } = await admin
      .from("cleaning_logs")
      .select("done_on, occurrence")
      .eq("household_id", householdId)
      .is("voided_at", null)
    expect(error).toBeNull()
    // 訂正は実施日だけを動かし、閉じた回の鍵は変えぬ
    expect(data).toEqual([{ done_on: yesterday, occurrence: today }])
  }

  // ── 8. 再読込しても同じ内容 ────────────────────────────────────────────────
  await page.reload()
  await expect(anywhere).toBeVisible({ timeout: 15_000 })
  await expect(anywhere).toContainText("（昨日）")

  expect(violations, `44px 未満の押下対象:\n  ${violations.join("\n  ")}`).toEqual([])
})

test("掃除: 未来の日は実施として記録できない（画面と DB の両方）", async ({ page, approvedUser }) => {
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E掃除未来日世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(approvedUser.id)

  await page.goto("/chores/cleaning")
  await page.getByRole("button", { name: "最初の項目を追加" }).click()
  const createSheet = page.getByRole("dialog")
  await createSheet.getByLabel("名前").fill("窓ふき")
  await createSheet.getByRole("button", { name: "この内容で追加" }).click()
  await expect(page.getByRole("status").filter({ hasText: "「窓ふき」を追加しました。" })).toBeVisible({ timeout: 15_000 })

  await page.getByRole("button", { name: "窓ふきの詳細を開く" }).click()
  const detail = page.getByRole("dialog")
  const doneOn = detail.getByLabel("実施した日")
  const today = (await doneOn.getAttribute("max")) ?? ""
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  // 入力欄の max を越える値を直に入れても、送らずに理由を出す
  await doneOn.fill("2999-01-01")
  await detail.getByRole("button", { name: "この日の実施を記録" }).click()
  await expect(detail.getByRole("alert")).toContainText("未来の日付は実施日として記録できません")
  await expectLogCounts(householdId, { valid: 0, voided: 0 })

  // 対照: 今日なら記録でき、今回の分は閉じぬ（回の鍵なし）
  await doneOn.fill(today)
  await detail.getByRole("button", { name: "この日の実施を記録" }).click()
  await expect(page.getByRole("status").filter({ hasText: "の過去の実施を記録しました。" })).toBeVisible({
    timeout: 15_000,
  })
  const { data, error } = await adminClient()
    .from("cleaning_logs")
    .select("done_on, occurrence, kind")
    .eq("household_id", householdId)
  expect(error).toBeNull()
  expect(data).toEqual([{ done_on: today, occurrence: null, kind: "done" }])
})

test("掃除 B-07f: 早めに実施した直後の回をスキップしても、次回は予定日から 1 周期後（鍵の翌日からではない）", async ({
  page,
  approvedUser,
}) => {
  const householdId = await openCleaningWithHousehold(page, approvedUser.email, approvedUser.id, "E2E掃除スキップ世帯")

  // 実施してから 1 週間後・最初の予定日 = 今日 + 7 日の項目を作る
  await page.getByRole("button", { name: "最初の項目を追加" }).click()
  const createSheet = page.getByRole("dialog")
  await createSheet.getByLabel("名前").fill("換気扇")
  await createSheet.getByRole("button", { name: /実施してから一定期間後/ }).click()
  const firstDue = createSheet.getByLabel("最初の予定日")
  // 初期値はサーバーの今日（JST）
  const today = await firstDue.inputValue()
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  const scheduled = shiftYmd(today, 7)
  await firstDue.fill(scheduled)
  await createSheet.getByRole("button", { name: "この内容で追加" }).click()
  await expect(page.getByRole("status").filter({ hasText: "「換気扇」を追加しました。" })).toBeVisible({ timeout: 15_000 })

  // 1. 今日、早めに実施する（最初の予定日の回を閉じる）。次の予定日は今日 + 7 = 閉じた回と同じ日ゆえ、
  //    回の鍵は翌日（今日 + 8）へ逃げるが、予定日は今日 + 7 のまま
  const item = page.getByTestId("cleaning-item").filter({ hasText: "換気扇" })
  await page.getByRole("checkbox", { name: "換気扇を完了にする" }).click()
  await expect(page.getByRole("status").filter({ hasText: "「換気扇」を完了にしました。" })).toBeVisible({ timeout: 15_000 })
  await expect(item).toContainText("（今日）", { timeout: 15_000 })
  await expect(item).toContainText("（7日後）")

  // 2. その回をスキップする。次回は予定日（今日 + 7）+ 1 週 = 14 日後。前回実施日（今日）は動かぬ
  await page.getByRole("button", { name: "換気扇の詳細を開く" }).click()
  const detail = page.getByRole("dialog")
  await expect(detail.getByText(/スキップすると、実施の記録は付けずに次回/)).toBeVisible()
  await detail.getByRole("button", { name: "今回はスキップ" }).click()
  await expect(page.getByRole("status").filter({ hasText: "「換気扇」をスキップしました。" })).toBeVisible({
    timeout: 15_000,
  })
  await expect(item).toContainText("（14日後）", { timeout: 15_000 })
  await expect(item).not.toContainText("（15日後）")
  await expect(item).toContainText("（今日）")

  // 3. DB: スキップの行は、鍵（今日 + 8）とは別に、その回の予定日（今日 + 7）を持つ
  {
    const { data, error } = await adminClient()
      .from("cleaning_logs")
      .select("kind, done_on, occurrence, scheduled_on")
      .eq("household_id", householdId)
      .is("voided_at", null)
      .order("created_at")
    expect(error).toBeNull()
    expect(data).toEqual([
      { kind: "done", done_on: today, occurrence: scheduled, scheduled_on: null },
      { kind: "skip", done_on: null, occurrence: shiftYmd(today, 8), scheduled_on: scheduled },
    ])
  }

  // 4. 再読込しても同じ（SSR の計算も予定日から）
  await page.reload()
  await expect(item).toContainText("（14日後）", { timeout: 15_000 })
  await expect(item).toContainText("（今日）")
})

test("掃除 R35: 遅れて届いた完了の応答は、送信中に開いた「項目を追加」のシートを閉じず、入力も消さない", async ({
  page,
  approvedUser,
}) => {
  const householdId = await openCleaningWithHousehold(page, approvedUser.email, approvedUser.id, "E2E掃除応答世帯")
  await page.getByRole("button", { name: "最初の項目を追加" }).click()
  const firstSheet = page.getByRole("dialog")
  await firstSheet.getByLabel("名前").fill("浴室の排水口")
  await firstSheet.getByRole("button", { name: /実施してから一定期間後/ }).click()
  await firstSheet.getByRole("button", { name: "この内容で追加" }).click()
  await expect(page.getByRole("status").filter({ hasText: "「浴室の排水口」を追加しました。" })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByRole("dialog")).toHaveCount(0)

  // 1. 1 タップ完了の応答だけを止める（サーバーには届いて記録される）
  const hold = await holdNextSave(page, "**/chores/cleaning", '"op":"close"')
  await page.getByRole("checkbox", { name: "浴室の排水口を完了にする" }).click()
  await expect.poll(hold.held, { timeout: 15_000 }).toBe(true)
  await expectLogCounts(householdId, { valid: 1, voided: 0 })

  // 2. 応答を待つ間に「項目を追加」を開いて名前を打つ。このシートは「保存中」にならぬ
  await page.getByRole("button", { name: "項目を追加" }).click()
  const sheet = page.getByRole("dialog")
  await expect(sheet.getByRole("heading", { name: "掃除の項目を追加" })).toBeVisible()
  await sheet.getByLabel("名前").fill("窓ふき")
  await expect(sheet.getByRole("button", { name: "この内容で追加" })).toBeVisible()

  // 3. 先の応答を渡す。シートは開いたまま・入力も残り、保存の釦は押せるようになる。先の結果はシートに出さぬ
  hold.release()
  await expect(sheet.getByRole("button", { name: "この内容で追加" })).toBeEnabled({ timeout: 15_000 })
  await expect(sheet.getByRole("heading", { name: "掃除の項目を追加" })).toBeVisible()
  await expect(sheet.getByLabel("名前")).toHaveValue("窓ふき")
  await expect(sheet.getByText("「浴室の排水口」を完了にしました。")).toHaveCount(0)
  await page.unroute("**/chores/cleaning")

  // 4. このシートから送った保存は、このシートを閉じて結果を一覧に出す。先の完了も一覧に反映済み
  await sheet.getByRole("button", { name: "この内容で追加" }).click()
  await expect(page.getByRole("status").filter({ hasText: "「窓ふき」を追加しました。" })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByTestId("cleaning-item").filter({ hasText: "浴室の排水口" })).toContainText("（今日）")
  {
    const { data, error } = await adminClient()
      .from("cleaning_routines")
      .select("name")
      .eq("household_id", householdId)
      .order("name")
    expect(error).toBeNull()
    expect((data ?? []).map((row) => row.name).sort()).toEqual(["浴室の排水口", "窓ふき"].sort())
  }
  await expectLogCounts(householdId, { valid: 1, voided: 0 })
})
