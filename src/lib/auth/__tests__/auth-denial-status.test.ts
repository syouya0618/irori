import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { AUTH_DENIAL_HTTP_STATUS } from "../auth-denial-status"

const ROOT = path.resolve(__dirname, "../../../..")

describe("AUTH_DENIAL_HTTP_STATUS", () => {
  it("401 はログインし直せば直る時（未認証）だけ。一過性の取得失敗は 503", () => {
    expect(AUTH_DENIAL_HTTP_STATUS).toEqual({
      unauthenticated: 401,
      "not-approved": 403,
      "no-household": 403,
      "lookup-failed": 503,
    })
  })

  it.each([
    "src/app/api/baby-report/route.ts",
    "src/app/api/baby-export/route.ts",
    "src/app/api/google/sync/route.ts",
  ])("%s は表を自前で持たず、この 1 表を使う", (file) => {
    const code = readFileSync(path.join(ROOT, file), "utf8")
    expect(code).toContain("AUTH_DENIAL_HTTP_STATUS[result.reason]")
    // 自前の表（"lookup-failed": 503 の行）を書き直しておらぬ
    expect(code).not.toMatch(/"lookup-failed":\s*\d{3}/)
  })
})
