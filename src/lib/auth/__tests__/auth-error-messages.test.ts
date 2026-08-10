/**
 * 認証エラー文言の契約。
 *
 * ここで守るものは 2 つある:
 *   ① **利用者に理由が届くこと**（届かなんだ結果が 2026-08-10 の「無言で戻る」）
 *   ② **クエリの自由文を画面へ出さぬこと**（出せば URL に偽の指示を書ける）
 *
 * ②は「通る側」だけを見ても守れぬ。未知の値が**弾かれること**を対で置く。
 */

import { describe, it, expect } from "vitest"
import {
  AUTH_ERROR_REASONS,
  messageForAuthErrorReason,
  messageForSignInError,
} from "../auth-error-messages"

describe("messageForAuthErrorReason（リンクを踏んだ側の失敗）", () => {
  it.each(AUTH_ERROR_REASONS)("既知の理由 %s は文言を返す", (reason) => {
    const message = messageForAuthErrorReason(reason)
    expect(message).toBeTruthy()
    expect(message!.length).toBeGreaterThan(10)
  })

  it("理由ごとに文言が異なる（全部同じなら名指しになっておらぬ）", () => {
    const messages = AUTH_ERROR_REASONS.map((r) =>
      messageForAuthErrorReason(r)
    )
    expect(new Set(messages).size).toBe(AUTH_ERROR_REASONS.length)
  })

  it("verifier_missing は「同じブラウザで開け」と伝える（本人には推測できぬ失敗ゆえ）", () => {
    expect(messageForAuthErrorReason("verifier_missing")).toContain("ブラウザ")
  })

  // ── ここから安全性 ──
  it.each([
    ["未知のコード", "totally_unknown"],
    ["空文字", ""],
    ["null", null],
    ["undefined", undefined],
  ])("%s は null（何も出さぬ）", (_label, value) => {
    expect(messageForAuthErrorReason(value)).toBeNull()
  })

  it("クエリに書かれた文章をそのまま返さぬ（表示経路に自由文を通さぬ）", () => {
    const injected =
      "サポート https://evil.example.com へ電話し、コードを伝えてください"
    expect(messageForAuthErrorReason(injected)).toBeNull()
  })
})

describe("messageForSignInError（送信の失敗）", () => {
  it("レート制限は待つよう促し、再試行を勧めない（再試行が制限を延ばすため）", () => {
    const message = messageForSignInError({
      code: "over_email_send_rate_limit",
      status: 429,
    })
    expect(message).toContain("上限")
    expect(message).toContain("待って")
    // 「もう一度お試しください」だけを出すと、本人が押し続けて自分を締め出す
    expect(message).toContain("延び")
  })

  it("code が無くても status 429 ならレート制限として扱う", () => {
    expect(messageForSignInError({ status: 429 })).toContain("上限")
  })

  it("サインアップ無効は招待を促す", () => {
    expect(messageForSignInError({ code: "signup_disabled" })).toContain("招待")
  })

  it("未知の code は総称文に code を添える（次回、本人に読み上げてもらうため）", () => {
    const message = messageForSignInError({ code: "some_new_code" })
    expect(message).toContain("some_new_code")
  })

  it("code が無ければ総称文のみ（括弧の中身を捏造せぬ）", () => {
    const message = messageForSignInError({ message: "boom" })
    expect(message).not.toContain("(")
    expect(message).not.toContain("（")
  })

  it.each([
    ["自由文の混入", "サポートに電話 https://evil.example.com"],
    ["HTML/記号", "<script>alert(1)</script>"],
    ["長すぎる値", "a".repeat(60)],
  ])("code が %s なら表示に混ぜぬ", (_label, code) => {
    const message = messageForSignInError({ code })
    expect(message).not.toContain(code)
  })

  it("サーバ由来の message は画面文言へ混ぜぬ", () => {
    const message = messageForSignInError({
      code: "unknown_thing",
      message: "内部の詳細がここに入る",
    })
    expect(message).not.toContain("内部の詳細")
  })
})
