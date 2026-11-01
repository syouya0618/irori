/**
 * baby/page.tsx → `?date=` と世帯員の**配線**を縛る（機能 A / B）。
 *
 * calendar/page の date-param-wiring.test と同じ形: page.tsx を描画するテストが無いため、
 * 本番の意味を決める行を source 走査で固定する。走査の空振りを偽緑にせぬよう、まず
 * 「読めておること」を固定する。
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "../../../../..")
const PAGE = path.join(ROOT, "src/app/(main)/baby/page.tsx")

function pageSource(): string {
  return readFileSync(PAGE, "utf8")
}

function pageCode(): string {
  return pageSource()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

function dashboardProps(): string {
  const source = pageSource()
  const start = source.indexOf("<BabyDashboard")
  if (start < 0) return ""
  const end = source.indexOf("/>", start)
  if (end < 0) return ""
  return source.slice(start, end)
}

describe("baby/page → ?date= と世帯員の配線", () => {
  it("走査が空回りしておらぬ", () => {
    expect(pageSource().length).toBeGreaterThan(0)
    const props = dashboardProps()
    expect(props.length).toBeGreaterThan(0)
    expect(props).toContain("householdId={householdId}")
  })

  it("searchParams を受け取り、着地日は baby-link の resolveBabyDate で決める（綴りをここで書かぬ）", () => {
    const code = pageCode()
    expect(code).toContain("searchParams")
    expect(code).toContain("resolveBabyDate(params")
    expect(code).not.toMatch(/searchParams\.date|\["date"\]/)
  })

  it("選択日を initialDate として渡し、選択日の logs と日記を取る", () => {
    const props = dashboardProps()
    expect(props).toContain("initialDate={selectedDate}")
    // 持ち主・世帯・着地日ごとに作り直す: 別の持ち主の状態を持ち越さず、`/baby?date=…` から `/baby` へ戻っても選択日が
    // 着地日のまま居座らぬ（レビュー P3）
    expect(props).toContain("key={`${userId}:${householdId}:${child.id}:${selectedDate}`}")
    const code = pageCode()
    expect(code).toContain('.eq("diary_date", selectedDate)')
    // 選択日の窓は baby-log-queries.ts の 1 実装（取り直しと同じ組み立て）。窓そのものは
    // その単体テストが固定する。ここでは「選択日で呼ぶ」配線だけを見る
    expect(code).toContain("selectBabyLogsOfDay(supabase, householdId, selectedDate)")
    // 週窓・前日までの授乳は選択日ではなく今日基準
    expect(code).toContain("selectBabyLogsOfWeek(supabase, householdId, todayJst)")
    expect(code).toContain("selectLastNursingBefore(supabase, householdId, todayJst)")
  })

  it("世帯員（profiles の id と display_name）を members として渡す", () => {
    const code = pageCode()
    expect(code).toContain('.from("profiles")')
    expect(code).toContain('.select("id, display_name")')
    expect(dashboardProps()).toContain("members={")
  })
})
