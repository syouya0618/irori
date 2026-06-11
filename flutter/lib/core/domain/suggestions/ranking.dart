/// レシピ提案のランキング (純関数)。Domain 層の唯一の公開エントリポイント。
///
/// Next.js 原典 `src/lib/domain/ranking.ts` の 1:1 移植 (Phase 2.5 PR-A)。
library;

import 'dart:math' as math;

import 'matching.dart';
import 'scoring.dart';
import 'types.dart';

/// テンプレートリストと在庫リストを受け取り、スコア降順で上位 N 件を返す。
/// マッチ率が 0 のテンプレートは結果から除外する。
///
/// 原典 `rankSuggestions`。原典の `Partial<ScoringConfig>` merge は
/// [ScoringConfig] のコンストラクタ既定値で等価表現する (`types.dart` 参照)。
/// [today] 省略時は現在時刻 (原典 `today: Date = new Date()`)。
///
/// ## score 同点の並び安定化 (web parity の必須要件)
///
/// 原典は V8 の安定 sort (ES2019 保証) に依存し、同点テンプレートの並びが
/// 入力順 (= DB の返却順) になる。Dart の `List.sort` は**安定性非保証**の
/// ため、素朴に sort すると同点の並びが実行ごとに揺れ、提案カードの順序が
/// web と乖離する。「元 index で decorate → (score 降順, index 昇順) で
/// sort」して入力順を機械的に保存する (Phase 2.5 計画の risks 参照。
/// `ranking_test.dart` の同点 50 件ケースで防御)。
List<RecipeSuggestion> rankSuggestions(
  List<TemplateInput> templates,
  List<StockItemInput> stockItems, {
  ScoringConfig config = defaultScoringConfig,
  DateTime? today,
}) {
  // `formatJstDate` と同じ「省略時のみ now」規約 (jst_date.dart 設計方針)。
  final now = today ?? DateTime.now();

  final results = <RecipeSuggestion>[];

  for (final template in templates) {
    final matchResult = matchStockToTemplate(
      template,
      stockItems,
      config.minMatchLength,
    );

    if (matchResult.matchRate == 0) continue;

    // daysUntilExpiry を 1 回だけ計算し、matchedIngredients と expiryBonus の
    // 両方で共有する (原典と同じ最適化)。
    var expiringCount = 0;
    final matchedIngredients = <MatchedIngredient>[];
    for (final pair in matchResult.matched) {
      final days = daysUntilExpiry(pair.stockItem.expiresAt, now);
      final isExpiring =
          days != null && days <= config.expiryBonusThresholdDays;
      if (isExpiring) expiringCount++;
      matchedIngredients.add((
        name: pair.ingredient.name,
        isExpiring: isExpiring,
      ));
    }

    final expiryBonus = math.min(
      expiringCount * config.expiryBonusPerItem,
      config.expiryBonusMax,
    );
    final reactionScore = calculateReactionScore(
      template.reactionHistory,
      config,
    );

    results.add(
      RecipeSuggestion(
        templateId: template.id,
        title: template.title,
        score: matchResult.matchRate + expiryBonus + reactionScore,
        scoreBreakdown: (
          matchRate: matchResult.matchRate,
          expiryBonus: expiryBonus,
          reactionScore: reactionScore,
        ),
        matchedIngredients: matchedIngredients,
        missingIngredients: matchResult.missing,
        hasExpiringStock: expiringCount > 0,
      ),
    );
  }

  // 安定 sort: 元 index で decorate → (score 降順, 同点は index 昇順)。
  final indexed = [
    for (var i = 0; i < results.length; i++) (index: i, suggestion: results[i]),
  ];
  indexed.sort((a, b) {
    final byScore = b.suggestion.score.compareTo(a.suggestion.score);
    if (byScore != 0) return byScore;
    return a.index.compareTo(b.index);
  });

  // 原典 `.slice(0, topN)` — topN が件数を超える場合は全件。
  return [for (final entry in indexed.take(config.topN)) entry.suggestion];
}
