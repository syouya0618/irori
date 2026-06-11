import 'package:freezed_annotation/freezed_annotation.dart';

import 'meal.dart';

part 'meal_template.freezed.dart';
part 'meal_template.g.dart';

/// `loadTemplate` がフォームへ返す prefill (web `loadTemplate` の
/// `data: { title, ingredients }` に相当)。`MealsMutationContext` と同じ
/// record typedef 流儀。
typedef MealTemplatePrefill = ({
  String title,
  List<MealIngredient> ingredients,
});

/// `meal_templates.ingredients` (JSONB) の防御的パーサ。
///
/// web は `template.ingredients as unknown as MealIngredientInput[]` の
/// **無検証 cast** (`meals/actions.ts:329`) だが、Dart で同じことをすると
/// 1 行の破損 JSONB が `getTemplates` 全体 (= 選択ダイアログ全体) を
/// AsyncError に倒す (p25plan risks)。意図的に web より防御を厚くする:
///
/// - 非配列 (文字列 / 数値 / オブジェクト / null / キー欠落) → 空リスト
/// - 配列要素のうち Map でないもの → その要素のみ skip
/// - Map 要素は [MealIngredient.fromJson] の tolerant 経路へ
///   (category 欠落/未知/非文字列 → otherDaily fallback)
/// - それでも throw する shape (name 欠落等、食材として成立しない要素) は
///   その要素のみ skip し、残りの正常要素は生かす
///
/// `MealsRepository.loadTemplate` も同じパーサを通す (防御線を一本化)。
List<MealIngredient> mealTemplateIngredientsFromJson(Object? value) {
  if (value is! List) return const [];
  final parsed = <MealIngredient>[];
  for (final element in value) {
    if (element is! Map<String, dynamic>) continue;
    try {
      parsed.add(MealIngredient.fromJson(element));
    } on Object {
      // name 欠落 / 非文字列 / quantity 非文字列など「食材として成立しない
      // 要素」のみ捨て、残りを生かす (関数 doc の防御方針)。エラー詳細の
      // ログは出さない — fetch のたび呼ばれるモデル層パーサで、欠落の検知は
      // この関数のテストと UI 上の食材数で機械的に可能なため
      // (`StockItem._quantityFromJson` と同じ silent fallback 流儀)。
      continue;
    }
  }
  return parsed;
}

/// 献立テンプレート 1 件。`getTemplates` の select 列
/// (`id, title, ingredients, created_at`) に **1:1** 対応する。
///
/// `household_id` / `created_by` / `description` / `updated_at` は
/// select に含まれない (取得は常に household スコープ済み) ため持たない —
/// select 文字列とモデルの drift を防ぐ (`Meal` と同じ方針)。
///
/// `ingredients` は JSONB 列のため PostgREST の型保証が無い。
/// [mealTemplateIngredientsFromJson] で防御的にパースする (関数 doc 参照)。
/// `created_at` は TIMESTAMPTZ (ISO 8601) → `DateTime` (`StockItem` と同じ)。
@freezed
sealed class MealTemplate with _$MealTemplate {
  const factory MealTemplate({
    required String id,
    required String title,
    @JsonKey(fromJson: mealTemplateIngredientsFromJson)
    required List<MealIngredient> ingredients,
    @JsonKey(name: 'created_at') required DateTime createdAt,
  }) = _MealTemplate;

  factory MealTemplate.fromJson(Map<String, dynamic> json) =>
      _$MealTemplateFromJson(json);
}
