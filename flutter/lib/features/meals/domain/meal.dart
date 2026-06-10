import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../core/domain/item_category.dart';

part 'meal.freezed.dart';
part 'meal.g.dart';

/// 食事区分。Postgres ENUM `meal_type` に 1:1 対応。
///
/// DB 文字列の正は Next.js 原典 `src/lib/types/database.ts` の `MealType`
/// union 型 (breakfast / lunch / dinner / snack)。
/// 日本語ラベル等の表示拡張は UI を作る F2 で追加する (本 PR はデータ層のみ)。
enum MealType {
  @JsonValue('breakfast')
  breakfast,
  @JsonValue('lunch')
  lunch,
  @JsonValue('dinner')
  dinner,
  @JsonValue('snack')
  snack,
}

/// 献立への評価リアクション。Postgres ENUM `meal_reaction` に 1:1 対応。
///
/// DB 文字列の正は `src/lib/types/database.ts` の `MealReaction` union 型
/// (good / ok / bad)。
enum MealReaction {
  @JsonValue('good')
  good,
  @JsonValue('ok')
  ok,
  @JsonValue('bad')
  bad,
}

/// `meal_ingredients.category` の tolerant パーサ。
///
/// json_serializable 既定の `$enumDecode` は未知値で throw し、1 行の
/// schema drift (ENUM 追加等) が週全体の fetch を AsyncError に倒すため、
/// F0 の `ItemCategory.fromDbValue` (未知値 → [ItemCategory.otherDaily]
/// fallback) を `@JsonKey(fromJson:)` で挟む — `baby_log.dart` の
/// `_numericFromJson` と同じ流儀。null / 非文字列も fallback に倒す。
ItemCategory _itemCategoryFromJson(Object? value) =>
    ItemCategory.fromDbValue(value is String ? value : '');

/// 献立の食材 1 行。`meal_ingredients` の週 select 列
/// (`name, quantity, category`) に 1:1 対応する。
///
/// `quantity` は DB で nullable TEXT (web 側は空文字を null に正規化して
/// insert する。Flutter 側も `MealsRepository` が同じ正規化を行う)。
@freezed
sealed class MealIngredient with _$MealIngredient {
  const factory MealIngredient({
    required String name,
    String? quantity,
    @JsonKey(fromJson: _itemCategoryFromJson) required ItemCategory category,
  }) = _MealIngredient;

  factory MealIngredient.fromJson(Map<String, dynamic> json) =>
      _$MealIngredientFromJson(json);
}

/// 献立へのリアクション 1 件。`meal_reactions` の週 select 列
/// (`user_id, reaction`) に 1:1 対応する。
@freezed
sealed class MealReactionEntry with _$MealReactionEntry {
  const factory MealReactionEntry({
    @JsonKey(name: 'user_id') required String userId,
    required MealReaction reaction,
  }) = _MealReactionEntry;

  factory MealReactionEntry.fromJson(Map<String, dynamic> json) =>
      _$MealReactionEntryFromJson(json);
}

/// 献立 1 件 (nested reactions / ingredients 込み)。
///
/// 列構成は Next.js 版 `meals/page.tsx` の週 select 文字列
/// (`id, date, meal_type, title, is_eating_out, template_id,
/// meal_reactions(user_id, reaction),
/// meal_ingredients(name, quantity, category)`) の row 形と **1:1**。
/// `household_id` / `created_by` / `created_at` は週 select に含まれない
/// (取得は常に household スコープ済みで row 単位では不要) ため、
/// 本モデルでも**持たない** — select 文字列とモデルの drift を防ぐ。
///
/// `date` は DATE 列の "YYYY-MM-DD" を **String のまま** 保持する。
/// `DateTime.parse('YYYY-MM-DD')` は UTC 真夜中扱いになり、端末 TZ 次第で
/// 日付がずれる (CLAUDE.md「UTC 罠」)。日付演算は `core/utils/jst_date.dart`
/// の YMD 文字列関数で行う。
@freezed
sealed class Meal with _$Meal {
  const factory Meal({
    required String id,
    required String date,
    @JsonKey(name: 'meal_type') required MealType mealType,
    required String title,
    @JsonKey(name: 'is_eating_out') required bool isEatingOut,
    @JsonKey(name: 'template_id') String? templateId,
    // nested 配列は埋め込み行が 0 件でも PostgREST が `[]` を返すが、
    // realtime payload 等で欠落/null になっても壊れないよう既定値で防御する
    // (CLAUDE.md「外部APIレスポンスの値は使用前に必ず検証」)。
    @JsonKey(name: 'meal_reactions')
    @Default([])
    List<MealReactionEntry> reactions,
    @JsonKey(name: 'meal_ingredients')
    @Default([])
    List<MealIngredient> ingredients,
  }) = _Meal;

  factory Meal.fromJson(Map<String, dynamic> json) => _$MealFromJson(json);
}
