"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useFabClearance } from "@/lib/hooks/use-fab-clearance"

/**
 * 予定追加の FAB（親指圏）。**位置だけ**をこの部品が受け持つ。
 *
 * ## トーストとの関係は共通の殻の契約に乗る（DESIGN_SYSTEM.md「浮く操作（FAB）とトーストの契約」）
 * - 根で `useFabClearance()` を呼ぶ。React が mount の間だけ `<html data-fab>` を立て、globals.css の
 *   `html[data-fab]` が下端トーストの退避量（`--toast-clearance`）を FAB の上端 + 1rem へ上げる。
 *   要素に `data-fab` を付けるだけでは何も起きぬ（`use-fab-clearance.test.tsx` の走査が落とす）
 * - 下端 = `above-bottom-nav`（ナビ `--bottom-nav-h` + safe-area + 1rem）
 * - 高さ = `h-(--fab-size)`（3.5rem）
 * 退避の式（globals.css）と FAB の寸法は同じ変数から導くゆえ、ナビや FAB の寸法を変える時は変数を変える。
 *
 * ⚠️ FAB 側でトーストの矩形を測って自分を持ち上げてはならぬ。sonner の入場は下から 400ms の
 * translateY ゆえ、殻の退避と同時に動かすと入場中の矩形に反応して FAB が跳ねて戻る（契約の
 * 禁止条項・独立レビュー r4 P2-1）。
 *
 * 横は max-w-lg の列の右端に揃える（広い画面で画面の隅へ飛ばさぬ）。
 * **ただし背の低い画面（高さ 500px 以下 = スマホの横向き）では画面の右端 1rem へ寄せる**
 * （DESIGN_SYSTEM.md の契約 4 の例外）。sonner は幅 600px 超でトーストを中央 356px に出すゆえ、
 * 列の右端（中央 + 約 140〜240px）の FAB は横でトーストと交わる。縦に余裕のある画面では殻の退避（縦）で
 * 離れるが、横向きで上端トーストを 3 件展開すると FAB の高さまで垂れて重なった（独立レビュー r5。
 * 改修前の FAB は画面の右端にあり交わらなんだ = 列の右端寄せが持ち込んだ退行）。画面の右端なら
 * 幅 W > 約 588px で常に交わらぬ。
 */
const CALENDAR_FAB_CLASS =
  "fixed right-[max(1rem,calc(50%-16rem+1rem))] [@media(max-height:500px)]:right-4 above-bottom-nav z-10 h-(--fab-size) cursor-pointer gap-1.5 rounded-full px-5 text-base shadow-lg shadow-black/[0.12]"

export function CalendarAddFab({
  label,
  onClick,
}: {
  /** 読み上げ名（「10月24日（土）に予定を追加」）。見えておる「追加」を含む（label-in-name）。 */
  label: string
  onClick: () => void
}) {
  // この FAB が画面に在る間だけ、下端トーストを FAB の上へ退避させる
  useFabClearance()
  return (
    <Button
      onClick={onClick}
      aria-label={label}
      className={CALENDAR_FAB_CLASS}
    >
      <Plus size={22} />
      追加
    </Button>
  )
}
