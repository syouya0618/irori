/// 在庫 UI の表示ユーティリティ (純関数)。
///
/// Next.js 原典の表示ロジックを移植する:
/// - `stock-item.tsx` `getExpiryStatus` → [stockExpiryBadge]
///   (分類そのものは F5 の `classifyExpiry` を使い、ここでは
///   ラベル文言と配色トーンだけを web 1:1 で対応させる)
/// - `stock-list.tsx` `countExpiringItems` → [countExpiringStockItems]
/// - `stock-list.tsx` `grouped` (useMemo) → [groupStockItems]
library;

import 'package:flutter/material.dart';

import '../../../core/domain/item_category.dart';
import '../../../core/theme/colors.dart';
import '../../../core/utils/jst_date.dart';
import '../domain/stock_expiry.dart';
import '../domain/stock_item.dart';

// Tailwind palette (web `stock-item.tsx` の期限バッジ配色トーン)。
// `baby_summary_bar.dart` のファイルローカル const 流儀。
const _redBg = Color(0xFFFEE2E2); // red-100
const _redFg = Color(0xFFB91C1C); // red-700
const _amberBg = Color(0xFFFEF3C7); // amber-100
const _amberFg = Color(0xFFB45309); // amber-700
const _yellowBg = Color(0xFFFEFCE8); // yellow-50
const _yellowFg = Color(0xFFA16207); // yellow-700

/// 数量 (`num`) を web と同じ書式の文字列にする。
///
/// web は JS の Number 文字列化 (`String(2)` → "2"、`String(2.0)` → "2"、
/// `String(1.5)` → "1.5")。Dart VM では `(2.0).toString()` が "2.0" になり
/// web 表示と食い違うため (dart2js は JS 同様 "2")、整数値は int 経由で
/// 文字列化して VM / web の両方で web 表示と一致させる。
String formatStockQuantity(num quantity) {
  // 防御: tolerant パーサ (`_quantityFromJson`) は `num.tryParse("Infinity")`
  // 等の非有限値も通しうる。`truncate()` が throw するため素通しする。
  if (!quantity.isFinite) return quantity.toString();
  if (quantity is int) return quantity.toString();
  final truncated = quantity.truncate();
  if (quantity == truncated) return truncated.toString();
  return quantity.toString();
}

/// 期限バッジの表示仕様 (文言 + 配色)。[background] が null のときは
/// pill 背景なしのプレーン表示 (web `text-muted-foreground` 相当)。
typedef StockExpiryBadge = ({
  String label,
  Color? background,
  Color foreground,
});

/// [expiresAtYmd] を [todayYmd] 基準で分類し、期限バッジの表示仕様を返す。
/// バッジなし (期限未設定 / パース不能) は null。
///
/// web `getExpiryStatus` の戻り値と 1:1:
///
/// | 分類 | label | className |
/// |---|---|---|
/// | expired | 期限切れ | bg-red-100 text-red-700 |
/// | expiresToday | 今日まで | bg-red-100 text-red-700 |
/// | within3Days | あとN日 | bg-amber-100 text-amber-700 |
/// | within7Days | M/D | bg-yellow-50 text-yellow-700 |
/// | normal | M/D | text-muted-foreground (背景なし) |
StockExpiryBadge? stockExpiryBadge(String todayYmd, String? expiresAtYmd) {
  final status = classifyExpiry(todayYmd, expiresAtYmd);
  switch (status) {
    case StockExpiryStatus.none:
      return null;
    case StockExpiryStatus.expired:
      return (label: '期限切れ', background: _redBg, foreground: _redFg);
    case StockExpiryStatus.expiresToday:
      return (label: '今日まで', background: _redBg, foreground: _redFg);
    case StockExpiryStatus.within3Days:
      // classifyExpiry が none 以外を返した時点で両引数はパース可能 (F5 の契約)。
      final diffDays = daysBetweenYmd(todayYmd, expiresAtYmd!);
      return (
        label: 'あと$diffDays日',
        background: _amberBg,
        foreground: _amberFg,
      );
    case StockExpiryStatus.within7Days:
      return (
        label: _monthDayLabel(expiresAtYmd!),
        background: _yellowBg,
        foreground: _yellowFg,
      );
    case StockExpiryStatus.normal:
      return (
        label: _monthDayLabel(expiresAtYmd!),
        background: null,
        foreground: IroriColors.textMuted,
      );
  }
}

/// "YYYY-MM-DD" → "M/D" (web: `Number(parts[1])/Number(parts[2])` —
/// ゼロ詰めなしの月日。タイムゾーン非依存の文字列分解)。
String _monthDayLabel(String ymd) {
  final parts = ymd.split('-');
  return '${int.parse(parts[1])}/${int.parse(parts[2])}';
}

/// 「期限切れ間近」アラートの件数。
///
/// web `stock-list.tsx` `countExpiringItems` (`diffDays <= 3`、期限切れ含む)
/// と同一 — 判定は F5 `StockExpiryStatus.isExpiringAlert` に集約済み。
int countExpiringStockItems(String todayYmd, List<StockItem> items) {
  return items
      .where((item) => classifyExpiry(todayYmd, item.expiresAt).isExpiringAlert)
      .length;
}

/// カテゴリ別グルーピング。web `stock-list.tsx` の `grouped` (useMemo) と
/// 同一セマンティクス:
/// - グループ順は `categoryDisplayOrder` (= [ItemCategory.displayOrder])
/// - 空グループは出さない
/// - グループ内は name 昇順
///
/// 意図的差異: web は `localeCompare(a, b, "ja")` (ICU 照合) だが、Dart 標準には
/// ロケール照合がないためコードユニット順 (`String.compareTo`) で近似する。
/// 同一スクリプト (ひらがな同士・カタカナ同士) では概ね五十音順に一致するが、
/// ひらがな/カタカナ混在時は順序が web とずれうる (fetch 自体は DB 照合順)。
List<(ItemCategory, List<StockItem>)> groupStockItems(List<StockItem> items) {
  final groups = <ItemCategory, List<StockItem>>{};
  for (final item in items) {
    (groups[item.category] ??= []).add(item);
  }
  return [
    for (final category in ItemCategory.displayOrder)
      if (groups[category] != null && groups[category]!.isNotEmpty)
        (category, groups[category]!..sort((a, b) => a.name.compareTo(b.name))),
  ];
}
