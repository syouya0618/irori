import type { ItemCategory, StoreType } from "@/lib/types/database"

const categoryLabels: Record<ItemCategory, string> = {
  vegetable: "野菜",
  fruit: "果物",
  meat: "肉",
  fish: "魚介",
  dairy: "乳製品",
  egg: "卵",
  grain: "穀物",
  seasoning: "調味料",
  frozen: "冷凍",
  snack_food: "お菓子",
  other_food: "その他食品",
  baby: "ベビー",
  cleaning: "洗剤",
  hygiene: "衛生用品",
  other_daily: "その他",
}

const categoryColors: Record<ItemCategory, string> = {
  vegetable: "bg-emerald-100 text-emerald-700",
  fruit: "bg-orange-100 text-orange-700",
  meat: "bg-red-100 text-red-700",
  fish: "bg-blue-100 text-blue-700",
  dairy: "bg-violet-100 text-violet-700",
  egg: "bg-yellow-100 text-yellow-700",
  grain: "bg-amber-100 text-amber-700",
  seasoning: "bg-yellow-100 text-yellow-700",
  frozen: "bg-sky-100 text-sky-700",
  snack_food: "bg-pink-100 text-pink-700",
  other_food: "bg-gray-100 text-gray-600",
  baby: "bg-pink-100 text-pink-700",
  cleaning: "bg-cyan-100 text-cyan-700",
  hygiene: "bg-teal-100 text-teal-700",
  other_daily: "bg-gray-100 text-gray-600",
}

const storeLabels: Record<StoreType, string> = {
  supermarket: "スーパー",
  drugstore: "ドラッグストア",
  convenience: "コンビニ",
  online: "ネット",
  other: "その他",
}

export function getCategoryLabel(category: ItemCategory): string {
  return categoryLabels[category] ?? "その他"
}

export function getCategoryColor(category: ItemCategory): string {
  return categoryColors[category] ?? "bg-gray-100 text-gray-600"
}

export function getStoreLabel(store: StoreType): string {
  return storeLabels[store] ?? "その他"
}

/** Category groups for display ordering */
export const categoryDisplayOrder: ItemCategory[] = [
  "vegetable",
  "fruit",
  "meat",
  "fish",
  "dairy",
  "egg",
  "grain",
  "seasoning",
  "frozen",
  "snack_food",
  "other_food",
  "baby",
  "cleaning",
  "hygiene",
  "other_daily",
]

export const allCategories: { value: ItemCategory; label: string }[] =
  categoryDisplayOrder.map((c) => ({ value: c, label: getCategoryLabel(c) }))

export const allStores: { value: StoreType; label: string }[] = (
  ["supermarket", "drugstore", "convenience", "online", "other"] as StoreType[]
).map((s) => ({ value: s, label: getStoreLabel(s) }))
