/**
 * 売場（買い物リスト・在庫のまとまり）の表示名と並び順。
 *
 * 境界指令を持たない中立モジュール。区分は Irori 独自の定義で、
 * 店内を一巡する順（青果 → 精肉 → 鮮魚 → 卵・乳 → 豆腐 → 主食 → 調味料 → その他）に並べる。
 */
import type { StoreSection } from "@/lib/meals/types"

export interface StoreSectionDef {
  id: StoreSection
  label: string
}

/** 並び順の正本。配列の順がそのまま表示順。 */
export const STORE_SECTIONS: readonly StoreSectionDef[] = [
  { id: "vegetable", label: "野菜・きのこ・果物" },
  { id: "meat", label: "肉・肉加工品" },
  { id: "fish", label: "魚・魚加工品" },
  { id: "egg_dairy", label: "卵・乳製品" },
  { id: "soy", label: "豆腐・大豆製品" },
  { id: "staple", label: "米・麺・パン" },
  { id: "seasoning", label: "調味料・粉類" },
  { id: "other", label: "乾物・缶詰・その他" },
]

export const STORE_SECTION_LABELS: Readonly<Record<StoreSection, string>> = {
  vegetable: "野菜・きのこ・果物",
  meat: "肉・肉加工品",
  fish: "魚・魚加工品",
  egg_dairy: "卵・乳製品",
  soy: "豆腐・大豆製品",
  staple: "米・麺・パン",
  seasoning: "調味料・粉類",
  other: "乾物・缶詰・その他",
}

const SECTION_ORDER: ReadonlyMap<string, number> = new Map(
  STORE_SECTIONS.map((s, i) => [s.id, i]),
)

/**
 * 並び替え用の順位。未知の値（DB に残った古い区分など）は末尾へ送り、落とさない。
 */
export function storeSectionOrder(section: string): number {
  return SECTION_ORDER.get(section) ?? STORE_SECTIONS.length
}

/** 表示名。未知の値は「その他」の表示へ退化させる。 */
export function storeSectionLabel(section: string): string {
  return (
    STORE_SECTIONS.find((s) => s.id === section)?.label ??
    STORE_SECTION_LABELS.other
  )
}
