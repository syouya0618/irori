import { describe, expect, it } from "vitest"
import manifest from "../manifest"
import { VALID_PAGES } from "@/lib/constants/pages"

/**
 * PWA manifest の契約。
 *
 * ## なぜこのテストが要るか
 *
 * `start_url` を具体的なページへ直書きすると、**設定画面の「起動時のページ」
 * （`profiles.default_page`）が何を選んでも効かなくなる**。ホーム画面のアイコンから
 * 起動すると `/`（`src/app/page.tsx` の振り分け）を通らず、その URL が直接開くためじゃ。
 *
 * 実際に `start_url: "/meals"` で起きた —— 設定を変えても**必ず献立が開く**。
 * 振り分けのロジック自体は正しかったゆえ、そちらを何度読んでも原因は見つからぬ。
 * manifest は静的生成（`○ /manifest.webmanifest`）で利用者ごとに変えられず、
 * **コードを読んでも「効かぬ」ことが現れぬ**種類の破損じゃ。
 *
 * ゆえに「`/` であること」ではなく **「振り分けを迂回する値でないこと」** を固定する。
 * 将来 `/dashboard` のような別の入口を作ってそちらへ変える分には通り、
 * `VALID_PAGES` の 1 つを直書きした瞬間に赤くなる。
 */
describe("PWA manifest", () => {
  const m = manifest()

  it("start_url は `/`（起動を default_page の振り分けへ通す）", () => {
    expect(m.start_url).toBe("/")
  })

  it("start_url に具体的なページを直書きしておらぬ（設定が死ぬ形を禁ずる）", () => {
    // VALID_PAGES = meals / shopping / stock / baby。どれを直書きしても
    // 「起動時のページ」の設定が効かなくなる。
    for (const page of VALID_PAGES) {
      expect(m.start_url).not.toBe(`/${page}`)
    }
  })

  it("display は standalone（iOS の Web Push はホーム画面 web app 限定ゆえ）", () => {
    // Apple 公式: "iOS 16.4 or later: Home Screen web apps"。
    // browser 等へ変えると通知が動かなくなる端末がある。
    expect(m.display).toBe("standalone")
  })

  it("アイコンは 192 と 512 を持つ（追加時の縮小に両方要る）", () => {
    const sizes = (m.icons ?? []).map((i) => i.sizes)
    expect(sizes).toContain("192x192")
    expect(sizes).toContain("512x512")
  })
})
