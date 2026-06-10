import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../core/domain/item_category.dart';
import '../../../core/domain/store_type.dart';

part 'shopping_item.freezed.dart';
part 'shopping_item.g.dart';

/// `shopping_items.category` の tolerant パーサ。
///
/// json_serializable 既定の `$enumDecode` は未知値で throw し、1 行の
/// schema drift (ENUM 追加等) がリスト全体の fetch を AsyncError に倒すため、
/// F0 の `ItemCategory.fromDbValue` (未知値 → [ItemCategory.otherDaily]
/// fallback) を `@JsonKey(fromJson:)` で挟む — F1 `meal.dart` の
/// `_itemCategoryFromJson` と同じ流儀。null / 非文字列も fallback に倒す。
ItemCategory _itemCategoryFromJson(Object? value) =>
    ItemCategory.fromDbValue(value is String ? value : '');

/// `shopping_items.store_type` の tolerant パーサ。
///
/// 未知値 / null / 非文字列は F0 の `StoreType.fromDbValue` により
/// [StoreType.other] に fallback する ([_itemCategoryFromJson] と同方針)。
StoreType _storeTypeFromJson(Object? value) =>
    StoreType.fromDbValue(value is String ? value : '');

/// 買い物リストのアイテム 1 件。
///
/// 列構成は Next.js 原典 `src/lib/types/database.ts` の
/// `shopping_items.Row` (13 列) と **1:1 全列**。web `shopping/page.tsx` の
/// 初期 select は 9 列だが、Realtime payload (`payload.new`) は**フル行**で
/// 届くため、reducer (`ShoppingItemsNotifier`) が fetch 結果と payload を
/// 同一モデルで畳み込めるよう全列を持つ (`MealsRepository` の
/// `_kWeekMealColumns` doc コメント / baby `updated_at` と同じ理由)。
/// fetch 側 (`ShoppingRepository.fetchItems`) も同じ 13 列を select する。
///
/// Dart 型対応:
/// - `quantity` : nullable TEXT → `String?`
/// - `checked_at` : nullable timestamptz → `DateTime?` (supabase は UTC で返す)
/// - `sort_order` : integer → `int` (PostgREST は int 列を確実に JSON 数値で
///   返すため tolerant パーサ不要 — `baby_log.dart` の方針)
@freezed
sealed class ShoppingItem with _$ShoppingItem {
  const factory ShoppingItem({
    required String id,
    @JsonKey(name: 'household_id') required String householdId,
    required String name,
    String? quantity,
    @JsonKey(fromJson: _itemCategoryFromJson) required ItemCategory category,
    @JsonKey(name: 'store_type', fromJson: _storeTypeFromJson)
    required StoreType storeType,
    @JsonKey(name: 'is_checked') required bool isChecked,
    @JsonKey(name: 'checked_by') String? checkedBy,
    @JsonKey(name: 'checked_at') DateTime? checkedAt,
    @JsonKey(name: 'meal_id') String? mealId,
    @JsonKey(name: 'sort_order') required int sortOrder,
    @JsonKey(name: 'created_by') required String createdBy,
    @JsonKey(name: 'created_at') required DateTime createdAt,
  }) = _ShoppingItem;

  factory ShoppingItem.fromJson(Map<String, dynamic> json) =>
      _$ShoppingItemFromJson(json);
}
