import { test as base } from "@playwright/test"
import {
  adminClient,
  cleanupUser,
  createApprovedUser,
  uniqueEmail,
  type E2eUser,
} from "./auth"

interface E2eFixtures {
  /** worker ごと・実行ごとに一意なテスト用メールアドレス */
  email: string
  /** 承認済み（is_approved=true・世帯なし）ユーザー。teardown で世帯ごと削除する */
  approvedUser: E2eUser
}

export const test = base.extend<E2eFixtures>({
  // 初回ユーザー向けの使い方ツアー(OnboardingTour)は認証後の初回ロードで
  // 自動的に bottom Sheet を開き、その backdrop が全操作を遮る。E2E は各動線を
  // 検証したいのでツアーは対象外 — 既読フラグを事前投入して自動表示を抑止する。
  // キーは src/lib/hooks/use-onboarding-tour.ts の TOUR_SEEN_KEY と一致させる。
  // ツアー自体の挙動は jsdom テストが担保する。
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("irori:tour-seen:v1", "1")
      } catch {
        /* localStorage 不可環境でも E2E を止めない */
      }
    })
    await use(page)
  },

  email: async ({}, use, testInfo) => {
    await use(uniqueEmail(testInfo.workerIndex))
  },

  approvedUser: async ({ email }, use) => {
    const user = await createApprovedUser(email)

    await use(user)

    // teardown: テスト中に世帯を作成していれば世帯ごと削除する。
    // cleanup は best-effort（失敗してもテスト結果に影響させない）。
    let householdId: string | undefined
    try {
      const { data, error } = await adminClient()
        .from("profiles")
        .select("household_id")
        .eq("id", user.id)
        .maybeSingle()
      if (error) {
        console.warn(
          `[e2e cleanup] household lookup failed (${user.id}): ${JSON.stringify(
            { message: error.message, code: error.code, details: error.details }
          )}`
        )
      } else {
        householdId = data?.household_id ?? undefined
      }
    } catch (err) {
      console.warn(`[e2e cleanup] household lookup threw (${user.id}):`, err)
    }

    await cleanupUser(user.id, householdId)
  },
})

export { expect } from "@playwright/test"
