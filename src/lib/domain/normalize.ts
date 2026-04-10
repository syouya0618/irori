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
 * 正規化済み食材名同士でマッチ判定する。内部ループで正規化の反復実行を避けるため、
 * 呼び出し側で事前正規化した文字列を渡す用途。
 * 完全一致 OR 一方が他方を includes する場合にマッチ。
 * ただし minMatchLength 未満の名前は完全一致のみで判定（"肉"と"鶏肉"のような誤マッチ防止）。
 */
export function normalizedIngredientsMatch(
  a: string,
  b: string,
  minMatchLength: number,
): boolean {
  if (a.length === 0 || b.length === 0) return false
  if (a === b) return true
  if (a.length < minMatchLength || b.length < minMatchLength) {
    return false
  }
  return a.includes(b) || b.includes(a)
}

/**
 * 2つの食材名が一致するか判定する（正規化を内部で行う簡易版）。
 */
export function ingredientsMatch(
  nameA: string,
  nameB: string,
  minMatchLength: number,
): boolean {
  return normalizedIngredientsMatch(
    normalizeIngredientName(nameA),
    normalizeIngredientName(nameB),
    minMatchLength,
  )
}
