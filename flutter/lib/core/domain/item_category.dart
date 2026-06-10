import 'package:freezed_annotation/freezed_annotation.dart';

/// 商品カテゴリ (買い物リスト / 在庫 / 在庫候補で共用)。
///
/// Postgres ENUM `item_category` (15 値) に 1:1 対応。DB 文字列の正は
/// Next.js 原典 `src/lib/types/database.ts` の `ItemCategory` union 型。
/// 日本語ラベル・表示順の正は `src/lib/utils/categories.ts`。
///
/// `@JsonValue` は Phase 2 の freezed モデル (shopping_item / stock_item) の
/// json_serializable codegen 用。codegen を通さない手書きパース経路のために
/// [dbValue] / [fromDbValue] も提供する (両者は同一文字列を保証するよう
/// 各値の宣言行に隣接して記述する)。
enum ItemCategory {
  @JsonValue('vegetable')
  vegetable('vegetable', '野菜'),
  @JsonValue('fruit')
  fruit('fruit', '果物'),
  @JsonValue('meat')
  meat('meat', '肉'),
  @JsonValue('fish')
  fish('fish', '魚介'),
  @JsonValue('dairy')
  dairy('dairy', '乳製品'),
  @JsonValue('egg')
  egg('egg', '卵'),
  @JsonValue('grain')
  grain('grain', '穀物'),
  @JsonValue('seasoning')
  seasoning('seasoning', '調味料'),
  @JsonValue('frozen')
  frozen('frozen', '冷凍'),
  @JsonValue('snack_food')
  snackFood('snack_food', 'お菓子'),
  @JsonValue('other_food')
  otherFood('other_food', 'その他食品'),
  @JsonValue('baby')
  baby('baby', 'ベビー'),
  @JsonValue('cleaning')
  cleaning('cleaning', '洗剤'),
  @JsonValue('hygiene')
  hygiene('hygiene', '衛生用品'),
  @JsonValue('other_daily')
  otherDaily('other_daily', 'その他');

  const ItemCategory(this.dbValue, this.label);

  /// Postgres ENUM `item_category` の文字列値 (`@JsonValue` と同一)。
  final String dbValue;

  /// 日本語表示ラベル。原典 `categories.ts` の `categoryLabels` と一致。
  final String label;

  /// DB 文字列から enum 値を復元する tolerant パーサ。
  ///
  /// 未知値は例外ではなく [otherDaily] に fallback する。原典
  /// `getCategoryLabel` の `?? "その他"` と同じ方針で、`baby_log.dart` の
  /// tolerant パーサ流儀 (1 行の schema drift でリスト全体を
  /// AsyncError に倒さない) を踏襲する。
  static ItemCategory fromDbValue(String value) {
    for (final category in values) {
      if (category.dbValue == value) return category;
    }
    return otherDaily;
  }

  /// UI 表示順。原典 `categories.ts` の `categoryDisplayOrder` と一致。
  ///
  /// 現状は宣言順 (= `values`) と同一だが、原典が表示順を独立配列で
  /// 管理しているため、将来 web 側の並べ替えに追随できるよう明示する。
  static const List<ItemCategory> displayOrder = [
    vegetable,
    fruit,
    meat,
    fish,
    dairy,
    egg,
    grain,
    seasoning,
    frozen,
    snackFood,
    otherFood,
    baby,
    cleaning,
    hygiene,
    otherDaily,
  ];
}
