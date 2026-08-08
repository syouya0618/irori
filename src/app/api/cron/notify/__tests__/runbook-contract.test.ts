/**
 * 手順書の登録 verb と、ハンドラが export しておる HTTP メソッドを突き合わせる。
 *
 * ## なぜこれが要るか（実測で踏んだ）
 * `docs/runbooks/notify-cron.md` は当初 pg_net の既定に素直に従って
 * `net.http_post` で登録する手順になっておった。ところがハンドラは **GET しか
 * export しておらぬ**。Next.js の Route Handler は export しておらぬメソッドへ
 * **405 をハンドラの手前で返す** — 実測: `POST /api/cron/notify` = 405 /
 * `GET` = 401（secret 無し）。
 *
 * ⚠️ **この食い違いは既存のどのテストにも映らぬ。**
 *   * 単体テストは `GET` を直接 import して呼ぶゆえ常に緑
 *   * e2e も `request.get()` で叩くゆえ常に緑
 *   * `cron.job_run_details` は HTTP の成否を知らぬゆえ `succeeded` と記録する
 *   * `net._http_response` は保持 6 時間・unlogged ゆえ、気付くのは
 *     「通知が来ぬ」と人が言い出す時だけ
 * すなわち**全ての監視が緑のまま通知が 1 通も出ぬ**。手順書の 1 行が本番の
 * 稼働を決めておる以上、その 1 行は機械で縛るほかない。
 *
 * ## 偽緑を潰す
 * 走査が 0 件なら for ループは空回りして緑になる（正規表現を書き損じた時に起きる）。
 * ゆえに**まず「両側とも 1 つ以上見つかったこと」を固定する**。
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "../../../../../..")
const ROUTE = path.join(ROOT, "src/app/api/cron/notify/route.ts")
const RUNBOOK = path.join(ROOT, "docs/runbooks/notify-cron.md")

// ⚠️ **この対応付けは「notify の手順書 ↔ notify のハンドラ」1 組だけを前提にしておる。**
// B-5 のダイジェスト cron を**この同じファイル**へ書き足すと、その verb まで
// `/api/cron/notify` の export に要求してしまい、無関係な赤が出る。
// 別の endpoint は別の runbook へ分けるか、対応付けを endpoint 単位へ一般化せよ。

/** ハンドラが export しておる HTTP メソッド（`export async function GET(` の形）。 */
function exportedMethods(): string[] {
  const source = readFileSync(ROUTE, "utf8")
  return [
    ...source.matchAll(/export\s+async\s+function\s+([A-Z]+)\s*\(/g),
  ].map((m) => m[1])
}

/**
 * 手順書が**実際に呼んでおる** pg_net の関数（`net.http_get(` の形）。
 * 散文中の `` `net.http_post` `` は括弧を伴わぬゆえ拾わぬ — 拾うと
 * 「POST で登録するな」という注意書き自身がこのテストを赤くしてしまう。
 */
function runbookVerbs(): string[] {
  const source = readFileSync(RUNBOOK, "utf8")
  return [...source.matchAll(/net\.http_([a-z]+)\s*\(/g)].map((m) =>
    m[1].toUpperCase(),
  )
}

describe("notify-cron の手順書とハンドラの契約", () => {
  it("走査が空回りしておらぬ（正規表現の書き損じで偽緑にならぬ）", () => {
    expect(exportedMethods().length).toBeGreaterThan(0)
    expect(runbookVerbs().length).toBeGreaterThan(0)
  })

  it("**手順書が呼ぶ verb は全てハンドラが export しておる**（405 で全滅せぬ）", () => {
    const methods = exportedMethods()
    for (const verb of runbookVerbs()) {
      expect(
        methods,
        `手順書は net.http_${verb.toLowerCase()}() で登録せよと書いておるが、` +
          `route.ts は ${methods.join("/")} しか export しておらぬ。` +
          `本番の cron は 405 を受けて 1 通も送らぬまま "succeeded" と記録される。`,
      ).toContain(verb)
    }
  })

  it("Vercel Cron 互換のため GET を必ず持つ", () => {
    // pg_net から叩く形へ寄せた今も、GET を落としてはならぬ
    // （`vercel.json` の cron へ将来移す余地と、手動確認の口を残すため）。
    expect(exportedMethods()).toContain("GET")
  })
})
