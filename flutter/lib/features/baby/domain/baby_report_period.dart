/// 育児記録レポートの期間計算 (純関数)。
///
/// Next.js 原典 `src/app/api/baby-report/route.ts:13-25` の移植 (Phase 2.6-1)。
/// 原典は HTTP query `?period=` の文字列 union (`VALID_PERIODS`) を 400 検証
/// する (`route.ts:36-39`) が、Dart 側は enum で不正値を型レベルで排除する。
library;

import '../../../core/utils/jst_date.dart';

/// レポート期間。原典 `VALID_PERIODS` (`route.ts:13-14`)。
enum BabyReportPeriod {
  oneWeek('1week'),
  oneMonth('1month'),
  threeMonths('3months');

  const BabyReportPeriod(this.wireName);

  /// 原典 API の `?period=` クエリ値 (web との対応トレーサビリティ用)。
  final String wireName;
}

/// 期間の開始日 (JST "YYYY-MM-DD")。原典 `getStartDate` (`route.ts:16-25`)。
///
/// quirk 保存: 1month は暦月でなく **固定 30 日**、3months は固定 90 日。
/// 原典 switch の `default` は 1week (-7 日) — Dart は enum 網羅 switch のため
/// 明示 case にする (挙動同一)。
String babyReportStartDate(BabyReportPeriod period, String today) {
  switch (period) {
    case BabyReportPeriod.oneMonth:
      return shiftYmd(today, -30);
    case BabyReportPeriod.threeMonths:
      return shiftYmd(today, -90);
    case BabyReportPeriod.oneWeek:
      return shiftYmd(today, -7);
  }
}

/// レポート対象期間。原典 `route.ts:41-43` — `endDate = today` (当日を含む)。
///
/// [today] は `formatJstDate()` (原典 `todayJstString()`) で得た JST 日付。
({String startDate, String endDate}) babyReportDateRange(
  BabyReportPeriod period,
  String today,
) {
  return (startDate: babyReportStartDate(period, today), endDate: today);
}
