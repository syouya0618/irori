#!/usr/bin/env node
/**
 * `Server-Timing` が**本番に届いているか**を、本番を撃って確かめる。
 *
 * ## なぜ要るか
 *
 * `e2e/server-timing.spec.ts` は実ブラウザ + 実ビルドで緑でありながら、
 * 本番では計測が死んでおった。e2e が撃つのは `next start` で立てた自前の
 * サーバで、**配信経路（CDN）を一切通らぬ**からじゃ。2026-08-09 の実測:
 *
 *   ローカル `next start` : /  /login  /api/cron/notify  すべてに載る
 *   本番 (Vercel)         : どれにも載らぬ（x-vercel-cache: MISS の動的経路でも）
 *
 * 真因は Vercel の CDN が `Server-Timing` 応答ヘッダを剥がしていたこと。
 * 一次情報: https://vercel.com/changelog/server-timing-header
 *   "On August 10, 2026, Vercel's CDN will stop stripping the Server-Timing
 *    response header and begin passing it through to the client."
 * opt-in 不要で既定が pass-through に変わる（止めたい側が vercel.json の
 * transform で消す）。ゆえにアプリ側の実装は変えておらぬ。
 *
 * ## ⚠️ これは CI ゲートではない（意図的に）
 *
 * 剥がしが解ける前に CI へ入れると**設計として赤い**ゲートになり、いずれ
 * `continue-on-error` や条件緩和で黙らせたくなる —— それは CLAUDE.md が
 * 名指しで禁じておる形じゃ。緑を一度**目で見てから**ゲート化を判断せよ。
 *
 * ## 使い方
 *
 *   node scripts/verify-prod-server-timing.mjs [origin]
 *
 * origin 既定は本番エイリアス。終了コード 0 = 届いておる / 1 = 届いておらぬ。
 * 認証は不要（`/login` も `/` も proxy を通り、未認証でも auth の内訳が載る）。
 */

const DEFAULT_ORIGIN = "https://irori-syouya0618s-projects.vercel.app"
const origin = (process.argv[2] ?? DEFAULT_ORIGIN).replace(/\/$/, "")

/**
 * 撃つ経路。**性質の違うものを混ぜる**のが肝じゃ:
 *  - `/`      … proxy が自ら生成する 307（origin 応答との合成が無い）
 *  - `/login` … 静的生成 + CDN キャッシュに載る経路
 *  - `/api/cron/notify` … 動的な関数実行（x-vercel-cache: MISS）
 * どれか 1 つだけ通る/落ちる状況を見分けられるようにしておく。
 */
const PATHS = ["/", "/login", "/api/cron/notify"]

const TIMEOUT_MS = 15_000

async function probe(path) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(origin + path, {
      redirect: "manual",
      signal: controller.signal,
      // CDN のキャッシュ済み応答ではなく毎回の実応答を見る
      headers: { "cache-control": "no-cache" },
    })
    return {
      path,
      status: res.status,
      serverTiming: res.headers.get("server-timing"),
      vercelCache: res.headers.get("x-vercel-cache"),
    }
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

const results = await Promise.all(PATHS.map(probe))

console.log(`origin: ${origin}\n`)
for (const r of results) {
  if (r.error) {
    console.log(`  ${r.path.padEnd(20)} ERROR ${r.error}`)
    continue
  }
  const mark = r.serverTiming ? "OK  " : "MISS"
  console.log(
    `  ${mark} ${r.path.padEnd(20)} ${String(r.status).padEnd(4)}` +
      ` cache=${(r.vercelCache ?? "-").padEnd(6)}` +
      ` Server-Timing=${r.serverTiming ?? "(なし)"}`
  )
}

const failed = results.filter((r) => r.error || !r.serverTiming)

if (failed.length === 0) {
  console.log("\n✅ Server-Timing が本番へ届いておる。計測器は生きておる。")
  console.log(
    "   → CI ゲート化を検討してよい段階じゃ（緑を目で見た後に、が掟）。"
  )
  process.exit(0)
}

console.log(
  `\n❌ ${failed.length}/${results.length} の経路で Server-Timing が届いておらぬ。`
)
console.log("   考えられる順に:")
console.log(
  "   1. Vercel の CDN がまだ剥がしておる（2026-08-10 の変更が未反映）"
)
console.log(
  "   2. vercel.json に server-timing を消す transform が入った（意図的な opt-out）"
)
console.log("   3. proxy が inert になった → scripts/check-proxy-effective.py")
console.log(
  "   ローカルとの弁別: PORT=3100 pnpm start してから " +
    "node scripts/verify-prod-server-timing.mjs http://localhost:3100"
)
process.exit(1)
