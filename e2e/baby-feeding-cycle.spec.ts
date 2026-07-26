import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * 母乳サイクル記録 E2E（feeding_type='breast' + 左右の吸わせ回数）。
 *
 * login → 世帯作成 → /baby → 授乳クイックアクション「左」→ タイマーシート
 * → 「手動入力」へ切替 → 左の回数を +1（左2）→ 1 分を選択 → 記録する
 * → タイムラインに「母乳 左2 1分」→ 今日のまとめの授乳チップに「母乳1」
 * → 記録行をタップ → 編集シートに左右回数ステッパーが seed 済みで出る
 *
 * ## なぜ DB 断面まで見るか（UI だけでは核心が検証できない）
 * 本変更の中核は「授乳行の logged_at の意味を終了時刻 → **開始時刻** へ統一した」
 * ことだが、UI の表示（母乳 / 左2 / 母乳1 / ステッパーの seed）は**どちらの意味でも
 * 同一に通る**。ゆえに logged_at ≒ 記録時刻 − 授乳時間 であることを service_role の
 * 直読みで固定する。手動入力を 1 分（60 秒）にしてあるのは、開始時刻と終了時刻を
 * 60 秒の差で判別可能にするため（下の SLACK_MS より十分大きい）。
 *
 * ## フレーク対策の方針（golden-path / calendar と同じ流儀）
 * - 時間ベースの sleep は使わない。書き込み完了は DB 断面を poll して同期する
 *   （Sonner のトーストは自動で消えるため同期点にしない）
 * - reload 後の click はハイドレーション完了を待ってから（reloadHydrated）
 * - Sheet の open は openOverlay（退場中シートの消滅を待ってから click）
 * - シート内のロケータは必ず開いているシート（[data-open]）へスコープする。
 *   `aria-label="左の回数"` はタイマーシート（feeding-timer.tsx）と編集シート
 *   （baby-log-form-sheet.tsx）の両方に存在し、Base UI は close 後も exit
 *   transition 中（~200ms）旧 Popup を DOM に残すため、無スコープだと
 *   strict mode 違反 / 死にゆくシートの値の読み取りになる
 *
 * ※ todayJst / reloadHydrated / openOverlay の各ヘルパは既存スペックと重複するが、
 *   本タスクの制約（新規ファイル1本のみ・既存ファイル変更禁止）と、各 spec が
 *   自前で持つ既存の慣習に合わせて in-file 複製にしてある。
 */

// 1 テストに login（Mailpit 往復）+ full load + server action 往復が含まれるため、
// CI の cold path を考慮して上限を引き上げる（成功時の所要時間には影響しない）
test.setTimeout(180_000)

/** 手動入力で選ぶ授乳時間（分）。開始時刻 vs 終了時刻の判別幅でもある。 */
const MANUAL_MINUTES = 1
const MANUAL_DURATION_SEC = MANUAL_MINUTES * 60

/**
 * logged_at の許容誤差（ミリ秒）。クリック → Server Action → DB 書き込みの
 * 往復ぶんの揺れを吸収する。MANUAL_DURATION_SEC * 1000 (=60s) より十分小さく、
 * 「開始時刻ではなく終了時刻が入っている」回帰は必ず境界外に出る。
 */
const SLACK_MS = 5_000

/**
 * 深夜跨ぎで skip する JST 時刻の閾値（分）。手動入力の logged_at は
 * 「記録時刻 − 授乳時間」ゆえ、JST 00:00 直後に記録すると開始時刻が**前日**になる。
 * その行は仕様どおり前日として保存され（トーストが「前日の記録として保存」になる）、
 * 今日のタイムライン / 今日のまとめには出ない = 本テストの検証対象が成立しない。
 * 実害のある窓は最初の 1 分だけだが、記録後の DB poll / reload も含めて余裕を取る。
 */
const MIDNIGHT_GUARD_MINUTES = 5

/** 「今日」(Asia/Tokyo) の YYYY-MM-DD。playwright.config の timezoneId と一致。 */
function todayJst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

/** JST の「その日の何分目か」（00:00 = 0）。深夜跨ぎガードの判定に使う。 */
function jstMinutesOfDay(): number {
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date())
  const [h, m] = hm.split(":").map(Number)
  return h * 60 + m
}

/**
 * reload し、Supabase Realtime の WebSocket 接続まで待つ。
 * 必ず reload 前に listener を張る（reload 完了後に張ると、速いマシンでは
 * 接続イベントを取り逃して waitForEvent がタイムアウトする）。
 */
async function reloadHydrated(page: Page): Promise<void> {
  const ws = page.waitForEvent("websocket", { timeout: 20_000 })
  await page.reload()
  await ws
}

/**
 * Sheet / Dialog を決定的に開く（calendar.spec.ts と同一実装）。
 * Base UI Dialog は close 後も exit transition 中（~200ms）旧 Popup を DOM に残す
 * （data-open が外れ data-closed/data-ending-style が付く）。opacity フェード中の
 * 旧シートは isVisible() では true のため、退場中シートの消滅を待ってから開く。
 */
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

interface BreastRow {
  feeding_type: string | null
  breast_left_count: number | null
  breast_right_count: number | null
  duration_sec: number | null
  duration_min: number | null
  logged_at: string
}

/**
 * 母乳サイクル行（feeding_type='breast'）が 1 件書かれるのを DB 断面で待つ。
 * トーストではなくこれを記録完了の同期点にする（reload が進行中の server action を
 * 中断して SSR assert が落ちるレースを防ぐ。golden-path の waitForMealRow と同方針）。
 */
async function waitForBreastRow(householdId: string): Promise<BreastRow> {
  const admin = adminClient()
  // 配列に詰めるのは型の都合（let + null 初期化だと toPass のコールバック内の
  // 代入が TS の制御フロー解析に見えず、返却時に null へ絞られてしまうため）。
  const captured: BreastRow[] = []
  await expect(async () => {
    const { data, error } = await admin
      .from("baby_logs")
      .select(
        "feeding_type, breast_left_count, breast_right_count, duration_sec, duration_min, logged_at"
      )
      .eq("household_id", householdId)
      .eq("log_type", "feeding")
      .eq("feeding_type", "breast")
    if (error) throw new Error(`baby_logs lookup failed: ${error.message}`)
    if (!data || data.length === 0) throw new Error("breast row not in DB yet")
    // 二重記録（#92 下の再タップ等）が起きていないことも同時に固定する
    if (data.length > 1)
      throw new Error(`expected 1 breast row, got ${data.length}`)
    captured.length = 0
    captured.push(data[0] as BreastRow)
  }).toPass({ timeout: 15_000 })

  const row = captured[0]
  if (!row) throw new Error("breast row was not captured")
  return row
}

test("母乳サイクル: 手動入力で左2回を記録 → タイムライン・今日のまとめ・編集シートへ反映", async ({
  page,
  approvedUser,
}) => {
  // ── 1. login（Mailpit マジックリンク）→ 世帯作成 → /baby ─────────────
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E母乳サイクル世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/meals/, { timeout: 15_000 })

  const householdId = await waitForHouseholdId(approvedUser.id)

  await page.getByRole("link", { name: "育児" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })

  // 記録前の授乳チップは「0回」（種別内訳が全ゼロのときの退避表示）
  const todaySummary = page.getByRole("group", { name: "今日のまとめ" })
  await expect(todaySummary).toContainText("0回", { timeout: 15_000 })

  // ── 2. 授乳クイックアクション「左」→ タイマーシートが開く ─────────────
  // 母乳（左/右）はタイマー導線（baby-quick-actions.tsx handleFeedingOption）。
  const timerTitle = page.getByRole("heading", { name: "授乳を記録" })
  await openOverlay(
    page.getByRole("button", { name: "左", exact: true }),
    timerTitle
  )

  // 開いているシートへスコープする（閉じかけの旧シートを掴まないため）。
  // Locator は遅延評価ゆえ、後段の編集シートにも同じ変数を使い回せる。
  const openSheet = page.locator('[data-slot="sheet-content"][data-open]')

  // ── 3. 「手動入力」へ切替 → 左の回数を +1（左2）─────────────────────
  await openSheet.getByRole("button", { name: "手動入力" }).click()

  const leftCount = openSheet.locator('[aria-label="左の回数"]')
  const rightCount = openSheet.locator('[aria-label="右の回数"]')
  // 開始側（左）は 1 回で seed される（seedCycle）。ここが 1 でないと以降の
  // 「左2」は別要因（クリック取りこぼし等）ゆえ、先に seed 値を固定する。
  await expect(leftCount).toHaveText("1")
  await expect(rightCount).toHaveText("0")

  await openSheet.getByRole("button", { name: "左の回数を1増やす" }).click()
  await expect(leftCount).toHaveText("2")
  await expect(rightCount).toHaveText("0")

  // ── 4. 授乳時間（分）を選択 → 記録する ──────────────────────────────
  await openSheet
    .getByLabel("分", { exact: true })
    .selectOption(String(MANUAL_MINUTES))

  // 深夜跨ぎガード（定数コメント参照）。prologue で時間が経つため、判定は
  // 「記録クリックの直前」で行う（テスト開始時の判定では窓がずれる）。
  test.skip(
    jstMinutesOfDay() < MIDNIGHT_GUARD_MINUTES,
    `JST 00:00〜00:0${MIDNIGHT_GUARD_MINUTES} は手動入力の開始時刻が前日になり、今日のタイムライン反映を検証できない`
  )

  const beforeMs = Date.now()
  await openSheet.getByRole("button", { name: "記録する" }).click()

  // 内訳つきトースト。閉じ括弧まで含めて一致させることで、深夜跨ぎ分岐
  // （「…（左2・1分／前日の記録として保存）」）と取り違えない。
  await expect(
    page.getByText(`授乳を記録しました（左2・${MANUAL_MINUTES}分）`)
  ).toBeVisible({ timeout: 15_000 })
  const afterMs = Date.now()

  // ── 5. DB 断面: 左右回数・秒数・**開始時刻**の logged_at ────────────────
  const row = await waitForBreastRow(householdId)
  expect(row.feeding_type).toBe("breast")
  expect(row.breast_left_count).toBe(2)
  expect(row.breast_right_count).toBe(0)
  expect(row.duration_sec).toBe(MANUAL_DURATION_SEC)
  // duration_min は duration_sec からの派生（後方互換列）
  expect(row.duration_min).toBe(MANUAL_MINUTES)

  // logged_at は「記録時刻 − 授乳時間」= サイクルの開始時刻。終了時刻（記録時刻）が
  // 入る旧セマンティクスへの回帰は 60 秒ぶんずれるため、この境界で必ず落ちる。
  const loggedAtMs = new Date(row.logged_at).getTime()
  expect(loggedAtMs).toBeGreaterThanOrEqual(
    beforeMs - MANUAL_DURATION_SEC * 1000 - SLACK_MS
  )
  expect(loggedAtMs).toBeLessThanOrEqual(
    afterMs - MANUAL_DURATION_SEC * 1000 + SLACK_MS
  )
  // 念のため「今日（JST）の記録」であることも固定する（前日へ落ちていない）
  expect(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(row.logged_at))
  ).toBe(todayJst())

  // ── 6. 楽観反映（Realtime を待たない即時表示）────────────────────────
  const feedingRow = page.getByRole("button", { name: /母乳/ })
  await expect(feedingRow).toBeVisible({ timeout: 15_000 })
  await expect(feedingRow).toContainText("左2")
  await expect(feedingRow).toContainText(`${MANUAL_MINUTES}分`)
  await expect(todaySummary).toContainText("母乳1")

  // ── 7. reload して SSR 断面でも同じ表示になる（永続化の確認）───────────
  await reloadHydrated(page)
  await expect(feedingRow).toBeVisible({ timeout: 15_000 })
  await expect(feedingRow).toContainText("左2")
  await expect(todaySummary).toContainText("母乳1")

  // ── 8. 記録行をタップ → 編集シートに左右回数ステッパーが seed 済みで出る ──
  await openOverlay(feedingRow, page.getByRole("heading", { name: "授乳を編集" }))

  // 「母乳」が選択肢として出ている（新規/編集とも breast を選べる）
  await expect(
    openSheet.getByRole("button", { name: "母乳", exact: true })
  ).toBeVisible()
  // ステッパーは DB の値で seed される（0 を falsy 扱いして 1 に化けない）
  await expect(openSheet.locator('[aria-label="左の回数"]')).toHaveText("2")
  await expect(openSheet.locator('[aria-label="右の回数"]')).toHaveText("0")
  // 記録した授乳時間も編集入力へ seed される（duration_sec の往復）
  await expect(openSheet.getByLabel("時間（分）", { exact: true })).toHaveValue(
    String(MANUAL_MINUTES)
  )
  await expect(openSheet.getByLabel("時間（秒）", { exact: true })).toHaveValue(
    "0"
  )

  // ── 9. teardown は fixtures/test.ts の approvedUser が世帯ごと削除 ──
})
