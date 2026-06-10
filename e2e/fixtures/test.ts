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
