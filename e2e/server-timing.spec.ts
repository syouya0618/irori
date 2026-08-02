import { test, expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"

/** navigation entry からブラウザがパース済みの Server-Timing を取り出す */
async function readServerTiming(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType(
      "navigation",
    )[0] as PerformanceNavigationTiming & {
      serverTiming?: readonly PerformanceServerTiming[]
    }
    return (nav.serverTiming ?? []).map((t) => ({
      name: t.name,
      duration: t.duration,
    }))
  })
}

/**
 * `Server-Timing` が**実ブラウザに届き、ブラウザが解釈している**ことの検証（I-15）。
 *
 * ## なぜ e2e なのか
 * 単体テスト（src/__tests__/proxy.test.ts）は「proxy がヘッダを載せた」ことしか
 * 証明できぬ。それは「本番のブラウザで見える」証明にはならぬ:
 *   - Next の proxy 応答ヘッダが最終応答まで伝播するか
 *   - ブラウザがヘッダを **PerformanceServerTiming としてパースするか**
 * この 2 段は実ブラウザ + 実ビルドでしか確かめられぬ。
 *
 * ## なぜ生ヘッダではなく PerformanceServerTiming を見るか
 * 生ヘッダの assert は「ヘッダが存在する」ことしか言えぬ。DevTools の
 * Network → Timing に出るのも、スクリプトから読めるのも、ブラウザが
 * **パースに成功した時だけ**じゃ。書式を壊す変更（区切り・dur の書式）を
 * 生ヘッダ assert は素通しするため、パース済みエントリを証人に立てる。
 */

test("Server-Timing が navigation entry としてブラウザに見える（auth の内訳）", async ({
  page,
}) => {
  // /login は未認証で到達できる公開ルートだが proxy は通る（matcher は静的
  // アセットのみ除外）。認証状態に依らず計測経路を検証できる。
  await page.goto("/login")

  const serverTiming = await readServerTiming(page)

  // ブラウザがパースしたエントリとして auth が在ること
  const auth = serverTiming.find((t) => t.name === "auth")
  expect(
    auth,
    `Server-Timing がブラウザに解釈されていない。実際の entries: ${JSON.stringify(
      serverTiming,
    )}`,
  ).toBeDefined()

  // duration が数値として取れている（書式が壊れると 0 や欠落になる）
  expect(typeof auth!.duration).toBe("number")
  expect(auth!.duration).toBeGreaterThanOrEqual(0)
})

/**
 * 認証済みの経路では db（profiles の往復）の内訳も載る。
 * 「もっさり」の切り分けは auth と db の比で行うため、両方が揃って初めて意味を持つ。
 */
test("認証済みページでは auth と db の両方が見える", async ({
  page,
  approvedUser,
}) => {
  await loginViaMagicLink(page, approvedUser.email)
  // 世帯なしゆえ /setup へ落ちるが、proxy は認証済み経路（profiles 往復）を通っている
  await page.waitForURL(/\/setup/, { timeout: 15_000 })

  // ハードナビゲーションで navigation entry を取り直す
  await page.goto("/setup")

  const names = (await readServerTiming(page)).map((t) => t.name)

  expect(names).toContain("auth")
  expect(names).toContain("db")
})
