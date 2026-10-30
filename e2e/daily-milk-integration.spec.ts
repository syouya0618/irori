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
 * 夫婦の 1 日（統合 E2E）。いつものミルク量（A）・ミルクの記録時刻（B）を、一続きの利用で固定する。
 * 個々の機能の網羅は baby-bottle-default.spec.ts / baby-feeding-time.spec.ts が持ち、ここは
 * **機能の継ぎ目**だけを見る。
 *
 * 妻: いつもの量を 120ml に決める（記録はせぬ）
 * 夫: 同じ世帯の別端末で 120ml が見える
 * 妻: ミルクを 1 タップ → 画面の行の時刻と量が DB の行と一致する（楽観行は DB の記録時刻で組む）
 * 夫: 再読込で同じ時刻・同じ量の行が見える
 * 妻: その行の量だけを 100 に直す → logged_at は一字も変わらず、どちらの端末でも時刻は動かぬ
 * 妻: 前の日に、開始時刻 08:30 で量を入れ、入力の途中で量を変える → 時刻も日付も動かぬまま保存される
 * 夫: その日を開くと 08:30・同じ量で見える
 * 妻: いつもの量を 160ml へ → 過去の行の量は変わらず、夫の端末も開き直すと 160ml
 * 妻: 認証が切れた端末でミルクを押す → 成功と表示せず、行も増えぬ
 * 別の世帯: 妻の量も記録も見えぬ
 *
 * ## なぜ DB 断面まで見るか
 * 楽観反映のせいで、画面は DB と違っても同じに見えうる（2026-10-25 のミルク時刻の報告がそれ）。
 * ゆえに画面の時刻・量は service_role で直読みした行から組んだ期待値と突き合わせる。
 *
 * ## フレーク対策（既存の baby 系 spec と同じ流儀。ヘルパは慣習どおり in-file 複製）
 * - 時間ベースの sleep は使わず DB 断面を poll して同期する
 * - Sheet の open は openOverlay（退場中シートの消滅を待ってから click）
 * - 深夜を跨ぐ窓は skip する（「今日」「前の日」が途中で入れ替わる）
 */

test.setTimeout(300_000)

/** 前の日に記録する開始時刻（JST）。どの時刻に走っても「前の日」の過去ゆえ未来にならぬ */
const PAST_DAY_HM = "08:30"
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

/** Sheet / Dialog を決定的に開く（baby-diaper-amount.spec.ts と同一実装）。 */
async function openOverlay(trigger: Locator, readySignal: Locator): Promise<void> {
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

function openSheetOf(page: Page): Locator {
  return page.locator('[data-slot="sheet-content"][data-open]')
}

/** タイムラインの行（名前が「HH:MM ミルク…」で始まる。クイック記録の釦「ミルク」とは時刻で見分ける） */
function milkRowAt(page: Page, hm: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${hm}.*ミルク`) })
}

/** reload し、Supabase Realtime の WebSocket 接続まで待つ（baby-feeding-time.spec.ts と同一実装）。 */
async function reloadHydrated(page: Page): Promise<void> {
  const ws = page.waitForEvent("websocket", { timeout: 20_000 })
  await page.reload()
  await ws
}

/** 承認済みの利用者の世帯 ID を DB 断面で待つ（世帯作成 server action の完了同期点）。 */
async function waitForHouseholdId(userId: string): Promise<string> {
  let householdId = ""
  await expect(async () => {
    const { data: profile, error } = await adminClient()
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

/** login → 世帯作成 → /baby。世帯 ID を返す。 */
async function createHousehold(
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
  await expect(page.getByRole("group", { name: "今日のまとめ" })).toBeVisible({
    timeout: 15_000,
  })
  return householdId
}

interface BottleRow {
  id: string
  logged_at: string
  amount_ml: number | null
  updated_at: string
}

/** 世帯のミルク行が `expectedCount` 件になるのを DB 断面で待ち、記録時刻の順に返す（二重記録も同時に固定）。 */
async function waitForBottleRows(
  householdId: string,
  expectedCount: number
): Promise<BottleRow[]> {
  const captured: BottleRow[] = []
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("baby_logs")
      .select("id, logged_at, amount_ml, updated_at")
      .eq("household_id", householdId)
      .eq("log_type", "feeding")
      .eq("feeding_type", "bottle")
      .order("logged_at", { ascending: true })
    if (error) throw new Error(`baby_logs lookup failed: ${error.message}`)
    if (!data || data.length !== expectedCount)
      throw new Error(`expected ${expectedCount} bottle rows, got ${data?.length ?? 0}`)
    captured.length = 0
    captured.push(...(data as BottleRow[]))
  }).toPass({ timeout: 15_000 })
  return captured
}

/** id の行が `ready` を満たすのを DB 断面で待って返す */
async function waitForRow(id: string, ready: (row: BottleRow) => boolean): Promise<BottleRow> {
  const captured: BottleRow[] = []
  await expect(async () => {
    const { data, error } = await adminClient()
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

/** 世帯のいつものミルク量（DB）が `expected` になるのを待つ。 */
async function waitForBottleDefault(householdId: string, expected: number | null): Promise<void> {
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("households")
      .select("bottle_default_ml")
      .eq("id", householdId)
      .single()
    if (error) throw new Error(`households lookup failed: ${error.message}`)
    if (data?.bottle_default_ml !== expected)
      throw new Error(`bottle_default_ml is ${data?.bottle_default_ml}, expected ${expected}`)
  }).toPass({ timeout: 15_000 })
}

/** 手で作った context は fixtures/test.ts の page fixture を通らぬ（初回ツアーを抑止する）。 */
async function suppressTour(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("irori:tour-seen:v1", "1")
    } catch {
      /* localStorage 不可環境でも E2E を止めない */
    }
  })
}

test("夫婦の 1 日: 妻が決めた量で記録し、量を直しても時刻は動かず、夫の端末でも同じに見える", async ({
  page,
  approvedUser,
  browser,
}, testInfo) => {
  const minutes = jstMinutesOfDay()
  test.skip(
    minutes < 20 || minutes >= 23 * 60 + 40,
    "深夜を跨ぐ窓では「今日」「前の日」が途中で入れ替わり、検証が成立せぬ"
  )

  // ── 1. 妻: 世帯を作り、いつもの量を 120ml に決める（量だけ。記録はせぬ）──────
  const householdId = await createHousehold(page, approvedUser, "E2E夫婦の1日世帯")
  const wifeMain = page.getByRole("main")
  const wifeMilk = wifeMain.getByRole("button", { name: "ミルク", exact: true })
  await openOverlay(
    wifeMain.getByRole("button", { name: "ミルクの量を設定" }),
    page.getByRole("heading", { name: "いつものミルク量" })
  )
  await openSheetOf(page).getByLabel("1回の量（ml）").fill("120")
  await openSheetOf(page).getByRole("button", { name: "保存する" }).click()
  await waitForBottleDefault(householdId, 120)
  await expect(wifeMain.getByTestId("bottle-default-amount")).toHaveText("120ml")
  // 量を決めただけで記録は増えぬ
  await waitForBottleRows(householdId, 0)

  const husband = await createApprovedUser(`husband-${uniqueEmail(testInfo.workerIndex)}`)
  const stranger = await createApprovedUser(`stranger-${uniqueEmail(testInfo.workerIndex)}`)
  let strangerHouseholdId: string | undefined
  const husbandContext = await browser.newContext()
  const strangerContext = await browser.newContext()
  try {
    // ── 2. 夫: 同じ世帯に入り、別端末の /baby で 120ml が見える ─────────────
    const { data: joined, error: joinError } = await adminClient()
      .from("profiles")
      .update({ household_id: householdId, role: "member" })
      .eq("id", husband.id)
      .select("id")
      .single()
    if (joinError || !joined)
      throw new Error(`husband join failed: ${joinError?.message ?? "0 rows"}`)
    const husbandPage = await husbandContext.newPage()
    await suppressTour(husbandPage)
    await loginViaMagicLink(husbandPage, husband.email)
    await husbandPage.goto("/baby")
    const husbandMain = husbandPage.getByRole("main")
    await expect(husbandMain.getByTestId("bottle-default-amount")).toHaveText("120ml", {
      timeout: 15_000,
    })

    // ── 3. 妻: ミルクを 1 タップ。画面の行は DB の行と同じ時刻・同じ量 ─────────
    await expect(wifeMilk).toBeEnabled({ timeout: 15_000 })
    await wifeMilk.click()
    // トーストは数秒で消えるゆえ、押した直後に確かめる
    await expect(page.getByText("授乳を記録しました（ミルク 120ml）")).toBeVisible({
      timeout: 15_000,
    })
    let rows = await waitForBottleRows(householdId, 1)
    const quick = rows[0]
    expect(quick.amount_ml).toBe(120)
    const quickHm = JST_HM.format(new Date(quick.logged_at))
    // 再読込の前（楽観行）から DB の記録時刻で出る — 端末時計で組むと分を跨いだ時にずれる
    await expect(milkRowAt(page, quickHm)).toHaveCount(1, { timeout: 15_000 })
    await expect(milkRowAt(page, quickHm)).toContainText("120ml")

    // ── 4. 夫: 再読込で同じ時刻・同じ量の行が見える ───────────────────────
    await reloadHydrated(husbandPage)
    await expect(milkRowAt(husbandPage, quickHm)).toHaveCount(1, { timeout: 15_000 })
    await expect(milkRowAt(husbandPage, quickHm)).toContainText("120ml")

    // ── 5. 妻: その行の量だけを 100 に直す → 記録時刻は一字も変わらぬ ───────────
    await openOverlay(milkRowAt(page, quickHm), page.getByRole("heading", { name: "授乳を編集" }))
    await expect(openSheetOf(page).getByLabel("開始時刻")).toHaveValue(quickHm)
    await openSheetOf(page).getByLabel("量 (ml)").fill("100")
    await expect(openSheetOf(page).getByLabel("開始時刻")).toHaveValue(quickHm)
    await openSheetOf(page).getByRole("button", { name: "更新する" }).click()
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0, { timeout: 10_000 })
    const edited = await waitForRow(quick.id, (r) => r.amount_ml === 100)
    expect(edited.logged_at).toBe(quick.logged_at)
    await expect(milkRowAt(page, quickHm)).toContainText("100ml")
    await reloadHydrated(husbandPage)
    await expect(milkRowAt(husbandPage, quickHm)).toContainText("100ml", { timeout: 15_000 })

    // ── 6. 妻: 前の日に 08:30 で入れ、入力の途中で量を変えても時刻・日付は動かぬ ───
    const yesterday = JST_YMD.format(new Date(Date.now() - DAY_MS))
    await expect(wifeMilk).toBeEnabled({ timeout: 15_000 })
    await page.getByRole("button", { name: "前の日" }).click()
    const pastDay = page.getByRole("region", { name: "この日の記録を追加" })
    await expect(pastDay).toBeVisible({ timeout: 15_000 })
    await openOverlay(
      pastDay.getByRole("button", { name: "授乳" }),
      page.getByRole("heading", { name: "授乳を記録" })
    )
    const createSheet = openSheetOf(page)
    await expect(createSheet.getByLabel("日付")).toHaveValue(yesterday)
    await createSheet.getByRole("button", { name: "ミルク", exact: true }).click()
    await createSheet.getByLabel("開始時刻").fill(PAST_DAY_HM)
    await createSheet.getByLabel("量 (ml)").fill("120")
    await expect(createSheet.getByLabel("開始時刻")).toHaveValue(PAST_DAY_HM)
    await createSheet.getByLabel("量 (ml)").fill("140")
    await expect(createSheet.getByLabel("開始時刻")).toHaveValue(PAST_DAY_HM)
    await expect(createSheet.getByLabel("日付")).toHaveValue(yesterday)
    await createSheet.getByRole("button", { name: "記録する" }).click()
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0, { timeout: 10_000 })
    rows = await waitForBottleRows(householdId, 2)
    const past = rows[0]
    expect(new Date(past.logged_at).getTime()).toBe(
      new Date(`${yesterday}T${PAST_DAY_HM}:00+09:00`).getTime()
    )
    expect(past.amount_ml).toBe(140)
    await expect(milkRowAt(page, PAST_DAY_HM)).toContainText("140ml", { timeout: 15_000 })
    // 画面の再表示: 日付の移動は URL に載らぬ（再読込は今日へ戻る）ゆえ、その日の URL を開き直す
    await page.goto(`/baby?date=${yesterday}`)
    await expect(milkRowAt(page, PAST_DAY_HM)).toContainText("140ml", { timeout: 15_000 })

    // ── 7. 夫: その日を開くと 08:30・140ml で見える ─────────────────────────
    await husbandPage.goto(`/baby?date=${yesterday}`)
    await expect(milkRowAt(husbandPage, PAST_DAY_HM)).toContainText("140ml", {
      timeout: 15_000,
    })

    // ── 8. 妻: いつもの量を 160ml へ。過去の行は変わらず、夫の端末も 160ml ──────────
    await page.goto("/baby")
    await expect(wifeMilk).toBeEnabled({ timeout: 15_000 })
    await openOverlay(
      wifeMain.getByRole("button", { name: "ミルクの量を変更" }),
      page.getByRole("heading", { name: "いつものミルク量" })
    )
    await openSheetOf(page).getByLabel("1回の量（ml）").fill("160")
    await openSheetOf(page).getByRole("button", { name: "保存する" }).click()
    await waitForBottleDefault(householdId, 160)
    rows = await waitForBottleRows(householdId, 2)
    expect(rows.map((r) => [r.amount_ml, r.logged_at])).toEqual([
      [140, past.logged_at],
      [100, quick.logged_at],
    ])
    // 画面復帰での取り直しは baby-bottle-default.spec.ts が持つ。ここは開き直した時の値だけを見る
    await husbandPage.goto("/baby")
    await expect(husbandMain.getByTestId("bottle-default-amount")).toHaveText("160ml", {
      timeout: 15_000,
    })

    // ── 9. 妻: 認証が切れた端末でミルク → 成功と表示せず、行も増えぬ ─────────────
    await expect(wifeMilk).toBeEnabled({ timeout: 15_000 })
    await page.context().clearCookies()
    await wifeMilk.click()
    // 何かしらの失敗の知らせ（文言は経路で変わる: Action まで届けば「認証されていません」、proxy の 307 を
    // 経て Action が例外になれば結果不明の「保存できたか確認できていません」（2026-10-27 大型更新 A2。
    // 例外を「通信できませんでした」= 保存されておらぬとは決めつけぬ）、他の経路は「通信できませんでした」）
    // か、ログインへの遷移。無言で何も起きぬのも不可
    await expect(async () => {
      const failed = await page
        .getByText(/通信できませんでした|認証されていません|ミルク 160mlを保存できたか確認できていません/)
        .count()
      const onLogin = /\/login/.test(page.url())
      expect(failed > 0 || onLogin).toBe(true)
    }).toPass({ timeout: 20_000 })
    // 合否の本体は不変条件: 成功と表示せず、取り消しの帯も出さず、行も増えぬ
    await expect(page.getByText("授乳を記録しました（ミルク 160ml）")).toHaveCount(0)
    await expect(page.getByTestId("inline-undo")).toHaveCount(0)
    await waitForBottleRows(householdId, 2)

    // ── 10. 別の世帯: 妻の量も記録も見えぬ ────────────────────────────────
    const strangerPage = await strangerContext.newPage()
    await suppressTour(strangerPage)
    strangerHouseholdId = await createHousehold(strangerPage, stranger, "E2E別の世帯")
    expect(strangerHouseholdId).not.toBe(householdId)
    const strangerMain = strangerPage.getByRole("main")
    await expect(strangerMain.getByTestId("bottle-default-amount")).toHaveText("量を設定")
    await expect(
      strangerPage.getByRole("button", { name: /^\d\d:\d\d.*ミルク/ })
    ).toHaveCount(0)
  } finally {
    await husbandContext.close()
    await strangerContext.close()
    // 夫は妻の世帯の行を参照しておるゆえ、妻の世帯の掃除（fixture）より先に消す
    await cleanupUser(husband.id)
    await cleanupUser(stranger.id, strangerHouseholdId)
  }
})
