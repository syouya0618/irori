/**
 * 「献立に入れる」（今あるもので・レシピ詳細 → 献立）のために、Server Component が読んで渡す値。
 *
 * 境界指令を持たない中立モジュール（Server Component が `buildAddToPlanSlots` で作り、Client Component が
 * 型と表示に使う）。食材辞書・レシピのカタログは import しない（料理名は呼び出し側が引く）。
 *
 * ## 料理 1 品を、その日の献立へ足す（2026-11-11 ④）
 * 送るのは `add_recipe`（`addDinnerRecipe`）。その日に料理が在っても、在る料理・固定枠には触れずに 1 品を足す
 * （以前は献立の作成 `generate` を流用していたため、枠が 1 つも無い日にしか入れられなかった）。
 * 足す枠の位置（`nextPosition`）とその日の状態（`addStatus`）と人数（`servings`）と献立の版（`revision`）は、
 * **押した時点の値を要求に固定する**（再送が同じ内容になる）。サーバーは新しく足すときだけ、今の献立と照らす。
 */

import { PLAN_STATUS_LABELS, dishRoleLabel, formatMealDateWithRelative } from "@/lib/meals/server/format"
import { addedDishStatus, firstFreePosition } from "@/lib/meals/server/plan-requests"
import type { StoredPlanEntry } from "@/lib/meals/server/rows"
import { shiftYmd } from "@/lib/utils/date-jst"

/** 入れる先に選べる日数（今日を含む）。献立の画面の 1 週間と同じ。 */
export const ADD_TO_PLAN_DAYS = 7

export interface AddToPlanDish {
  title: string
  roleLabel: string
  statusLabel: string
  pinned: boolean
  /** カタログの料理なら、その ID（同じ料理が既に入っているかの判定に使う）。 */
  recipeId: string | null
}

export interface AddToPlanDay {
  date: string
  /** 「今日 11/11（水）」。 */
  label: string
  /** その日に既に在る料理（提案・確定・作った・作らなかった。固定を含む）。足しても、そのまま残る。 */
  dishes: AddToPlanDish[]
  /** 足す料理を置く位置（その日の空いている最初の位置）。10 品で埋まっていれば null（足せない）。 */
  nextPosition: number | null
  /** 足す料理の状態（その日の状態に合わせる。確定済みの日なら確定 = 買い物に入る）。 */
  addStatus: "proposed" | "confirmed"
}

export interface AddToPlanSlots {
  today: string
  /**
   * 読んだ時点の献立の版。1 品の追加の要求に固定して送る（サーバーは、その ID の行が無いとき、版が違えば書かない —
   * 確かめ直しの間に別の端末が消した料理を蘇らせないため。レビュー[中 5]）。
   */
  revision: number
  /** 足す料理の人数（設定の人数。未設定なら標準）。 */
  servings: number
  days: AddToPlanDay[]
  /** 読めなかった献立の枠の数（0 でなければ空いている位置を確かめられないので、入れる操作を止める）。 */
  unreadableEntries: number
}

/** 読む献立の範囲（今日から `ADD_TO_PLAN_DAYS` 日。両端を含む）。 */
export function addToPlanRange(today: string): { from: string; to: string } {
  return { from: today, to: shiftYmd(today, ADD_TO_PLAN_DAYS - 1) }
}

/**
 * 献立の読み込み結果から、日ごとの「既に在る料理」「足す位置」「足す料理の状態」を作る（純粋）。
 *
 * @param titleOf カタログの料理名を引く関数（`lookup.recipeById.get(id)?.title`）。
 */
export function buildAddToPlanSlots(
  input: { today: string; revision: number; servings: number; entries: readonly StoredPlanEntry[]; unreadableEntries: number },
  titleOf: (recipeId: string) => string | undefined,
): AddToPlanSlots {
  const { today } = input
  const days: AddToPlanDay[] = Array.from({ length: ADD_TO_PLAN_DAYS }, (_, index) => {
    const date = shiftYmd(today, index)
    const dayEntries = input.entries
      .filter((entry) => entry.date === date)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    const dishes = dayEntries.map((entry) => ({
      title:
        entry.recipeId === null
          ? (entry.customTitle ?? "名前のない料理")
          : (titleOf(entry.recipeId) ?? "一覧に無い料理"),
      roleLabel: dishRoleLabel(entry.role),
      statusLabel: PLAN_STATUS_LABELS[entry.status] ?? "",
      pinned: entry.pinned,
      recipeId: entry.recipeId,
    }))
    return {
      date,
      label: formatMealDateWithRelative(date, today),
      dishes,
      nextPosition: firstFreePosition(dayEntries),
      addStatus: addedDishStatus(dayEntries),
    }
  })
  return {
    today,
    revision: input.revision,
    servings: input.servings,
    days,
    unreadableEntries: input.unreadableEntries,
  }
}
