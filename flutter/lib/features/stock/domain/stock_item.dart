import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../core/domain/item_category.dart';

part 'stock_item.freezed.dart';
part 'stock_item.g.dart';

/// `stock_items.category` の tolerant パーサ。
///
/// json_serializable 既定の `$enumDecode` は未知値で throw し、1 行の
/// schema drift (ENUM 追加等) が在庫一覧全体の fetch を AsyncError に倒すため、
/// F0 の `ItemCategory.fromDbValue` (未知値 → [ItemCategory.otherDaily]
/// fallback) を `@JsonKey(fromJson:)` で挟む — `meal.dart` の
/// `_itemCategoryFromJson` と同じ流儀。null / 非文字列も fallback に倒す。
ItemCategory _itemCategoryFromJson(Object? value) =>
    ItemCategory.fromDbValue(value is String ? value : '');

/// `stock_items.quantity` (Postgres `NUMERIC NOT NULL DEFAULT 1`) の
/// tolerant パーサ。**値を保存する** (丸めない)。
///
/// `numeric` 列は PostgREST が JSON 数値ではなく **引用符付き文字列** で返す
/// 場合がある (`baby_log.dart` の `_numericFromJson` で確認済みの挙動)。
/// また web のフォームは `step="0.1"` で小数も許す (DB も NUMERIC) ため、
/// int / double / String のいずれが来ても壊れないよう `num` で吸収する
/// (同じ NUMERIC 列を double で受ける baby_log の temperature/height_cm と
/// 内部整合)。
///
/// **`int` + `round()` にしない理由 (PR #19 レビュー指摘)**: web が 1.5 を
/// 保存 → Flutter が 2 に丸めて保持 → 別項目 (期限等) の編集保存で
/// `updateItem` が 2 を書き戻し → DB の 1.5 が恒久的に破壊される経路ができる
/// (CLAUDE.md「外部APIレスポンスの値で既存値を破壊しない」違反)。
/// パース不能・null は web `parseStockFormData` の `|| 1` / DB DEFAULT 1 と
/// 同じ fallback 値 1 に倒し、1 行の異常で一覧全体を落とさない。
num _quantityFromJson(Object? value) {
  if (value is num) return value;
  if (value is String) {
    final parsed = num.tryParse(value);
    if (parsed != null) return parsed;
  }
  return 1;
}

/// 在庫アイテム 1 件。`stock_items` 実スキーマ (10 列) に **1:1** 対応する。
///
/// 列構成の正は Next.js 原典 `src/lib/types/database.ts` の
/// `stock_items.Row`。Dart 型対応:
/// - `quantity` : Postgres `numeric` → `num` (値保存の tolerant パーサ —
///   丸めると fetch→update 往復で web の小数在庫を破壊するため丸めない)
/// - `expires_at` : DATE 列の "YYYY-MM-DD" を **String? のまま** 保持する。
///   `DateTime.parse('YYYY-MM-DD')` は UTC 真夜中扱いになり、端末 TZ 次第で
///   日付がずれる (CLAUDE.md「UTC 罠」)。期限の日数計算は
///   `core/utils/jst_date.dart` の `daysBetweenYmd` / `stock_expiry.dart` で行う。
/// - timestamptz 列 (`created_at` / `updated_at`) : ISO 8601 文字列 → `DateTime`
///
/// web の一覧 select (`cached-queries.ts`) は `household_id` を含まないが、
/// Flutter 版は Row 1:1 (realtime payload との整合) のため select に追加して
/// 取得する (`StockRepository._kStockItemColumns` 参照)。
@freezed
sealed class StockItem with _$StockItem {
  const factory StockItem({
    required String id,
    @JsonKey(name: 'household_id') required String householdId,
    required String name,
    @JsonKey(fromJson: _itemCategoryFromJson) required ItemCategory category,
    @JsonKey(fromJson: _quantityFromJson) required num quantity,
    String? unit,
    @JsonKey(name: 'expires_at') String? expiresAt,
    @JsonKey(name: 'created_by') required String createdBy,
    @JsonKey(name: 'created_at') required DateTime createdAt,
    // updated_at は NOT NULL だが、realtime payload 等での欠落に備えて
    // nullable で受ける (`baby_log.dart` と同じ防御)。
    @JsonKey(name: 'updated_at') DateTime? updatedAt,
  }) = _StockItem;

  factory StockItem.fromJson(Map<String, dynamic> json) =>
      _$StockItemFromJson(json);
}
