/// テンプレート × 在庫のマッチング (純関数)。
///
/// Next.js 原典 `src/lib/domain/matching.ts` の 1:1 移植 (Phase 2.5 PR-A)。
library;

import 'normalize.dart';
import 'types.dart';

/// マッチした食材と、対応する在庫アイテムのペア。
/// 原典 `MatchResult["matched"]` の要素。
typedef MatchedStockPair = ({
  TemplateIngredient ingredient,
  StockItemInput stockItem,
});

/// 1 テンプレート分のマッチング結果。原典 `MatchResult`。
class MatchResult {
  const MatchResult({
    required this.matched,
    required this.missing,
    required this.matchRate,
  });

  /// マッチした食材と、対応する在庫アイテム。
  final List<MatchedStockPair> matched;

  /// マッチしなかった食材。
  final List<TemplateIngredient> missing;

  /// マッチ率 (matched / total、total=0 の場合は 0)。
  final double matchRate;
}

/// 1 つのテンプレートに対して在庫リストをマッチングする純関数。
///
/// 各テンプレート食材について、**未使用の** 在庫アイテムから最初にマッチした
/// ものを紐付ける。同じ在庫アイテムは 1 つのテンプレート食材にのみ使われる
/// (`usedStockIds` による重複使用防止 — CLAUDE.md 既知の罠。原典
/// `matching.ts:50-66` の防御で、削除禁止)。
///
/// 例: 在庫に「玉ねぎ」が 1 つしかない場合、テンプレートに「玉ねぎA」
/// 「玉ねぎB」があっても、片方だけがマッチしてもう片方は不足扱いになる。
MatchResult matchStockToTemplate(
  TemplateInput template,
  List<StockItemInput> stockItems,
  int minMatchLength,
) {
  final total = template.ingredients.length;
  if (total == 0) {
    return const MatchResult(matched: [], missing: [], matchRate: 0);
  }

  // 在庫名を先に正規化しておき、内部ループで重複正規化を避ける。
  final normalizedStock = [
    for (final item in stockItems)
      (item: item, normalized: normalizeIngredientName(item.name)),
  ];

  final matched = <MatchedStockPair>[];
  final missing = <TemplateIngredient>[];
  final usedStockIds = <String>{};

  for (final ingredient in template.ingredients) {
    final normalizedIngredient = normalizeIngredientName(ingredient.name);
    // 原典の `Array.find` 相当: 条件を満たす最初の在庫を線形探索する
    // (`package:collection` の firstWhereOrNull は直接依存に無いため不使用)。
    ({StockItemInput item, String normalized})? found;
    for (final entry in normalizedStock) {
      if (!usedStockIds.contains(entry.item.id) &&
          normalizedIngredientsMatch(
            entry.normalized,
            normalizedIngredient,
            minMatchLength,
          )) {
        found = entry;
        break;
      }
    }
    if (found != null) {
      usedStockIds.add(found.item.id);
      matched.add((ingredient: ingredient, stockItem: found.item));
    } else {
      missing.add(ingredient);
    }
  }

  return MatchResult(
    matched: matched,
    missing: missing,
    matchRate: matched.length / total,
  );
}
