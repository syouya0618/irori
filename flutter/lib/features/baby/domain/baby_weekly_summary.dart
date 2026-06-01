import 'dart:math' as math;

import 'package:intl/intl.dart';

import 'baby_log.dart';

/// 週間サマリーの 1 日分の集計。原典 `BabyWeeklySummaryDay`。
///
/// record 型で構造的等価性を得る (テストの `expect` が値比較で済む)。
typedef BabyWeeklySummaryDay = ({
  String date,
  int feedingCount,
  int diaperCount,
  int sleepMinutes,
});

/// 週間合計。原典 `totalBabyWeeklySummary` の戻り値形。
typedef BabyWeeklyTotals = ({
  int feedingCount,
  int diaperCount,
  int sleepMinutes,
});

/// 週間サマリー棒グラフ y 軸スケールの最低基準値 (baseline)。原典
/// `WEEKLY_CHART_BASELINE` (`src/lib/domain/baby-weekly-summary.ts`) と同値。
///
/// 疎データ (例: 6日ゼロ・1日だけ授乳1回) をローカル最大値で正規化すると
/// 「1回」が画面いっぱいに伸び誤認を招くため、最低スケールを設ける。
/// データがこの値を上回ればグラフは伸びる (BarChart 側で
/// `max(baseline, ...values, 1)` を計算)。
const BabyWeeklyTotals babyWeeklyChartBaseline = (
  feedingCount: 8, // 授乳: 一日の目安上限 (回)
  diaperCount: 10, // おむつ: 一日の目安上限 (回)
  sleepMinutes: 840, // 睡眠: 14時間 = 840分
);

/// [logs] を [endDate] (JST, YYYY-MM-DD) を含む直近 [days] 日分の日別集計にする。
///
/// 原典 `buildBabyWeeklySummary` (`src/lib/domain/baby-weekly-summary.ts`) の
/// 忠実移植。集計対象:
/// - feeding / diaper: `logged_at` の JST 日付で回数を加算。
/// - sleep (完了済みのみ, `endedAt != null`): JST 日界で各日との overlap を分単位
///   (四捨五入) で加算。日跨ぎ睡眠は各日へ分割される。集計開始前に始まった睡眠も
///   範囲内の overlap だけ数える。
///
/// 純粋関数。JST 日界・日跨ぎ分割の正しさはユニットテスト
/// (`baby_weekly_summary_test.dart`, 原典 `baby-weekly-summary.test.ts` の全
/// ケース + TZ ケースを移植) で機械検証する (CLAUDE.md「検証可能性を担保」)。
List<BabyWeeklySummaryDay> buildBabyWeeklySummary(
  List<BabyLog> logs,
  String endDate, {
  int days = 7,
}) {
  if (days <= 0) return const [];

  final startDate = _shiftYmd(endDate, -(days - 1));
  final dates = <String>[
    for (var i = 0; i < days; i++) _shiftYmd(startDate, i),
  ];
  final dateSet = dates.toSet();

  // 各日の JST 00:00 epoch ms を事前計算 (overlap 計算で再利用)。
  final dayStartMs = {for (final d in dates) d: _jstDayStartMs(d)};

  final feeding = {for (final d in dates) d: 0};
  final diaper = {for (final d in dates) d: 0};
  final sleep = {for (final d in dates) d: 0};

  for (final log in logs) {
    if (log.logType == BabyLogType.sleep && log.endedAt != null) {
      final sleepStartMs = log.loggedAt.millisecondsSinceEpoch;
      final sleepEndMs = log.endedAt!.millisecondsSinceEpoch;
      if (sleepEndMs <= sleepStartMs) continue;

      for (final d in dates) {
        final dayStart = dayStartMs[d]!;
        final dayEnd = _jstDayStartMs(_shiftYmd(d, 1));
        final overlapMs =
            math.min(sleepEndMs, dayEnd) - math.max(sleepStartMs, dayStart);
        if (overlapMs > 0) {
          // 原典同様、日ごとに四捨五入してから加算する。
          sleep[d] = sleep[d]! + (overlapMs / 60000).round();
        }
      }
    } else if (log.logType == BabyLogType.feeding) {
      final date = _jstDateStringOf(log.loggedAt);
      if (dateSet.contains(date)) feeding[date] = feeding[date]! + 1;
    } else if (log.logType == BabyLogType.diaper) {
      final date = _jstDateStringOf(log.loggedAt);
      if (dateSet.contains(date)) diaper[date] = diaper[date]! + 1;
    }
  }

  return [
    for (final d in dates)
      (
        date: d,
        feedingCount: feeding[d]!,
        diaperCount: diaper[d]!,
        sleepMinutes: sleep[d]!,
      ),
  ];
}

/// 週間合計。原典 `totalBabyWeeklySummary`。
BabyWeeklyTotals totalBabyWeeklySummary(List<BabyWeeklySummaryDay> days) {
  var feeding = 0;
  var diaper = 0;
  var sleep = 0;
  for (final day in days) {
    feeding += day.feedingCount;
    diaper += day.diaperCount;
    sleep += day.sleepMinutes;
  }
  return (feedingCount: feeding, diaperCount: diaper, sleepMinutes: sleep);
}

// ---------------------------------------------------------------------------
// JST 日付ヘルパー (純粋・TZ 非依存)。
//
// `baby_repository.dart` の `shiftYmd` / `formatJstDate`、`baby_display_utils.dart`
// の `_kJstOffset` と同一の流儀。domain が data 層へ逆依存しないよう、
// 既存コードの「循環依存回避のための duplication」パターン (baby_display_utils)
// に倣ってこのファイル内で完結させる。正しさは移植テストで担保。
// ---------------------------------------------------------------------------

const Duration _kJstOffset = Duration(hours: 9);

/// "YYYY-MM-DD" を [days] 日シフトする。`DateTime.utc` の overflow 正規化で
/// 月跨ぎ・年跨ぎ・閏年が JS `Date.UTC` と一致する。原典 `shiftYmd`。
String _shiftYmd(String ymd, int days) {
  final parts = ymd.split('-');
  if (parts.length != 3 ||
      parts[0].length != 4 ||
      parts[1].length != 2 ||
      parts[2].length != 2) {
    throw ArgumentError.value(ymd, 'ymd', 'YYYY-MM-DD 形式ではない');
  }
  final shifted = DateTime.utc(
    int.parse(parts[0]),
    int.parse(parts[1]),
    int.parse(parts[2]) + days,
  );
  return DateFormat('yyyy-MM-dd').format(shifted);
}

/// JST "YYYY-MM-DD" 00:00 の epoch ms。`+09:00` 付き ISO を絶対 instant にする。
int _jstDayStartMs(String date) =>
    DateTime.parse('${date}T00:00:00+09:00').millisecondsSinceEpoch;

/// 絶対 instant の JST 日付 (YYYY-MM-DD)。端末 TZ に依存せず UTC 正規化 + 固定
/// +9h で壁時計の日付を取り出す。原典 `toJstDateString`。
String _jstDateStringOf(DateTime instant) {
  final jst = instant.toUtc().add(_kJstOffset);
  return DateFormat('yyyy-MM-dd').format(jst);
}
