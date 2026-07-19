import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"

/**
 * 誕生日 UTC 罠のアプリ層防御 E2E（計画: docs/plans/2026-07-18-babycare-ux.md §3 B-04）。
 *
 * 検証対象:
 * (1) 生年月日 date input に max=当日(JST) が付く。
 * (2) 当日誕生日を登録したとき、汎用の失敗文言（原因不明）ではなく、
 *     成功 or 誕生日起因の明確な文言のいずれかが出る。
 *
 * 登録が成功するか自体は本 PR の合否に含めない: DB 側 CHECK
 * (chk_baby_birth_date) は CURRENT_DATE(UTC) 基準のため、この e2e スタックが
 * TZ=UTC で走ることも相まって、JST 当日が「未来」扱いで弾かれる時間帯がある。
 * その CHECK の JST 化は前回計画 I-09a の migration 管轄（本 PR は非包含）。
 * 本 e2e が固定するのは「どちらの分岐でも汎用文言に化けない」ことのみ。
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

/** login(マジックリンク) → 世帯作成 → /settings を開く。 */
async function loginAndOpenSettings(page: Page, email: string): Promise<void> {
  await loginViaMagicLink(page, email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E 誕生日世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/meals/, { timeout: 15_000 })
  await page.goto("/settings")
  // 赤ちゃん情報カードの CardTitle は heading role を持たない div ゆえ
  // getByRole("heading") では拾えない。到達判定は一意な「生年月日」入力に置く。
  await expect(page.getByLabel("生年月日")).toBeVisible({ timeout: 15_000 })
}

test("当日誕生日の登録は汎用失敗文言ではなく明確な結果になる", async ({
  page,
  approvedUser,
}) => {
  const today = todayJst()
  await loginAndOpenSettings(page, approvedUser.email)

  // 赤ちゃん情報フォームは「生年月日」ラベルを含む form で一意に絞る
  // （settings にはプロフィール保存の「保存」ボタンも別に存在するため）。
  const babyForm = page
    .locator("form")
    .filter({ has: page.getByLabel("生年月日") })
  const birthDate = babyForm.getByLabel("生年月日")
  const saveButton = babyForm.getByRole("button", { name: "保存" })

  // (1) date input に max=当日(JST) が付く
  await expect(birthDate).toHaveAttribute("max", today)

  // (2) 当日を入力して保存
  await birthDate.fill(today)

  // 成功 or 誕生日起因の明確な文言のいずれかが出るまでクリックをリトライ
  // （ハイドレーション完了前の click は無反応になりうる — golden-path と同方針）。
  const clearOutcome = page.getByText(
    /赤ちゃん情報を更新しました|誕生日には今日以前の日付を指定してください/
  )
  await expect(async () => {
    if (!(await clearOutcome.isVisible())) {
      await saveButton.click({ timeout: 2_000 })
    }
    await expect(clearOutcome).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })

  // 汎用の「原因不明」文言は出てはならない（これが B-04 の核心）。
  await expect(page.getByText("赤ちゃん情報の更新に失敗しました")).toHaveCount(0)
})
