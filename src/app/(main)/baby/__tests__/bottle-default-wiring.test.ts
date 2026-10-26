/**
 * baby/page.tsx → いつものミルク量の**配線**を縛る（page.tsx を描画するテストが無いため、
 * date-param-wiring.test と同じく本番の意味を決める行を source 走査で固定する）。
 *
 * 要: 量は赤子の名前・授乳間隔を読む households の select へ**混ぜず**別の問い合わせで読む。
 * migration（20261025100001）が当たる前の DB へ deploy された時、列が無い select はまるごと
 * 失敗し、名前・誕生日・授乳間隔まで既定値へ落ちる。別なら落ちるのは量（取得失敗の表示）だけ。
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "../../../../..")
const PAGE = path.join(ROOT, "src/app/(main)/baby/page.tsx")

function pageCode(): string {
  return readFileSync(PAGE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

function dashboardProps(): string {
  const code = pageCode()
  const start = code.indexOf("<BabyDashboard")
  if (start < 0) return ""
  const end = code.indexOf("/>", start)
  return end < 0 ? "" : code.slice(start, end)
}

describe("baby/page → いつものミルク量の配線", () => {
  it("走査が空回りしておらぬ", () => {
    expect(pageCode().length).toBeGreaterThan(0)
    expect(dashboardProps()).toContain("householdId={householdId}")
  })

  it("量は共有の問い合わせ（selectBottleDefault）で読み、読み方は decodeBottleDefault に任せる", () => {
    const code = pageCode()
    expect(code).toContain("selectBottleDefault(supabase, householdId)")
    expect(code).toContain("decodeBottleDefault(bottleDefaultResult)")
    expect(dashboardProps()).toContain("initialBottleDefault={bottleDefault}")
  })

  it("赤子の名前・授乳間隔の select へ bottle_default_ml を混ぜぬ（migration 前の DB で巻き添えにせぬ）", () => {
    const code = pageCode()
    expect(code).toContain('.select("baby_name, baby_birth_date, feeding_interval_min")')
    expect(code).not.toMatch(/\.select\("[^"]*bottle_default_ml[^"]*"\)/)
  })
})
