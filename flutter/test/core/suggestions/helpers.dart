/// レシピ提案 domain テスト用ファクトリ。
///
/// Next.js 原典 `src/lib/domain/__tests__/helpers.ts` の 1:1 移植。
/// 原典の `Partial<...>` overrides は Dart の named optional 引数で表現する
/// (テストが実際に override するのは `id` / `expires_at` のみ)。
library;

import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/domain/suggestions/matching.dart';
import 'package:irori/core/domain/suggestions/types.dart';
import 'package:irori/features/meals/domain/meal.dart' show MealReaction;

/// テスト用の [StockItemInput] を作成するファクトリ。原典 `mkStock`。
StockItemInput mkStock(
  String name, {
  String? id,
  ItemCategory category = ItemCategory.otherFood,
  String? expiresAt,
}) {
  return StockItemInput(
    id: id ?? 's-$name',
    name: name,
    category: category,
    expiresAt: expiresAt,
  );
}

/// テスト用の [TemplateInput] を作成するファクトリ。原典 `mkTemplate`。
///
/// 原典は `Array<string | { name; quantity? }>` を受けるが、テストで使われる
/// 実体は名前のみ (quantity は常に既定の "1個") のため、Dart 側は
/// `List<String>` で受ける。
TemplateInput mkTemplate(
  String id,
  List<String> ingredientNames, [
  List<MealReaction> reactionHistory = const [],
]) {
  return TemplateInput(
    id: id,
    title: 'テンプレ$id',
    ingredients: [
      for (final name in ingredientNames)
        TemplateIngredient(
          name: name,
          quantity: '1個',
          category: ItemCategory.otherFood,
        ),
    ],
    reactionHistory: reactionHistory,
  );
}

/// `MatchResult.matched` 形式を [StockItemInput] から構築する。原典 `mkMatched`。
List<MatchedStockPair> mkMatched(List<StockItemInput> stockItems) {
  return [
    for (final stockItem in stockItems)
      (
        ingredient: TemplateIngredient(
          name: stockItem.name,
          quantity: '1個',
          category: stockItem.category,
        ),
        stockItem: stockItem,
      ),
  ];
}
