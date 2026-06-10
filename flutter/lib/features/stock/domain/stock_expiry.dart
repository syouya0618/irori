/// 在庫アイテムの賞味期限分類 (純関数)。
///
/// Next.js 原典の 2 箇所のロジックを F0 の `daysBetweenYmd` ベースで統合移植:
/// - `stock-item.tsx` `getExpiryStatus`: 期限バッジの 5 段階分類
///   (`daysFromTodayJst` = `daysBetweenYmd(today, target)` の閾値判定)
/// - `stock-list.tsx` `countExpiringItems`: 「期限切れ間近」アラートの
///   `diffDays <= 3` 判定 (期限切れ含む) → [StockExpiryStatus.isExpiringAlert]
///
/// テスト容易性のため「今日」は引数 [todayYmd] で受け、内部で
/// `DateTime.now()` を呼ばない (`jst_date.dart` の設計方針と同一)。
/// 呼び出し側 (F6 UI) は `formatJstDate()` で今日の JST 日付を渡す。
library;

import '../../../core/utils/jst_date.dart';

/// 期限バッジの分類。web `getExpiryStatus` の分岐 1:1 + バッジなし ([none])。
///
/// | 値 | web の分岐 | web のバッジ |
/// |---|---|---|
/// | [expired] | `diffDays < 0` | 「期限切れ」(赤) |
/// | [expiresToday] | `diffDays === 0` | 「今日まで」(赤) |
/// | [within3Days] | `diffDays <= 3` | 「あとN日」(アンバー) |
/// | [within7Days] | `diffDays <= 7` | 月/日 (黄) |
/// | [normal] | それ以外 | 月/日 (muted) |
/// | [none] | `expiresAt` null / パース失敗 | バッジなし |
enum StockExpiryStatus {
  /// 期限切れ (`diffDays < 0`)。
  expired,

  /// 今日まで (`diffDays == 0`)。
  expiresToday,

  /// 3 日以内 (`1 <= diffDays <= 3`)。
  within3Days,

  /// 1 週間以内 (`4 <= diffDays <= 7`)。
  within7Days,

  /// 8 日以上先。
  normal,

  /// 期限なし (null/空) またはパース不能 — バッジを表示しない。
  none;

  /// 「期限切れ間近」アラートの対象か。
  ///
  /// web `stock-list.tsx` `countExpiringItems` の
  /// `diffDays !== null && diffDays <= 3` (期限切れの負値を含む) と等価:
  /// [expired] / [expiresToday] / [within3Days] が対象。
  /// F6 のアラートバナー件数は
  /// `items.where((i) => classifyExpiry(today, i.expiresAt).isExpiringAlert)`
  /// で web と一致する。
  bool get isExpiringAlert =>
      this == expired || this == expiresToday || this == within3Days;
}

/// [expiresAtYmd] (YYYY-MM-DD) を [todayYmd] (YYYY-MM-DD) 基準で分類する。
///
/// web `getExpiryStatus` と同じ tolerant 方針: `daysFromTodayJst` が
/// パース失敗で null を返す経路 (= 原典の「バッジなし」) を、
/// `daysBetweenYmd` の `ArgumentError` / `FormatException` を捕捉して
/// [StockExpiryStatus.none] に対応させる。null / 空文字も [none]。
///
/// [todayYmd] は実運用では `formatJstDate()` 由来の正規形だが、
/// 不正でも throw せず [none] に倒す (原典 `daysBetweenYmd` は from/to の
/// どちらが不正でも null を返す)。
StockExpiryStatus classifyExpiry(String todayYmd, String? expiresAtYmd) {
  if (expiresAtYmd == null || expiresAtYmd.isEmpty) {
    return StockExpiryStatus.none;
  }

  final int diffDays;
  try {
    diffDays = daysBetweenYmd(todayYmd, expiresAtYmd);
  } on ArgumentError {
    // "YYYY-MM-DD" の桁構成でない (jst_date の形式検証)。
    return StockExpiryStatus.none;
  } on FormatException {
    // 桁構成は合うが数値でない ("abcd-ef-gh" 等の int.parse 失敗)。
    return StockExpiryStatus.none;
  }

  if (diffDays < 0) return StockExpiryStatus.expired;
  if (diffDays == 0) return StockExpiryStatus.expiresToday;
  if (diffDays <= 3) return StockExpiryStatus.within3Days;
  if (diffDays <= 7) return StockExpiryStatus.within7Days;
  return StockExpiryStatus.normal;
}
