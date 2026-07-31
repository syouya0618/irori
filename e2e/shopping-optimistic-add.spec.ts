import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * 買い物リストの「追加」が **Realtime に依存せず** 即座に画面へ出ることを固定する。
 *
 * ## なぜ WebSocket を遮断するのか
 * issue #92（postgres_changes の間欠不達）が未解決のため、追加の反映を Realtime
 * INSERT に頼る実装は「押しても何も出ない回」が本番で発生する。本テストは
 * `page.routeWebSocket()` で Supabase Realtime の WS を**サーバへ繋がずに閉じる**
 * ことで、その「届かぬ回」を決定的に再現し、楽観挿入だけで行が出ることを assert する。
 *
 * ## 遮断が実際に効いたことの検証（偽 green 防止）
 * route パターンが実 URL（ws://127.0.0.1:54321/realtime/v1/websocket?apikey=...）
 * に噛まなければ、Realtime が生きたまま green になり「楽観挿入がある」証拠に
 * ならない。ゆえに handler の発火をフラグで記録し、追加操作の**前に**
 * `expect.poll` で発火済みを確認する。
 *
 * ## リロードしない
 * 他 spec（golden-path 等）は書き込み反映を reload 後の SSR 断面で見るが、
 * 本テストの対象は「リロードせずに出るか」そのものなので reload は禁物。
 */

// 世帯 insert + マジックリンクログイン + production build の cold path を含むため延長
test.setTimeout(90_000)

const ITEM_NAME = "E2E楽観追加ヨーグルト"

/** Supabase error は plain object のため明示的にフィールドを抽出してログする。 */
function formatError(
  error: {
    message?: string
    code?: string
    details?: string
    hint?: string
  } | null,
): string {
  if (!error) return "(no error object)"
  return JSON.stringify({
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
  })
}

test("Realtime 遮断下でも買い物アイテムの追加が即座に画面へ出る", async ({
  page,
  approvedUser,
}) => {
  // ── 1. 世帯を service_role で直 insert し profiles に紐付ける ──
  // （UI の世帯作成は smoke / golden-path が検証済み。ここでは前提データ）
  const admin = adminClient()

  const { data: household, error: householdError } = await admin
    .from("households")
    .insert({ name: "E2E楽観追加世帯" })
    .select("id")
    .single()
  if (householdError || !household) {
    throw new Error(`households insert failed: ${formatError(householdError)}`)
  }

  // .update() は 0 行更新でも error: null のため .select().single() で行数を検証する
  const { data: linked, error: linkError } = await admin
    .from("profiles")
    .update({ household_id: household.id as string, role: "owner" })
    .eq("id", approvedUser.id)
    .select("id")
    .single()
  if (linkError || !linked) {
    throw new Error(`profiles link failed: ${formatError(linkError)}`)
  }

  // ── 2. Realtime の WS を遮断する（ログインより前に登録する）──
  // handler 内で connectToServer() を呼ばないため、この WS はサーバへ一切繋がらない。
  // glob ではなく RegExp で噛ませる（クエリ付き ws:// URL に確実に一致させるため）。
  let wsIntercepted = false
  await page.routeWebSocket(/realtime\/v1/, (ws) => {
    wsIntercepted = true
    ws.close()
  })

  // ── 3. 実ログイン → /shopping ──
  await loginViaMagicLink(page, approvedUser.email)
  await page.goto("/shopping")
  await expect(page.getByRole("heading", { name: "買い物リスト" })).toBeVisible()

  // ── 4. 遮断が実際に発火したことを確認する（噛んでいなければ以降は無意味）──
  // WS はハイドレーション後の useEffect で開かれるため poll で待つ。
  await expect
    .poll(() => wsIntercepted, {
      message: "Realtime の WebSocket が routeWebSocket に噛まなかった",
      timeout: 20_000,
    })
    .toBe(true)

  // ── 5. アイテムを追加（ストアタブは既定の「全て」のまま = フィルタで隠れない）──
  const addInput = page.getByPlaceholder("アイテムを追加...")
  await addInput.fill(ITEM_NAME)
  await page.getByRole("button", { name: "追加", exact: true }).click()

  // 入力欄のクリアは server action 成功の決定的シグナル
  // （= 「追加自体は成功したのに画面へ出ない」を切り分けられる）
  await expect(addInput).toHaveValue("")

  // ── 6. reload せずに一覧へ出る（Realtime は遮断済みゆえ楽観挿入が唯一の経路）──
  await expect(page.getByText(ITEM_NAME, { exact: true })).toBeVisible()
  await expect(page.getByText("残り 1 / 1 件")).toBeVisible()

  // teardown は fixture (approvedUser) が household ごと削除する
})
