/**
 * unstable_rethrow の契約検証。
 *
 * setup / 招待の各フォームは redirect() を投げる server action を try/catch で
 * 包む。その catch で unstable_rethrow を呼ぶことで、通常エラー（通信断など）は
 * 握らずに拾い、redirect()/notFound() の内部エラーはフレームワークへ再送出する。
 * この二分挙動が壊れると「永久ローディング」修正が redirect を握り潰す危険がある
 * ため、インストール版の実挙動をここで固定する。
 */

import { describe, it, expect } from "vitest"
import { unstable_rethrow, redirect } from "next/navigation"

describe("unstable_rethrow の契約", () => {
  it("通常エラーは再送出せず素通りさせる（catch 側で処理させる）", () => {
    expect(() => unstable_rethrow(new Error("network down"))).not.toThrow()
  })

  it("redirect() の内部エラーは再送出する（握り潰さない）", () => {
    let redirectError: unknown
    try {
      redirect("/meals")
    } catch (e) {
      redirectError = e
    }
    // redirect() は必ず throw する
    expect(redirectError).toBeDefined()
    // その内部エラーは unstable_rethrow で再送出される
    expect(() => unstable_rethrow(redirectError)).toThrow()
  })
})
