import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * ミルクの記録時刻 E2E（2026-10-25「ミルクの入力時に時間を打つと、時刻が変わってしまう」）。
 *
 * login → 世帯作成 → ミルクの行を 2 件、秒・マイクロ秒つきの記録時刻で直接 insert → /baby を再読込
 * → 行 A を開いて量（100）だけを入れて更新 → logged_at は**一字も変わらぬ**・表示の時刻も同じ
 * → 行 A の日付だけを前日へ変えて更新 → logged_at は**秒・ミリ秒を保ったまま** 24 時間前へ
 * → 行 B の開始時刻を打って更新 → logged_at は打った JST 時刻（秒 0）
 * → reload しても打った時刻で表示され、編集シートもその時刻で開く。
 *
 * ## なぜ行を直接 insert するか
 * 検証の対象は記録フォーム（編集シート）の時刻の扱いじゃ。クイック記録で作ると、行の時刻は
 * DB の now() になり秒を決め打ちできぬうえ、クイック記録の導線（別の担当範囲）の変更に
 * この spec が巻き込まれる。service_role で秒・マイクロ秒つきの行を置けば、秒が落ちたかを
 * 確実に見分けられる。
 *
 * ## なぜ DB 断面まで見るか
 * 時刻の表示は分（HH:mm）までしか出ぬ。「量だけの更新で秒が丸められた」「日付だけの更新で
 * 秒が落ちた」は画面では見えぬゆえ、service_role の直読みで logged_at そのものを固定する。
 *
 * ## フレーク対策（baby-feeding-cycle.spec.ts / baby-diaper-amount.spec.ts と同じ流儀）
 * - 時間ベースの sleep は使わず DB 断面を poll して同期する（トーストは同期点にせぬ — 数秒残り、
 *   続く更新で同じ文言が二つ並ぶ）
 * - Sheet の open は openOverlay（退場中シートの消滅を待ってから click）
 * - シート内のロケータは開いているシート（[data-open]）へスコープする
 * - 深夜を跨ぐ窓は skip する（置いた行が「今日」から外れ、検証対象が成立せぬ）
 *
 * ※ ヘルパは既存 spec と重複するが、各 spec が自前で持つ慣習に合わせて in-file 複製にしてある。
 */

test.setTimeout(180_000)

/** 行 A・行 B を置く時刻（今から何分前か）。どちらも今日のうちに収まるよう下のガードで守る */
const ROW_A_MINUTES_AGO = 90
const ROW_B_MINUTES_AGO = 60
/** 行 B の開始時刻を打ち直す先（今から何分前か）。未来にならず、行 A・B と見分けられる値 */
const TYPED_MINUTES_AGO = 75

/**
 * 深夜跨ぎで skip する JST の窓（分）。置く行（最大 90 分前）が前日へ落ちる窓と、テストの
 * 途中で日付が変わりうる窓を避ける。
 */
const MIDNIGHT_GUARD_START_MINUTES = ROW_A_MINUTES_AGO + 15
const MIDNIGHT_GUARD_END_MINUTES = 23 * 60 + 45

const DAY_MS = 24 * 60 * 60 * 1000

const JST_YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})
const JST_HM = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/** JST の「その日の何分目か」（00:00 = 0）。深夜跨ぎガードの判定に使う。 */
function jstMinutesOfDay(): number {
  const [h, m] = JST_HM.format(new Date()).split(":").map(Number)
  return h * 60 + m
}

/**
 * `minutesAgo` 分前の時刻を、秒 31・マイクロ秒 123456 に揃えた PostgREST 表記で返す
 * （「秒が落ちた」「ミリ秒より下が丸められた」を見分けられる値）。
 */
function loggedAtWithSeconds(minutesAgo: number): string {
  const at = new Date(Date.now() - minutesAgo * 60_000)
  at.setUTCSeconds(31, 123)
  return at.toISOString().replace("Z", "456+00:00")
}

/** reload し、Supabase Realtime の WebSocket 接続まで待つ（listener は reload 前に張る）。 */
async function reloadHydrated(page: Page): Promise<void> {
  const ws = page.waitForEvent("websocket", { timeout: 20_000 })
  await page.reload()
  await ws
}

/** Sheet / Dialog を決定的に開く（calendar.spec.ts / baby-feeding-cycle.spec.ts と同一実装）。 */
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

/** 開いているシートの「更新する」を押し、シートが消えるまで待つ（DB 断面の poll の前段）。 */
async function submitOpenSheet(page: Page, openSheet: Locator): Promise<void> {
  await openSheet.getByRole("button", { name: "更新する" }).click()
  await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0, {
    timeout: 10_000,
  })
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

interface BottleRow {
  id: string
  logged_at: string
  amount_ml: number | null
  updated_at: string
}

/** ミルク行を 1 件置き、DB が返した行を返す（記録者は承認済みの利用者本人） */
async function insertBottleRow(
  householdId: string,
  userId: string,
  loggedAt: string
): Promise<BottleRow> {
  const { data, error } = await adminClient()
    .from("baby_logs")
    .insert({
      household_id: householdId,
      logged_by: userId,
      log_type: "feeding",
      feeding_type: "bottle",
      logged_at: loggedAt,
    })
    .select("id, logged_at, amount_ml, updated_at")
    .single()
  if (error) throw new Error(`baby_logs insert failed: ${error.message}`)
  return data as BottleRow
}

/** id の行が `ready` を満たすのを DB 断面で待って返す */
async function waitForRow(
  id: string,
  ready: (row: BottleRow) => boolean
): Promise<BottleRow> {
  const admin = adminClient()
  const captured: BottleRow[] = []
  await expect(async () => {
    const { data, error } = await admin
      .from("baby_logs")
      .select("id, logged_at, amount_ml, updated_at")
      .eq("id", id)
      .single()
    if (error) throw new Error(`baby_logs lookup failed: ${error.message}`)
    if (!ready(data as BottleRow)) throw new Error("row not updated yet")
    captured.length = 0
    captured.push(data as BottleRow)
  }).toPass({ timeout: 15_000 })
  return captured[0]
}

test("ミルクの記録時刻: 量だけの更新で変わらず、日付だけの更新で秒を保ち、打った時刻はそのまま残る", async ({
  page,
  approvedUser,
}) => {
  const minutes = jstMinutesOfDay()
  test.skip(
    minutes < MIDNIGHT_GUARD_START_MINUTES || minutes >= MIDNIGHT_GUARD_END_MINUTES,
    "深夜を跨ぐ窓では置いた行が「今日」から外れ、記録時刻の検証が成立せぬ"
  )

  // ── 1. login → 世帯作成 → /baby ─────────────────────────────────────
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2Eミルク時刻世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(approvedUser.id)

  // ── 2. 秒・マイクロ秒つきのミルク行を 2 件置き、再読込で DB の断面から描く ──
  const rowA = await insertBottleRow(
    householdId,
    approvedUser.id,
    loggedAtWithSeconds(ROW_A_MINUTES_AGO)
  )
  const rowB = await insertBottleRow(
    householdId,
    approvedUser.id,
    loggedAtWithSeconds(ROW_B_MINUTES_AGO)
  )
  const hmA = JST_HM.format(new Date(rowA.logged_at))
  const hmB = JST_HM.format(new Date(rowB.logged_at))
  await reloadHydrated(page)

  const openSheet = page.locator('[data-slot="sheet-content"][data-open]')
  // タイムラインの行は名前が「HH:MM ミルク…」で始まる（クイック記録の釦「ミルク」とは先頭の時刻で
  // 見分ける）。時刻つきで引けば行 A・B を取り違えぬ
  const rowAt = (hm: string) =>
    page.getByRole("button", { name: new RegExp(`^${hm}.*ミルク`) })
  await expect(rowAt(hmA)).toHaveCount(1, { timeout: 15_000 })
  await expect(rowAt(hmB)).toHaveCount(1)

  // ── 3. 行 A: 量だけを入れて更新 → logged_at は一字も変わらぬ ─────────
  await openOverlay(rowAt(hmA), page.getByRole("heading", { name: "授乳を編集" }))
  await expect(openSheet.getByLabel("開始時刻")).toHaveValue(hmA)
  await openSheet.getByRole("button", { name: "100", exact: true }).click()
  await submitOpenSheet(page, openSheet)
  const amountOnly = await waitForRow(rowA.id, (r) => r.amount_ml === 100)
  // 送っておらぬ列は DB の値のまま（HH:mm 丸めで秒・マイクロ秒を落とさぬ）
  expect(amountOnly.logged_at).toBe(rowA.logged_at)
  await expect(rowAt(hmA)).toContainText("100ml")

  // ── 4. 行 A: 日付だけを前日へ → 秒・ミリ秒を保ったまま 24 時間前 ─────
  await openOverlay(rowAt(hmA), page.getByRole("heading", { name: "授乳を編集" }))
  const yesterday = JST_YMD.format(new Date(new Date(rowA.logged_at).getTime() - DAY_MS))
  await openSheet.getByLabel("日付").fill(yesterday)
  await submitOpenSheet(page, openSheet)
  const moved = await waitForRow(rowA.id, (r) => r.updated_at !== amountOnly.updated_at)
  // ミリ秒まで一致（ブラウザの Date を経由するゆえ、マイクロ秒の 456 は落ちてよい）
  expect(new Date(moved.logged_at).getTime()).toBe(
    new Date(rowA.logged_at).getTime() - DAY_MS
  )
  expect(new Date(moved.logged_at).getUTCSeconds()).toBe(31)
  expect(JST_YMD.format(new Date(moved.logged_at))).toBe(yesterday)
  // 前日へ動いた行は今日のタイムラインから消える
  await expect(rowAt(hmA)).toHaveCount(0, { timeout: 15_000 })

  // ── 5. 行 B: 開始時刻を打って更新 → 打った JST 時刻（秒 0）で保存 ────
  const typedHm = JST_HM.format(new Date(Date.now() - TYPED_MINUTES_AGO * 60_000))
  const today = JST_YMD.format(new Date(rowB.logged_at))
  await openOverlay(rowAt(hmB), page.getByRole("heading", { name: "授乳を編集" }))
  await expect(openSheet.getByLabel("開始時刻")).toHaveValue(hmB)
  await openSheet.getByLabel("開始時刻").fill(typedHm)
  await submitOpenSheet(page, openSheet)
  const typed = await waitForRow(rowB.id, (r) => r.updated_at !== rowB.updated_at)
  expect(new Date(typed.logged_at).getTime()).toBe(
    new Date(`${today}T${typedHm}:00+09:00`).getTime()
  )
  await expect(rowAt(typedHm)).toHaveCount(1, { timeout: 15_000 })

  // ── 6. reload しても打った時刻で表示され、編集シートもその時刻で開く ──
  await reloadHydrated(page)
  await expect(rowAt(typedHm)).toHaveCount(1, { timeout: 15_000 })
  await openOverlay(rowAt(typedHm), page.getByRole("heading", { name: "授乳を編集" }))
  await expect(openSheet.getByLabel("開始時刻")).toHaveValue(typedHm)

  // ── 7. teardown は fixtures/test.ts の approvedUser が世帯ごと削除 ──
})
