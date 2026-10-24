import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import {
  adminClient,
  cleanupUser,
  createApprovedUser,
  loginViaMagicLink,
  uniqueEmail,
} from "./fixtures/auth"

/**
 * 育児ログの編集の衝突（P2-07）E2E。二つの端末（A = 世帯を作った人、B = 同じ世帯の家族）。
 *
 * A がうんち（大量）を記録 → B が同じ記録の編集を開いてメモを打つ（未保存）
 * → A が同じ記録を「少量」へ直して保存 → B が古い画面のまま保存
 * → B の保存は衝突として拒まれ、B の入力は画面に残り、DB は A の「少量」のまま
 * → B が「最新の内容で編集し直す」→ 少量で seed され直し、メモを足して保存
 * → DB は「少量 + B のメモ」（A の変更を巻き戻さぬ）。
 *
 * ## なぜ DB 断面まで見るか
 * 衝突の表示だけでは「保存は通ったが表示だけ出た」と区別できぬ。B の保存が書かなかった
 * こと・再編集が A の変更を残したことは service_role の直読みで固定する。
 *
 * ## フレーク対策（baby-diaper-amount.spec.ts と同じ流儀）
 * - 時間ベースの sleep は使わず DB 断面を poll して同期する
 * - Sheet の open は openOverlay（退場中シートの消滅を待ってから click）
 * - シート内のロケータは開いているシート（[data-open]）へスコープする
 */

test.setTimeout(240_000)

/** Sheet / Dialog を決定的に開く（baby-diaper-amount.spec.ts と同一実装）。 */
async function openOverlay(
  trigger: Locator,
  readySignal: Locator
): Promise<void> {
  await expect(
    trigger.page().locator('[data-slot="sheet-content"]:not([data-open])')
  ).toHaveCount(0, { timeout: 10_000 })
  await expect(async () => {
    if (!(await readySignal.isVisible())) {
      await trigger.click({ timeout: 2_000 })
    }
    await expect(readySignal).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

/** approvedUser の世帯 ID を DB 断面で待つ（世帯作成 server action の完了同期点）。 */
async function waitForHouseholdId(userId: string): Promise<string> {
  const admin = adminClient()
  let householdId = ""
  await expect(async () => {
    const { data: profile, error } = await admin
      .from("profiles")
      .select("household_id")
      .eq("id", userId)
      .single()
    if (error) throw new Error(`profile lookup failed: ${error.message}`)
    if (!profile?.household_id) throw new Error("household not ready")
    householdId = profile.household_id
  }).toPass({ timeout: 15_000 })
  return householdId
}

interface DiaperRow {
  id: string
  poop_amount: string | null
  memo: string | null
}

/** 世帯のおむつ行（ちょうど 1 行）を DB 断面で読む。二重記録が無いことも同時に固定する。 */
async function readOnlyDiaperRow(householdId: string): Promise<DiaperRow> {
  const admin = adminClient()
  const { data, error } = await admin
    .from("baby_logs")
    .select("id, poop_amount, memo")
    .eq("household_id", householdId)
    .eq("log_type", "diaper")
  if (error) throw new Error(`baby_logs lookup failed: ${error.message}`)
  if (!data || data.length !== 1)
    throw new Error(`expected 1 diaper row, got ${data?.length ?? 0}`)
  return data[0] as DiaperRow
}

function openSheetOf(page: Page): Locator {
  return page.locator('[data-slot="sheet-content"][data-open]')
}

/** 世帯のおむつ行（0 行以上）を DB 断面で読む（削除・取り消しの結果を固定する）。 */
async function readDiaperRows(householdId: string): Promise<DiaperRow[]> {
  const { data, error } = await adminClient()
    .from("baby_logs")
    .select("id, poop_amount, memo")
    .eq("household_id", householdId)
    .eq("log_type", "diaper")
  if (error) throw new Error(`baby_logs lookup failed: ${error.message}`)
  return (data ?? []) as DiaperRow[]
}

/** A: login → 世帯作成 → /baby。世帯 ID を返す。 */
async function createHouseholdAsA(
  page: Page,
  user: { id: string; email: string },
  householdName: string
): Promise<string> {
  await loginViaMagicLink(page, user.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill(householdName)
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(user.id)
  // 画面の用意ができた合図（baby-diaper-amount.spec.ts と同じ待ち）
  await expect(page.getByRole("group", { name: "今日のまとめ" })).toBeVisible({
    timeout: 15_000,
  })
  return householdId
}

test("二端末の編集競合: 古い画面からの保存は衝突として拒まれ、家族の変更が残り、最新で編集し直せる", async ({
  page,
  approvedUser,
  browser,
}, testInfo) => {
  // ── 1. A: login → 世帯作成 → /baby ─────────────────────────────
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E編集競合世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(approvedUser.id)

  // ── 2. B: 同じ世帯の家族（service role で世帯へ入れる = 招待フローのバイパス）──
  const family = await createApprovedUser(
    `family-${uniqueEmail(testInfo.workerIndex)}`
  )
  const contextB = await browser.newContext()
  // 手で作った context は fixtures/test.ts の page fixture を通らぬ。初回ツアー（bottom
  // Sheet）が自動で開いて backdrop が全操作を遮るゆえ、同じ既読フラグを B にも入れる
  await contextB.addInitScript(() => {
    try {
      localStorage.setItem("irori:tour-seen:v1", "1")
    } catch {
      /* localStorage 不可環境でも E2E を止めない */
    }
  })
  try {
    const { data: joined, error: joinError } = await adminClient()
      .from("profiles")
      .update({ household_id: householdId, role: "member" })
      .eq("id", family.id)
      .select("id")
      .single()
    if (joinError || !joined)
      throw new Error(`family join failed: ${joinError?.message ?? "0 rows"}`)

    // ── 3. A: うんち（大量）を記録 ─────────────────────────────────
    // 画面の用意ができた合図（baby-diaper-amount.spec.ts と同じ待ち）
    await expect(page.getByRole("group", { name: "今日のまとめ" })).toBeVisible({
      timeout: 15_000,
    })
    const quickA = page.getByRole("main")
    await quickA.getByRole("button", { name: "うんち", exact: true }).click()
    await quickA.getByRole("button", { name: "大量", exact: true }).click()
    await expect(
      page.getByText("おむつ交換を記録しました（うんち（大量））")
    ).toBeVisible({ timeout: 15_000 })
    let row: DiaperRow | undefined
    await expect(async () => {
      row = await readOnlyDiaperRow(householdId)
    }).toPass({ timeout: 15_000 })
    expect(row?.poop_amount).toBe("large")

    // ── 4. B: login → /baby → 同じ記録の編集を開き、メモを打つ（未保存）──
    const pageB = await contextB.newPage()
    await loginViaMagicLink(pageB, family.email)
    await pageB.goto("/baby")
    const rowB = pageB.getByRole("button", { name: /うんち（大量）/ })
    await expect(rowB).toBeVisible({ timeout: 15_000 })
    await openOverlay(rowB, pageB.getByRole("heading", { name: "おむつを編集" }))
    const sheetB = openSheetOf(pageB)
    await sheetB.getByLabel("メモ").fill("B の古い画面からのメモ")

    // ── 5. A: 同じ記録を「少量」へ直して先に保存 ──────────────────────
    const rowA = page.getByRole("button", { name: /うんち（大量）/ })
    await openOverlay(rowA, page.getByRole("heading", { name: "おむつを編集" }))
    const sheetA = openSheetOf(page)
    await sheetA.getByRole("button", { name: "少量", exact: true }).click()
    await sheetA.getByRole("button", { name: "更新する" }).click()
    await expect(page.getByText("ログを更新しました")).toBeVisible({
      timeout: 15_000,
    })
    await expect(async () => {
      const current = await readOnlyDiaperRow(householdId)
      if (current.poop_amount !== "small")
        throw new Error(`poop_amount still ${current.poop_amount}`)
    }).toPass({ timeout: 15_000 })

    // ── 6. B: 古い画面のまま保存 → 衝突。入力は残り、DB は A のまま ─────
    await sheetB.getByRole("button", { name: "更新する" }).click()
    const alert = sheetB.getByRole("alert")
    await expect(alert).toContainText("別の端末で先に更新されていました", {
      timeout: 15_000,
    })
    await expect(alert).toContainText("うんち（少量）")
    await expect(sheetB.getByLabel("メモ")).toHaveValue("B の古い画面からのメモ")
    await expect(sheetB.getByRole("button", { name: "更新する" })).toBeDisabled()
    await expect(pageB.getByText("ログを更新しました")).toHaveCount(0)
    const afterConflict = await readOnlyDiaperRow(householdId)
    expect(afterConflict.poop_amount).toBe("small")
    expect(afterConflict.memo).toBeNull()

    // ── 7. B: 最新の内容で編集し直す → 少量で seed → メモを足して保存 ───
    await sheetB.getByRole("button", { name: "最新の内容で編集し直す" }).click()
    const reopenedB = openSheetOf(pageB)
    await expect(reopenedB.getByRole("alert")).toHaveCount(0, { timeout: 10_000 })
    await expect(
      reopenedB.getByRole("button", { name: "少量", exact: true })
    ).toHaveClass(/bg-primary/)
    await expect(reopenedB.getByLabel("メモ")).toHaveValue("")
    await reopenedB.getByLabel("メモ").fill("B が最新を見てから足したメモ")
    await reopenedB.getByRole("button", { name: "更新する" }).click()
    await expect(pageB.getByText("ログを更新しました")).toBeVisible({
      timeout: 15_000,
    })
    await expect(async () => {
      const current = await readOnlyDiaperRow(householdId)
      if (current.memo !== "B が最新を見てから足したメモ")
        throw new Error(`memo still ${current.memo}`)
      // A の変更（少量）は巻き戻っておらぬ
      if (current.poop_amount !== "small")
        throw new Error(`poop_amount reverted to ${current.poop_amount}`)
    }).toPass({ timeout: 15_000 })
  } finally {
    await contextB.close()
    // B は世帯の行を参照しておるゆえ、A の世帯の掃除（fixture）より先に消す
    await cleanupUser(family.id)
  }
})

/**
 * 削除の版ガード（PR #235 敵対レビュー P1）。
 *
 * A と B が同じ記録を開く → A が「少量」へ直して先に保存 → B が古い画面のまま削除
 * → B の削除は衝突として拒まれ、DB は A の「少量」のまま 1 行残る（A の編集ごと消えぬ）
 * → B の入力は残り、背後の一覧は最新版（少量）に揃う
 * → 対照: B が「最新の内容で編集し直す」から削除すれば通り、DB は 0 行になる。
 */
test("二端末の削除競合: 古い画面からの削除は衝突として拒まれ、家族の変更が残り、最新で開き直せば削除できる", async ({
  page,
  approvedUser,
  browser,
}, testInfo) => {
  const householdId = await createHouseholdAsA(page, approvedUser, "E2E削除競合世帯")

  const family = await createApprovedUser(
    `family-del-${uniqueEmail(testInfo.workerIndex)}`
  )
  const contextB = await browser.newContext()
  await contextB.addInitScript(() => {
    try {
      localStorage.setItem("irori:tour-seen:v1", "1")
    } catch {
      /* localStorage 不可環境でも E2E を止めない */
    }
  })
  try {
    const { data: joined, error: joinError } = await adminClient()
      .from("profiles")
      .update({ household_id: householdId, role: "member" })
      .eq("id", family.id)
      .select("id")
      .single()
    if (joinError || !joined)
      throw new Error(`family join failed: ${joinError?.message ?? "0 rows"}`)

    // ── A: うんち（大量）を記録 ─────────────────────────────────────
    const quickA = page.getByRole("main")
    await quickA.getByRole("button", { name: "うんち", exact: true }).click()
    await quickA.getByRole("button", { name: "大量", exact: true }).click()
    await expect(
      page.getByText("おむつ交換を記録しました（うんち（大量））")
    ).toBeVisible({ timeout: 15_000 })
    await expect(async () => {
      const rows = await readDiaperRows(householdId)
      if (rows.length !== 1 || rows[0].poop_amount !== "large")
        throw new Error(`unexpected rows: ${JSON.stringify(rows)}`)
    }).toPass({ timeout: 15_000 })

    // ── B: 同じ記録の編集を開き、メモを打つ（未保存）──────────────────
    const pageB = await contextB.newPage()
    await loginViaMagicLink(pageB, family.email)
    await pageB.goto("/baby")
    const rowB = pageB.getByRole("button", { name: /うんち（大量）/ })
    await expect(rowB).toBeVisible({ timeout: 15_000 })
    await openOverlay(rowB, pageB.getByRole("heading", { name: "おむつを編集" }))
    const sheetB = openSheetOf(pageB)
    await sheetB.getByLabel("メモ").fill("B が削除の前に打ったメモ")

    // ── A: 同じ記録を「少量」へ直して先に保存 ──────────────────────────
    const rowA = page.getByRole("button", { name: /うんち（大量）/ })
    await openOverlay(rowA, page.getByRole("heading", { name: "おむつを編集" }))
    const sheetA = openSheetOf(page)
    await sheetA.getByRole("button", { name: "少量", exact: true }).click()
    await sheetA.getByRole("button", { name: "更新する" }).click()
    await expect(page.getByText("ログを更新しました")).toBeVisible({
      timeout: 15_000,
    })
    await expect(async () => {
      const rows = await readDiaperRows(householdId)
      if (rows.length !== 1 || rows[0].poop_amount !== "small")
        throw new Error(`unexpected rows: ${JSON.stringify(rows)}`)
    }).toPass({ timeout: 15_000 })

    // ── B: 古い画面のまま削除 → 衝突。A の記録は消えぬ ───────────────────
    await sheetB.getByRole("button", { name: "この記録を削除" }).click()
    await sheetB.getByRole("button", { name: "削除する" }).click()
    const alert = sheetB.getByRole("alert")
    await expect(alert).toContainText("別の端末で先に更新されていました", {
      timeout: 15_000,
    })
    await expect(alert).toContainText("うんち（少量）")
    // 入力は残り、確認は閉じ、古い版のまま押し直せぬ
    await expect(sheetB.getByLabel("メモ")).toHaveValue("B が削除の前に打ったメモ")
    await expect(sheetB.getByRole("button", { name: "削除する" })).toHaveCount(0)
    await expect(
      sheetB.getByRole("button", { name: "この記録を削除" })
    ).toBeDisabled()
    await expect(pageB.getByText("ログを削除しました")).toHaveCount(0)
    // DB: A の「少量」がちょうど 1 行残る（B のメモも書かれておらぬ）
    const afterConflict = await readOnlyDiaperRow(householdId)
    expect(afterConflict.poop_amount).toBe("small")
    expect(afterConflict.memo).toBeNull()
    // B の一覧は記録を外さず、最新版（少量）へ揃っておる。一覧はモーダルのシートの背後
    // （支援技術から隠れる）ゆえ includeHidden で数える
    await expect(
      pageB.getByRole("button", { name: /うんち（少量）/, includeHidden: true })
    ).toHaveCount(1)
    await expect(
      pageB.getByRole("button", { name: /うんち（大量）/, includeHidden: true })
    ).toHaveCount(0)

    // ── 対照: 最新の内容で開き直してから削除すれば通る ─────────────────────
    await sheetB.getByRole("button", { name: "最新の内容で編集し直す" }).click()
    const reopenedB = openSheetOf(pageB)
    await expect(reopenedB.getByRole("alert")).toHaveCount(0, { timeout: 10_000 })
    await reopenedB.getByRole("button", { name: "この記録を削除" }).click()
    await reopenedB.getByRole("button", { name: "削除する" }).click()
    await expect(pageB.getByText("ログを削除しました")).toBeVisible({
      timeout: 15_000,
    })
    await expect(async () => {
      const rows = await readDiaperRows(householdId)
      if (rows.length !== 0)
        throw new Error(`still ${rows.length} rows: ${JSON.stringify(rows)}`)
    }).toPass({ timeout: 15_000 })
  } finally {
    await contextB.close()
    await cleanupUser(family.id)
  }
})

/**
 * 取り消しの版ガード（PR #235 敵対レビュー P1）。
 *
 * A がおしっこを記録 → 記録直後のトーストの「取り消す」を押す前に、家族（別端末）が同じ
 * 記録へメモを足す（service role の UPDATE。trigger が版を進める = 別端末の保存と同じ形）
 * → A の「取り消す」は家族の更新を消さず、DB と今日のまとめに記録が残る
 * → 対照: 誰も触っておらぬ記録の「取り消す」は従来どおり消える。
 *
 * sonner の toast は既定で約 4 秒で消える。製品側の表示時間を延ばして合わせるのは条件の
 * 弱体化ゆえ、toast に hover して（sonner は hover 中のタイマーを止める）その間に撃つ。
 */
test("取り消しの競合: 記録の後に家族が更新していたら「取り消す」は消さず、家族の更新が残る", async ({
  page,
  approvedUser,
}) => {
  const householdId = await createHouseholdAsA(page, approvedUser, "E2E取り消し競合世帯")
  const quickA = page.getByRole("main")
  const summary = page.getByRole("group", { name: "今日のまとめ" })

  // ── A: おしっこを記録し、トーストを hover で留める ──────────────────────
  await quickA.getByRole("button", { name: "おしっこ", exact: true }).click()
  const recordedToast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "おむつ交換を記録しました（おしっこ）" })
  await expect(recordedToast).toBeVisible({ timeout: 15_000 })
  await recordedToast.hover()
  await expect(summary).toContainText("おしっこ1・うんち0")

  let rowId = ""
  await expect(async () => {
    const rows = await readDiaperRows(householdId)
    if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}`)
    rowId = rows[0].id
  }).toPass({ timeout: 15_000 })

  // ── 家族（別端末）が同じ記録を更新する（版が進む）────────────────────────
  const { data: updated, error: updateError } = await adminClient()
    .from("baby_logs")
    .update({ memo: "家族が取り消しの前に足したメモ" })
    .eq("id", rowId)
    .select("id")
    .single()
  if (updateError || !updated)
    throw new Error(`family update failed: ${updateError?.message ?? "0 rows"}`)

  // ── A: 「取り消す」→ 消さず、理由を伝える ─────────────────────────────
  await recordedToast.getByRole("button", { name: "取り消す" }).click()
  await expect(page.getByText(/取り消しませんでした/)).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByText("おむつの記録を取り消しました")).toHaveCount(0)
  const kept = await readDiaperRows(householdId)
  expect(kept).toHaveLength(1)
  expect(kept[0].memo).toBe("家族が取り消しの前に足したメモ")
  // 画面からも外しておらぬ（今日のまとめは 1 のまま）
  await expect(summary).toContainText("おしっこ1・うんち0")
  // sonner は action を押した toast を閉じる。次の記録の toast と取り違えぬよう消えるまで待つ
  await expect(recordedToast).toHaveCount(0, { timeout: 10_000 })

  // ── 対照: 誰も触っておらぬ記録の「取り消す」は従来どおり消える ──────────
  await page.mouse.move(0, 0)
  await quickA.getByRole("button", { name: "おしっこ", exact: true }).click()
  await expect(summary).toContainText("おしっこ2・うんち0", { timeout: 15_000 })
  const secondToast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "おむつ交換を記録しました（おしっこ）" })
  await expect(secondToast).toHaveCount(1, { timeout: 15_000 })
  await secondToast.hover()
  await secondToast.getByRole("button", { name: "取り消す" }).click()
  await expect(page.getByText("おむつの記録を取り消しました")).toBeVisible({
    timeout: 15_000,
  })
  await expect(summary).toContainText("おしっこ1・うんち0")
  await expect(async () => {
    const rows = await readDiaperRows(householdId)
    if (rows.length !== 1 || rows[0].id !== rowId)
      throw new Error(`unexpected rows: ${JSON.stringify(rows)}`)
  }).toPass({ timeout: 15_000 })
})
