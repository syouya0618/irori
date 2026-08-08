/**
 * calendar/page.tsx → `?date=` の**配線**を縛る（B-6）。
 *
 * ## なぜドメイン側のテストでは足りぬか
 * `resolveCalendarDateView` をいくら固めても、page が
 * (a) `searchParams` を受け取らぬ／(b) 結果の**片方だけ**を渡す、のどちらでも
 * 通知の着地日は今日のままじゃ。そして両方ともドメインのテストを緑で通り抜ける。
 * PR #163 が残した宿題はまさに (a) じゃった。
 *
 * ## なぜ source 走査か
 * このリポには page.tsx を描画するテストが 1 本も無い（Supabase の chain を
 * 3 本ぶん模す費用に見合わぬ）。`notification-health-wiring.test.ts` と同じ形 ——
 * **1 行が本番の意味を決めておるなら、その 1 行を機械で縛る** —— を採る。
 *
 * ## 偽緑を潰す
 * 走査が空振りしても `toContain` は評価されぬまま緑になりうるゆえ、
 * **まず「読めておること」を固定する**。
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "../../../../..")
const PAGE = path.join(ROOT, "src/app/(main)/calendar/page.tsx")

function pageSource(): string {
  return readFileSync(PAGE, "utf8")
}

/** `<CalendarView ... />` の props ブロックだけを切り出す。 */
function calendarViewProps(): string {
  const source = pageSource()
  const start = source.indexOf("<CalendarView")
  if (start < 0) return ""
  const end = source.indexOf("/>", start)
  if (end < 0) return ""
  return source.slice(start, end)
}

describe("calendar/page → ?date= の配線", () => {
  it("走査が空回りしておらぬ（page と props ブロックを実際に読めておる）", () => {
    const source = pageSource()
    expect(source.length).toBeGreaterThan(0)
    const props = calendarViewProps()
    expect(props.length).toBeGreaterThan(0)
    // 既存の prop が在ることも同じ文脈で確かめる（切り出し範囲が正しい証拠）。
    expect(props).toContain("householdId={householdId}")
    expect(props).toContain("initialEvents={")
  })

  it("**`searchParams` を受け取り await しておる**（Next.js 16 は Promise じゃ）", () => {
    const source = pageSource()
    expect(
      source,
      "searchParams を受け取らねば ?date= は永久に読まれず、通知は" +
        "「翌日の予定を指しながら今日を開く」ままじゃ（PR #163 の宿題）。",
    ).toContain("searchParams")
    expect(source).toContain("searchParams: Promise<")
    expect(source).toContain("await searchParams")
  })

  it("解釈は `resolveCalendarDateView` に委ねておる（page で二重実装せぬ）", () => {
    const source = pageSource()
    expect(source).toContain("resolveCalendarDateView(")
    // date を直接触って自前で検証・整形する経路が生えておらぬこと。
    // （`isValidYmd` を page が呼ぶ形は二重実装の兆候ゆえ弾く。）
    expect(source).not.toContain("isValidYmd")
    // 月を「今月」で固定する旧実装へ戻っておらぬこと。**これが月跨ぎの真犯人じゃ。**
    expect(
      source,
      "currentMonthFirstJst() で月を決めると、?date= が翌月を指しても" +
        "今月のグリッドが描かれる（8月1日の予定が7月のグリッドに出る）。",
    ).not.toContain("currentMonthFirstJst")
  })

  it("**選択日と月を対で渡しておる**（片方だけでは月跨ぎで割れる）", () => {
    const props = calendarViewProps()
    expect(props).toContain("initialSelectedDate={selectedDate}")
    expect(props).toContain("initialMonthFirst={monthFirst}")
  })

  it("その 2 つは同じ 1 回の解釈から取っておる（変数名だけの偽物でない）", () => {
    // 分割代入で両方を受けておること = 月が選択日から導かれておることの担保。
    expect(pageSource()).toMatch(
      /const\s*\{\s*selectedDate\s*,\s*monthFirst\s*\}\s*=\s*resolveCalendarDateView\(/,
    )
  })
})
