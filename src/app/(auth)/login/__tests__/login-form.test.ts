/**
 * `buildEmailRedirectTo` の契約。
 *
 * ここは以前 `window.location.search` を丸ごと引き継いでおった。失敗理由を
 * `/login?error=...` に載せるようにした今、素通しすると **1 回目の失敗理由が
 * 2 回目のリンクへ紛れ込む**。`/auth/callback` 側は code を先に見るゆえ成功は
 * 塗り潰されぬが、罠を二重に塞ぐ（片方だけに頼らぬ）。
 */

import { describe, it, expect } from "vitest"
import { buildEmailRedirectTo } from "../login-form"

describe("buildEmailRedirectTo", () => {
  it("クエリが無ければ素の /auth/callback", () => {
    expect(buildEmailRedirectTo("https://example.test/login")).toBe(
      "https://example.test/auth/callback"
    )
  })

  it("自分が載せた error は落とす（前回の失敗を次回へ持ち越さぬ）", () => {
    expect(
      buildEmailRedirectTo("https://example.test/login?error=link_expired")
    ).toBe("https://example.test/auth/callback")
  })

  it("returnTo 等の他のクエリは従来どおり運ぶ", () => {
    expect(
      buildEmailRedirectTo("https://example.test/login?returnTo=%2Fbaby")
    ).toBe("https://example.test/auth/callback?returnTo=%2Fbaby")
  })

  it("error を落としても他は残す", () => {
    const result = buildEmailRedirectTo(
      "https://example.test/login?error=link_expired&returnTo=%2Fbaby"
    )
    expect(result).toContain("returnTo=%2Fbaby")
    expect(result).not.toContain("error")
  })

  it("origin は現在地から取る（別ホストへ送らぬ）", () => {
    expect(buildEmailRedirectTo("https://other.test/login")).toBe(
      "https://other.test/auth/callback"
    )
  })
})
