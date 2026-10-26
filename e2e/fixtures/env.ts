import fs from "node:fs"
import path from "node:path"

/**
 * .env.e2e を読み込んで KEY=value の Record を返す。
 *
 * dotenv は依存に追加しない方針のため自前パースする。
 * .env.e2e は `pnpm e2e:env`（scripts/e2e-env.sh）が Supabase ローカルスタックから生成する。
 */
export function loadE2eEnv(): Record<string, string> {
  const envPath = path.resolve(__dirname, "../../.env.e2e")

  if (!fs.existsSync(envPath)) {
    throw new Error(
      ".env.e2e が見つかりません。`supabase start && pnpm e2e:env` を先に実行してください。"
    )
  }

  const env: Record<string, string> = {}

  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim()
    // コメント・空行はスキップ
    if (line === "" || line.startsWith("#")) continue

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue

    let value = match[2].trim()
    // 囲みクォート（" または '）を除去
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[match[1]] = value
  }

  return env
}

/**
 * 「本番でないデプロイ」を模す 2 つ目のサーバ（playwright.config.ts の webServer の 2 本目）。
 * 同じ build を `VERCEL_ENV=preview` で起動し、要望の「反映済み」を preview から確定できぬことを
 * 実ブラウザで確かめる（e2e/feedback-preview-gate.spec.ts）。cookie はポートで分かれぬゆえ、
 * 3000 番でログインした session がそのまま使える。
 */
export const PREVIEW_PORT = 3100
export const PREVIEW_BASE_URL = `http://127.0.0.1:${PREVIEW_PORT}`
/** preview のサーバが観測するデプロイの SHA（`OBSERVED_DEPLOY_RE` の形に合う 40 桁） */
export const PREVIEW_COMMIT_SHA = "e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0"
