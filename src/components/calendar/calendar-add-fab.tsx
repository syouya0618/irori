"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * 予定追加の FAB（親指圏）。**位置だけ**をこの部品が受け持つ。
 *
 * ## トーストとの関係は Agent A の契約に乗る（DESIGN_SYSTEM.md「浮く操作（FAB）とトーストの契約」）
 * - 根に `data-fab` を付ける。A の globals.css の `body:has([data-fab])` がこれを見て、
 *   下端トーストの退避量（`--toast-clearance`）を FAB の上端 + 1rem へ上げる
 * - 下端 = ナビ（4rem）+ safe-area + 1rem（= A の `above-bottom-nav`）
 * - 高さ = 3.5rem（`h-14` = A の `--fab-size`）
 *
 * C 単独の branch には A のクラス・変数が無いゆえ、同じ値を arbitrary value で書く
 * （`data-fab` は何もせぬ属性として残るだけで壊れぬ）。A の差分と統合した後は
 * `bottom-[...]` を `above-bottom-nav`、`h-14` を `h-(--fab-size)` へ置き換えてよい（値は同じ）。
 * ナビの高さや FAB の寸法を変える時は、A の変数と**この式の両方**を変えること
 * （`__tests__/calendar-add-fab.test.tsx` が式を固定しておる）。
 *
 * ⚠️ FAB 側でトーストの矩形を測って自分を持ち上げてはならぬ。sonner の入場は下から 400ms の
 * translateY ゆえ、A の退避と同時に動かすと入場中の矩形に反応して FAB が跳ねて戻る（A の契約の
 * 禁止条項・独立レビュー r4 P2-1）。
 *
 * 横は max-w-lg の列の右端に揃える（広い画面で画面の隅へ飛ばさぬ）。
 * **ただし背の低い画面（高さ 500px 以下 = スマホの横向き）では画面の右端 1rem へ寄せる。**
 * sonner は幅 600px 超でトーストを中央 356px に出すゆえ、列の右端（中央 + 約 140〜240px）の FAB は
 * 横でトーストと交わる。縦に余裕のある画面では A の退避（縦）で離れるが、横向きで上端トーストを
 * 3 件展開すると FAB の高さまで垂れて重なった（独立レビュー r5。改修前の FAB は画面の右端に
 * あり交わらなんだ = 列の右端寄せが持ち込んだ退行）。画面の右端なら幅 W > 約 588px で常に交わらぬ。
 * A の DESIGN_SYSTEM「横は列の右端」の例外として統合時に注記すること。
 */
const CALENDAR_FAB_CLASS =
  "fixed right-[max(1rem,calc(50%-16rem+1rem))] [@media(max-height:500px)]:right-4 bottom-[calc(4rem+env(safe-area-inset-bottom,0px)+1rem)] z-10 h-14 cursor-pointer gap-1.5 rounded-full px-5 text-base shadow-lg shadow-black/[0.12]"

export function CalendarAddFab({
  label,
  onClick,
}: {
  /** 読み上げ名（「10月24日（土）に予定を追加」）。見えておる「追加」を含む（label-in-name）。 */
  label: string
  onClick: () => void
}) {
  return (
    <Button
      onClick={onClick}
      aria-label={label}
      data-fab=""
      className={CALENDAR_FAB_CLASS}
    >
      <Plus size={22} />
      追加
    </Button>
  )
}
