import { describe, it, expect } from "vitest"
import { extractInviteToken } from "../invite-token"

describe("extractInviteToken", () => {
  const TOKEN = "abc123-def456-ghi789"

  it("フル招待リンクから token を抽出する", () => {
    expect(
      extractInviteToken(`https://irori-sigma.vercel.app/invite/${TOKEN}`)
    ).toBe(TOKEN)
  })

  it("末尾スラッシュを含むリンクでも token のみ取る", () => {
    expect(
      extractInviteToken(`https://irori-sigma.vercel.app/invite/${TOKEN}/`)
    ).toBe(TOKEN)
  })

  it("クエリ・ハッシュ付きリンクでも token のみ取る", () => {
    expect(
      extractInviteToken(`https://x.app/invite/${TOKEN}?ref=line#top`)
    ).toBe(TOKEN)
  })

  it("相対パス /invite/<token> を受け付ける", () => {
    expect(extractInviteToken(`/invite/${TOKEN}`)).toBe(TOKEN)
  })

  it("前後の空白をトリムする", () => {
    expect(
      extractInviteToken(`  https://x.app/invite/${TOKEN}  `)
    ).toBe(TOKEN)
  })

  it("生トークン単体をそのまま返す", () => {
    expect(extractInviteToken(TOKEN)).toBe(TOKEN)
    expect(extractInviteToken(`  ${TOKEN} `)).toBe(TOKEN)
  })

  it("空・空白のみは null", () => {
    expect(extractInviteToken("")).toBeNull()
    expect(extractInviteToken("   ")).toBeNull()
  })

  it("/invite/ を含むが token が空の URL は null", () => {
    expect(extractInviteToken("https://x.app/invite/")).toBeNull()
  })

  it("URL でも /invite/ を含まなければ null（誤貼付防止）", () => {
    expect(extractInviteToken("https://irori-sigma.vercel.app/meals")).toBeNull()
  })

  it("スラッシュ/空白を含むが招待リンクでない入力は null", () => {
    expect(extractInviteToken("foo bar")).toBeNull()
    expect(extractInviteToken("some/random/path")).toBeNull()
  })
})
