/**
 * 食材登録の案内。食材の自動確定や在庫の自動合算には使わない。
 * 照合・期限・数量の正本は従来どおり server の辞書と pantry-match。
 */
import { foldName, toIngredientIndex, type IngredientDict } from "./normalize"

/** 通信で得た表示値だけを使う。世帯 ID や機密情報は不要。 */
export interface PantryIdentity {
  name: string
  ingredientId: string | null
  /** 登録済み食材でサーバーが解決した辞書名。 */
  catalogName?: string | null
}

export interface PantryExistingItem extends PantryIdentity {
  id: string
  status: "have" | "low" | "out"
}

/** 同じ辞書 ID または未解決の同一表記だけ一致。部位・加工品・由来は同一視しない。 */
export function samePantryIngredient(a: PantryIdentity, b: PantryIdentity): boolean {
  if (a.ingredientId !== null && b.ingredientId !== null) return a.ingredientId === b.ingredientId
  const aNames = [a.name, a.catalogName ?? ""].map(foldName).filter(Boolean)
  const bNames = [b.name, b.catalogName ?? ""].map(foldName).filter(Boolean)
  return aNames.some((name) => bNames.includes(name))
}

/** 使い切った行を、現在ある在庫として警告しない。更新中の行は警告する。 */
export function matchingExistingPantry(
  target: PantryIdentity,
  existing: readonly PantryExistingItem[],
): PantryExistingItem[] {
  return existing.filter((item) => item.status !== "out" && samePantryIngredient(target, item))
}

const SUGGESTION_LIMIT = 4

/** 最大距離までだけ数える。限界超は無限大として扱い、候補を広げすぎない。 */
function boundedEditDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return Number.POSITIVE_INFINITY
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j += 1) {
      const distance = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      current.push(distance)
      rowMin = Math.min(rowMin, distance)
    }
    if (rowMin > limit) return Number.POSITIVE_INFINITY
    previous = current
  }
  return previous[b.length] <= limit ? previous[b.length] : Number.POSITIVE_INFINITY
}

/**
 * 未解決名への候補（表示名・別名から上位 4 件）。推測で ID を返さず、
 * ユーザーが選んだ正式名を登録時に再照合する。短い「豚」「肉」は提示しない。
 */
export function suggestPantryCatalogNames(name: string, dict: IngredientDict): string[] {
  const folded = foldName(name)
  if (folded.length < 3 || folded.length > 40) return []
  const index = toIngredientIndex(dict)
  const suggestions: { name: string; score: number }[] = []
  for (const entry of index.byId.values()) {
    if (entry.generic === true) continue
    let best = Number.POSITIVE_INFINITY
    for (const alias of [entry.name, ...entry.aliases]) {
      const candidate = foldName(alias)
      if (!candidate) continue
      if (folded === candidate) {
        best = 0 // 同音・同表記で複数 ID に当たる場合は、候補を全て提示
        break
      }
      if (candidate.startsWith(folded) || folded.startsWith(candidate)) {
        best = Math.min(best, 3 + Math.abs(candidate.length - folded.length))
        continue
      }
      const limit = Math.min(2, Math.floor(folded.length / 3))
      if (limit < 1) continue
      const distance = boundedEditDistance(folded, candidate, limit)
      if (Number.isFinite(distance)) best = Math.min(best, 10 + distance)
    }
    if (Number.isFinite(best)) suggestions.push({ name: entry.name, score: best })
  }
  suggestions.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, "ja"))
  return suggestions.slice(0, SUGGESTION_LIMIT).map((s) => s.name)
}

/** 総称から、辞書上の実在する具体的な子だけを示す。部位・種類は勝手に決めない。 */
export function specificPantryCatalogNames(ingredientId: string, dict: IngredientDict): string[] {
  const index = toIngredientIndex(dict)
  const parent = index.byId.get(ingredientId)
  if (parent?.generic !== true) return []
  const head = parent.name.replace(/肉$/u, "")
  return [...index.byId.values()]
    .filter((item) => item.generic !== true && (item.derivedFrom ?? []).includes(ingredientId))
    .sort((a, b) => Number(b.name.startsWith(head) && head !== "") - Number(a.name.startsWith(head) && head !== ""))
    .slice(0, SUGGESTION_LIMIT)
    .map((entry) => entry.name)
}
