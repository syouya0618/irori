/**
 * 食材名を比較用に正規化する。
 * - 前後空白の除去
 * - 全角空白→半角
 * - 大文字→小文字
 */
export function normalizeIngredientName(name: string): string {
  return name
    .replace(/\u3000/g, " ")
    .trim()
    .toLowerCase()
}

/**
 * 2つの食材名が一致するか判定する。
 * 完全一致 OR 一方が他方を includes する場合にマッチ。
 * ただし minMatchLength 未満の名前は完全一致のみで判定（"肉"と"鶏肉"のような誤マッチ防止）。
 */
export function ingredientsMatch(
  nameA: string,
  nameB: string,
  minMatchLength: number,
): boolean {
  const a = normalizeIngredientName(nameA)
  const b = normalizeIngredientName(nameB)

  if (a.length === 0 || b.length === 0) return false
  if (a === b) return true

  // 短い名前は完全一致のみ
  if (a.length < minMatchLength || b.length < minMatchLength) {
    return false
  }

  return a.includes(b) || b.includes(a)
}
