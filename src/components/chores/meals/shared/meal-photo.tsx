"use client"

import type { CSSProperties } from "react"

/**
 * irori向けに生成したオリジナル料理・食材写真。
 * 実物のレシピと一致するIDだけ表示。写真がない料理は既存アイコンへ退化。
 * 3枚ずつの小さなWebPを使い、外部URL・個人画像・ライセンスに依存しない。
 */
const DISH_PHOTOS: Readonly<Record<string, readonly [row: number, col: number]>> = {
  oyakodon: [0, 0],
  tofu_wakame_miso_soup: [0, 1],
  salmon_shioyaki: [0, 2],
  curry_rice: [1, 0],
  chicken_teriyaki: [1, 1],
  nikujaga: [1, 2],
  tomato_onion_salad: [2, 0],
  chicken_pot_au_feu: [2, 1],
  steamed_rice: [2, 2],
}

const INGREDIENT_PHOTOS: Readonly<Record<string, readonly [row: number, col: number]>> = {
  egg: [0, 0],
  milk: [0, 1],
  onion: [0, 2],
  chicken_thigh: [1, 0],
  chicken_breast: [1, 0],
  napa_cabbage: [1, 1],
}

function photoCss(row: number, col: number, kind: "dish" | "ingredient"): CSSProperties {
  return {
    backgroundImage: kind === "dish"
      ? `url("/meals/dish-row-${row}.webp")`
      : 'url("/meals/ingredient-atlas.webp")',
    backgroundRepeat: "no-repeat",
    backgroundSize: kind === "dish" ? "300% 100%" : "300% 200%",
    backgroundPosition: `${col * 50}% ${kind === "dish" ? 50 : row * 100}%`,
  }
}

/** 装飾的な写真。料理名は必ず隣の文字で表示し、写真を根拠に在庫・安全情報を推定しない。 */
export function MealPhoto({
  recipeId,
  fallback,
  className = "",
}: {
  recipeId: string | null
  fallback: string
  className?: string
}) {
  const pos = recipeId === null ? undefined : DISH_PHOTOS[recipeId]
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary/10 text-3xl ${className}`}
      style={pos ? photoCss(pos[0], pos[1], "dish") : undefined}
      data-testid={pos ? "meal-photo" : "meal-photo-fallback"}
    >
      {pos === undefined ? fallback : null}
    </span>
  )
}

export function IngredientPhoto({
  ingredientId,
  fallback,
  className = "",
}: {
  ingredientId: string | null
  fallback: string
  className?: string
}) {
  const pos = ingredientId === null ? undefined : INGREDIENT_PHOTOS[ingredientId]
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary/10 text-3xl ${className}`}
      style={pos ? photoCss(pos[0], pos[1], "ingredient") : undefined}
      data-testid={pos ? "ingredient-photo" : "ingredient-photo-fallback"}
    >
      {pos === undefined ? fallback : null}
    </span>
  )
}
