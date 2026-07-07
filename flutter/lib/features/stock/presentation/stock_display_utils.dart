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

import '../../../core/domain/consumption_rate.dart';
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
const _blueBg = Color(0xFFEFF6FF); // blue-50
const _blueFg = Color(0xFF1D4ED8); // blue-700

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
/// [mutedForeground] は「normal」(期限内 / 背景なし) の文字色。純関数のため
/// context を取れず、呼び出し側 (widget) が `context.colors.textMuted` を渡して
/// dark でも反転させる。既定は light の [IroriColors.textMuted] (テストや
/// context 非依存の直接呼び出し互換)。
StockExpiryBadge? stockExpiryBadge(
  String todayYmd,
  String? expiresAtYmd, {
  Color mutedForeground = IroriColors.textMuted,
}) {
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
        foreground: mutedForeground,
      );
  }
}

/// "YYYY-MM-DD" → "M/D" (web: `Number(parts[1])/Number(parts[2])` —
/// ゼロ詰めなしの月日。タイムゾーン非依存の文字列分解)。
String _monthDayLabel(String ymd) {
  final parts = ymd.split('-');
  return '${int.parse(parts[1])}/${int.parse(parts[2])}';
}

/// 残日数バッジ (消費レートベース、PR-G)。バッジなし (レート算出不能) は
/// null。戻り値の typedef は期限バッジと同 shape のため [StockExpiryBadge]
/// を共用する。
///
/// web `stock-item.tsx` `getRemainingDaysStatus` と 1:1:
///
/// | 条件 | label | className |
/// |---|---|---|
/// | remaining <= 3 | あとN日分 | bg-red-100 text-red-700 |
/// | remaining <= 7 | あとN日分 | bg-amber-100 text-amber-700 |
/// | それ以外 | あとN日分 | bg-blue-50 text-blue-700 |
///
/// **`estimateRemainingDays` の 0 は「今日切れ」の有効値** — 非表示判定は
/// `remaining == null` のみで行う。`remaining == 0` を「無し」扱いする
/// falsy 風判定を書くと残 0 日の在庫がバッジから漏れる
/// (`estimateRemainingDays` doc / Phase 2.5 計画 risks。テストで機械防御)。
StockExpiryBadge? stockRemainingDaysBadge(num quantity, num? dailyRate) {
  final remaining = estimateRemainingDays(quantity, dailyRate);
  if (remaining == null) return null;

  final label = 'あと$remaining日分';
  if (remaining <= 3) {
    return (label: label, background: _redBg, foreground: _redFg);
  }
  if (remaining <= 7) {
    return (label: label, background: _amberBg, foreground: _amberFg);
  }
  return (label: label, background: _blueBg, foreground: _blueFg);
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

/// カタカナ (U+30A1 ァ–U+30F6 ヶ) をひらがな (U+3041 ぁ–U+3096 ゖ) へ写像した
/// **照合キー**を返す (web `localeCompare(_, "ja")` 近似のため)。表示には使わない。
///
/// **写像範囲を U+30A1–U+30F6 に限定すること**: カタカナブロック全体を一律
/// -0x60 すると長音符 U+30FC (ー) が U+309C (゜) へ化け、「バター」「ヨーグルト」
/// 「ソーセージ」等の照合が悪化する。U+30F7 以降 (ヷ ヸ ヹ ヺ ・ ー ヽ ヾ) は
/// 畳まず素通しする。
///
/// ゜化け回帰をテストから直接検証するため [visibleForTesting]
/// (同一ファイル内の [_compareStockName] とテストからのみ参照)。
@visibleForTesting
String hiraganaSortKey(String s) => String.fromCharCodes([
  for (final c in s.codeUnits) (c >= 0x30A1 && c <= 0x30F6) ? c - 0x60 : c,
]);

/// stock グループ内の name 照合 (web `localeCompare(a, b, "ja")` 近似)。
///
/// カタカナをひらがなへ畳んだ [hiraganaSortKey] 同士をコードユニット比較する
/// ため、ひらがな/カタカナ混在でも概ね五十音順に並ぶ (素の `String.compareTo`
/// は UTF-16 コードユニット順 = 全ひらがな < 全カタカナ で web と乖離した)。
///
/// 畳み込みは あ/ア を同値化するため、キーが等しいときは元文字列の
/// [String.compareTo] にフォールバックして決定化する — `List.sort` は非安定で
/// タイが非決定になるため必須。tertiary の「ひらがな < カタカナ」も近似する。
int _compareStockName(String a, String b) {
  final byKey = hiraganaSortKey(a).compareTo(hiraganaSortKey(b));
  if (byKey != 0) return byKey;
  return a.compareTo(b);
}

/// カテゴリ別グルーピング。web `stock-list.tsx` の `grouped` (useMemo) と
/// 同一セマンティクス:
/// - グループ順は `categoryDisplayOrder` (= [ItemCategory.displayOrder])
/// - 空グループは出さない
/// - グループ内は name 昇順
///
/// name 昇順は web の `localeCompare(a, b, "ja")` (ICU 照合) を Dart 標準のみで
/// 近似する ([_compareStockName]): カタカナをひらがなへ畳んでからコードユニット
/// 比較し、ひらがな/カタカナ混在でも五十音順に並べる。長音符等の一部記号や
/// 漢字読みは ICU 照合と厳密一致しないが、fetch 自体は DB 照合順のため
/// 実害は限定的。
List<(ItemCategory, List<StockItem>)> groupStockItems(List<StockItem> items) {
  final groups = <ItemCategory, List<StockItem>>{};
  for (final item in items) {
    (groups[item.category] ??= []).add(item);
  }
  return [
    for (final category in ItemCategory.displayOrder)
      if (groups[category] != null && groups[category]!.isNotEmpty)
        (
          category,
          groups[category]!..sort((a, b) => _compareStockName(a.name, b.name)),
        ),
  ];
}
