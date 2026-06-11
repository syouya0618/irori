/// レシピ提案 domain の型定義。
///
/// Next.js 原典 `src/lib/domain/types.ts` の 1:1 移植。DB 非依存の純粋な
/// 入出力型のみを置く (Phase 2.5 PR-A)。利用側:
/// - 在庫タブのレシピ提案 section / テンプレート選択ダイアログの提案タブ
///   (PR-F が `rankSuggestions` を消費)。
///
/// 設計メモ:
/// - 入力型は web 同様の軽量型 (plain class)。freezed の `StockItem` /
///   `MealTemplate` へ直結合しない — domain が data 層モデルの schema 変化に
///   引きずられないようにする (計画の裁定)。
/// - [MealReaction] は `features/meals/domain/meal.dart` の DB ENUM 写像
///   enum を再利用する。core → features の参照になるが、同一 DB ENUM の
///   enum を core に複製すると将来の値追加で乖離リスクがあるため再利用を
///   優先 (移設は本 PR の関心事外)。
library;

import '../../../features/meals/domain/meal.dart' show MealReaction;
import '../item_category.dart';

/// `meal_templates.ingredients` JSONB の各要素。原典 `TemplateIngredient`。
class TemplateIngredient {
  const TemplateIngredient({
    required this.name,
    required this.quantity,
    required this.category,
  });

  final String name;
  final String quantity;
  final ItemCategory category;
}

/// Domain 層が扱う在庫アイテムの最小限の型。原典 `StockItemInput`。
class StockItemInput {
  const StockItemInput({
    required this.id,
    required this.name,
    required this.category,
    required this.expiresAt,
  });

  final String id;
  final String name;
  final ItemCategory category;

  /// 賞味期限 (YYYY-MM-DD)。原典 `expires_at: string | null`。
  final String? expiresAt;
}

/// Domain 層が扱うテンプレート + 過去リアクション。原典 `TemplateInput`。
class TemplateInput {
  const TemplateInput({
    required this.id,
    required this.title,
    required this.ingredients,
    required this.reactionHistory,
  });

  final String id;
  final String title;
  final List<TemplateIngredient> ingredients;

  /// このテンプレートを使って作った献立の全リアクション。
  final List<MealReaction> reactionHistory;
}

/// マッチした食材 1 件の表示用情報。原典 `RecipeSuggestion.matchedIngredients`
/// の要素 `{ name, isExpiring }`。record で構造的等価性を得る (テスト容易性)。
typedef MatchedIngredient = ({String name, bool isExpiring});

/// スコア内訳 (デバッグ用・UI のマッチ率表示用)。原典 `scoreBreakdown`。
///
/// - `matchRate`: 食材のマッチ率 0.0〜1.0
/// - `expiryBonus`: 期限切れ間近食材ボーナス 0.0〜0.3
/// - `reactionScore`: リアクション補正 -0.1〜0.2
typedef ScoreBreakdown = ({
  double matchRate,
  double expiryBonus,
  double reactionScore,
});

/// 1 件のマッチング結果。原典 `RecipeSuggestion`。
class RecipeSuggestion {
  const RecipeSuggestion({
    required this.templateId,
    required this.title,
    required this.score,
    required this.scoreBreakdown,
    required this.matchedIngredients,
    required this.missingIngredients,
    required this.hasExpiringStock,
  });

  final String templateId;
  final String title;

  /// 総合スコア (matchRate + expiryBonus + reactionScore)。
  final double score;

  final ScoreBreakdown scoreBreakdown;

  /// マッチした食材の情報。
  final List<MatchedIngredient> matchedIngredients;

  /// 不足している食材。
  final List<TemplateIngredient> missingIngredients;

  /// 期限切れ間近の食材が含まれるか (UI バッジ用)。
  final bool hasExpiringStock;
}

/// スコアリング設定。原典 `ScoringConfig`。
///
/// 原典の `Partial<ScoringConfig>` + spread merge (`{...DEFAULT, ...config}`)
/// は、Dart ではコンストラクタ既定値で等価表現する — 未指定の値は常に
/// [defaultScoringConfig] と同じ値になる (例: `ScoringConfig(topN: 5)`)。
class ScoringConfig {
  const ScoringConfig({
    this.expiryBonusThresholdDays = 3,
    this.expiryBonusPerItem = 0.1,
    this.expiryBonusMax = 0.3,
    this.goodReactionBonus = 0.05,
    this.badReactionPenalty = 0.05,
    this.reactionScoreMax = 0.2,
    this.reactionScoreMin = -0.1,
    this.topN = 10,
    this.minMatchLength = 2,
  });

  /// 賞味期限ボーナスの閾値 (日数)。
  final int expiryBonusThresholdDays;

  /// 期限間近食材 1 件あたりのボーナス。
  final double expiryBonusPerItem;

  /// 賞味期限ボーナスの上限。
  final double expiryBonusMax;

  /// good リアクション 1 件あたりのボーナス。
  final double goodReactionBonus;

  /// bad リアクション 1 件あたりのペナルティ。
  final double badReactionPenalty;

  /// リアクションスコアの上限。
  final double reactionScoreMax;

  /// リアクションスコアの下限。
  final double reactionScoreMin;

  /// 上位何件まで返すか。
  final int topN;

  /// 最小マッチ長 (これ未満の食材名は完全一致のみ)。
  final int minMatchLength;
}

/// 原典 `DEFAULT_SCORING_CONFIG` の 9 値 (Dart 命名規約により lowerCamelCase)。
///
/// 全 9 値は `scoring_test.dart` で web と同値であることを assert している。
const ScoringConfig defaultScoringConfig = ScoringConfig();
