/**
 * ルーティング判定の「判定源が1つである」ことを**ソース上で**強制する構造テスト。
 *
 * なぜ必要か: proxy とページの判定が食い違うと無限リダイレクトになる（詳細は
 * verified-user.ts の注記）。しかしこの回帰は**単層のユニットテストでは原理的に
 * 検出できない** — 各層を個別に mock して検証する限り、両者が違う関数を呼んでいても
 * どちらも正しく動くからである。実際、ページ層を getUser() へ戻す変異を当てても
 * verified-user.test.ts は 12 本すべて緑のままだった（実測）。
 *
 * ゆえに「redirect でルーティングを決めるファイルが auth.getUser() を直接呼ばない」
 * というソース上の不変条件を、ここで機械的に固定する。
 *
 * Server Action（setup/actions.ts・invite/[token]/actions.ts）は対象外 —
 * 失敗時に redirect せず { error } を返すため、判定が食い違ってもループを生まない。
 * それらは「失効が即時に効く」性質を残す意図で getUser() のままにしてある。
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/** ルーティング判定（未認証 → redirect）を行うファイル */
const ROUTING_FILES = [
  "src/proxy.ts",
  "src/app/page.tsx",
  "src/app/setup/page.tsx",
  "src/app/(main)/settings/page.tsx",
  "src/app/(auth)/invite/[token]/page.tsx",
  "src/lib/supabase/auth-context.ts",
]

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")

describe("ルーティング判定の判定源は1つ（無限リダイレクト回帰の構造的防止）", () => {
  it.each(ROUTING_FILES)(
    "%s は auth.getUser() を直接呼ばない",
    (file) => {
      const src = read(file)
      // コメント中の言及は許す（実際の呼び出しだけを禁じる）
      const calls = src
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .filter((line) => /auth\s*\.\s*getUser\s*\(/.test(line))
      expect(calls).toEqual([])
    },
  )

  it.each(ROUTING_FILES)("%s は共有ヘルパ経由で判定する", (file) => {
    expect(read(file)).toMatch(/getVerifiedUser(Id)?\s*\(/)
  })
})
