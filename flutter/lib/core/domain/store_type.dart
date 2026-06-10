import 'package:freezed_annotation/freezed_annotation.dart';

/// 店舗タイプ (買い物リストの店舗別タブ / 店舗フィルタで共用)。
///
/// Postgres ENUM `store_type` (5 値) に 1:1 対応。DB 文字列の正は
/// Next.js 原典 `src/lib/types/database.ts` の `StoreType` union 型。
/// 日本語ラベル・表示順の正は `src/lib/utils/categories.ts` (`storeLabels` /
/// `allStores`)。
///
/// `@JsonValue` は Phase 2 の freezed モデルの json_serializable codegen 用。
/// codegen を通さない手書きパース経路のために [dbValue] / [fromDbValue] も
/// 提供する (`item_category.dart` と同じ構成)。
enum StoreType {
  @JsonValue('supermarket')
  supermarket('supermarket', 'スーパー'),
  @JsonValue('drugstore')
  drugstore('drugstore', 'ドラッグストア'),
  @JsonValue('convenience')
  convenience('convenience', 'コンビニ'),
  @JsonValue('online')
  online('online', 'ネット'),
  @JsonValue('other')
  other('other', 'その他');

  const StoreType(this.dbValue, this.label);

  /// Postgres ENUM `store_type` の文字列値 (`@JsonValue` と同一)。
  final String dbValue;

  /// 日本語表示ラベル。原典 `categories.ts` の `storeLabels` と一致。
  final String label;

  /// DB 文字列から enum 値を復元する tolerant パーサ。
  ///
  /// 未知値は例外ではなく [other] に fallback する。原典 `getStoreLabel` の
  /// `?? "その他"` と同じ方針 (`ItemCategory.fromDbValue` と一貫)。
  static StoreType fromDbValue(String value) {
    for (final store in values) {
      if (store.dbValue == value) return store;
    }
    return other;
  }

  /// UI 表示順。原典 `categories.ts` の `allStores` の順と一致。
  static const List<StoreType> displayOrder = [
    supermarket,
    drugstore,
    convenience,
    online,
    other,
  ];
}
