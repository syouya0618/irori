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

/// web `parseYmd` (`src/lib/utils/date-jst.ts`) と同一の厳密形式検証
/// (Issue #38)。
///
/// `jst_date.dart` の `daysBetweenYmd` は桁数チェック + `int.parse` のため、
/// `int.parse` が許容する前後空白 (`'9 '`)・符号 prefix (`'+123'`)・
/// 16進 prefix (`'0x10'`) をすり抜けて数値を返してしまう。web は regex
/// 不一致で null (= バッジなし) のため、`daysBetweenYmd` へ渡す前に同じ
/// regex で弾く (`jst_date.dart` 本体は正規形保証済みの呼び出し元があるため
/// 変えない)。
final _ymdPattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');

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
/// パース失敗で null を返す経路 (= 原典の「バッジなし」) を、web `parseYmd`
/// と同一の `_ymdPattern` 事前検証 (Issue #38) + `daysBetweenYmd` の
/// `ArgumentError` / `FormatException` 捕捉で [StockExpiryStatus.none] に
/// 対応させる。null / 空文字も [none]。
///
/// [todayYmd] は実運用では `formatJstDate()` 由来の正規形だが、
/// 不正でも throw せず [none] に倒す (原典 `daysBetweenYmd` は from/to の
/// どちらが不正でも null を返す)。
StockExpiryStatus classifyExpiry(String todayYmd, String? expiresAtYmd) {
  if (expiresAtYmd == null || expiresAtYmd.isEmpty) {
    return StockExpiryStatus.none;
  }
  // 原典 `parseYmd` の regex 検証 — from/to どちらの不一致も [none] に倒す
  // (Issue #38。原典 `daysBetweenYmd` は from/to どちらの失敗も null)。
  if (!_ymdPattern.hasMatch(todayYmd) || !_ymdPattern.hasMatch(expiresAtYmd)) {
    return StockExpiryStatus.none;
  }

  final int diffDays;
  try {
    diffDays = daysBetweenYmd(todayYmd, expiresAtYmd);
  } on ArgumentError {
    // "YYYY-MM-DD" の桁構成でない (jst_date の形式検証)。
    // regex 事前検証後は理論上到達しないが、防御として残す。
    return StockExpiryStatus.none;
  } on FormatException {
    // 桁構成は合うが数値でない ("abcd-ef-gh" 等の int.parse 失敗)。
    // 同上 — regex 事前検証後は到達しないが、防御として残す。
    return StockExpiryStatus.none;
  }

  if (diffDays < 0) return StockExpiryStatus.expired;
  if (diffDays == 0) return StockExpiryStatus.expiresToday;
  if (diffDays <= 3) return StockExpiryStatus.within3Days;
  if (diffDays <= 7) return StockExpiryStatus.within7Days;
  return StockExpiryStatus.normal;
}
