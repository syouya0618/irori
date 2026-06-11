/// 食材名の正規化・マッチ判定 (純関数)。
///
/// Next.js 原典 `src/lib/domain/normalize.ts` の 1:1 移植 (Phase 2.5 PR-A)。
/// JS と Dart で `trim` / `toLowerCase` / `contains` / `length` (UTF-16
/// コードユニット数) のセマンティクスは本ドメインの入力 (日本語・ASCII の
/// 食材名) で一致する — 挙動同値性は `normalize_test.dart` (原典テスト全
/// ケース移植) で機械検証する。
library;

/// 食材名を比較用に正規化する。
/// - 前後空白の除去
/// - 全角空白→半角
/// - 大文字→小文字
///
/// 原典 `normalizeIngredientName`。原典と同じく「全角空白 (U+3000) の置換 →
/// trim → 小文字化」の順で適用する (置換が先でないと全角空白だけの前後余白
/// が trim されない)。
String normalizeIngredientName(String name) {
  return name.replaceAll('　', ' ').trim().toLowerCase();
}

/// 正規化済み食材名同士でマッチ判定する。内部ループで正規化の反復実行を
/// 避けるため、呼び出し側で事前正規化した文字列を渡す用途。
/// 完全一致 OR 一方が他方を含む場合にマッチ。
/// ただし [minMatchLength] 未満の名前は完全一致のみで判定
/// (「肉」と「鶏肉」のような誤マッチ防止)。
///
/// 原典 `normalizedIngredientsMatch`。
bool normalizedIngredientsMatch(String a, String b, int minMatchLength) {
  if (a.isEmpty || b.isEmpty) return false;
  if (a == b) return true;
  if (a.length < minMatchLength || b.length < minMatchLength) {
    return false;
  }
  return a.contains(b) || b.contains(a);
}

/// 2 つの食材名が一致するか判定する (正規化を内部で行う簡易版)。
///
/// 原典 `ingredientsMatch`。
bool ingredientsMatch(String nameA, String nameB, int minMatchLength) {
  return normalizedIngredientsMatch(
    normalizeIngredientName(nameA),
    normalizeIngredientName(nameB),
    minMatchLength,
  );
}
