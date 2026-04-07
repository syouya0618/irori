import type { MealType } from "@/lib/types/database"

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: "朝食",
  lunch: "昼食",
  dinner: "夕食",
  snack: "間食",
}

export const MEAL_TYPE_SHORT_LABELS: Record<MealType, string> = {
  breakfast: "朝",
  lunch: "昼",
  dinner: "夕",
  snack: "間",
}

export const MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner", "snack"]
