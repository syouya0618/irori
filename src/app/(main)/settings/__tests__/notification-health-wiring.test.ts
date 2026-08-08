/**
 * 設定ページ → 診断（`summarizeNotificationHealth`）の**配線**を縛る（SEC-3）。
 *
 * ## なぜドメイン側のテストでは足りぬか
 * 欠陥は `summarizeNotificationHealth` の中には無かった。**呼び出し側が
 * 読み取り error を渡しておらなんだ**ことが欠陥じゃった（`heartbeatError` は
 * ログに残すだけで、summarize には `ranAt: null` しか届かず、画面は
 * 「まだ一度も実行されていません」と断言した）。ゆえに
 * `notification-health.test.ts` をいくら足しても、この穴は塞がらぬ ——
 * 引数を渡さぬ実装は、ドメイン側の全テストを緑のまま通過する。
 *
 * ## なぜ source 走査か
 * このリポには page.tsx を描画するテストが 1 本も無い（Supabase の chain を
 * 6 本ぶん模す費用に見合わぬ）。`runbook-contract.test.ts` と同じ形 ——
 * **1 行が本番の意味を決めておるなら、その 1 行を機械で縛る** —— を採る。
 *
 * ## 偽緑を潰す
 * 走査が空振りしても `toContain` は評価されぬまま緑になりうるゆえ、
 * **まず「呼び出しを 1 つ見つけたこと」を固定する**。
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "../../../../..")
const PAGE = path.join(ROOT, "src/app/(main)/settings/page.tsx")

/** `summarizeNotificationHealth({ ... })` の引数ブロックだけを切り出す。 */
function summarizeCall(): string {
  const source = readFileSync(PAGE, "utf8")
  const start = source.indexOf("summarizeNotificationHealth({")
  if (start < 0) return ""
  const end = source.indexOf("})", start)
  if (end < 0) return ""
  return source.slice(start, end)
}

describe("settings/page → 診断の配線", () => {
  it("走査が空回りしておらぬ（呼び出しを実際に見つけておる）", () => {
    const call = summarizeCall()
    expect(call.length).toBeGreaterThan(0)
    // 既存の入力が在ることも同じ文脈で確かめる（切り出しの範囲が正しい証拠）。
    expect(call).toContain("ranAt:")
    expect(call).toContain("lastSentAt:")
  })

  it("**心拍の error を渡しておる**（読めなかったを never と描かぬ）", () => {
    expect(
      summarizeCall(),
      "heartbeatError を summarize へ渡さねば、診断の読み取り失敗が" +
        "「通知の配信はまだ一度も実行されていません」と断言される。" +
        "主は pg_cron を疑い、真因（読めなかっただけ）へ辿り着けぬ。",
    ).toContain("ranAtUnknown: Boolean(heartbeatError)")
  })

  it("**最終配信の error も渡しておる**（片方だけでは半分嘘のままじゃ）", () => {
    expect(summarizeCall()).toContain("lastSentUnknown: Boolean(lastDeliveryError)")
  })

  it("その error は実際のクエリ結果から取っておる（変数名だけの偽物でない）", () => {
    const source = readFileSync(PAGE, "utf8")
    expect(source).toContain("error: heartbeatError")
    expect(source).toContain("error: lastDeliveryError")
  })
})
