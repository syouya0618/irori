import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/domain/baby_report_period.dart';

/// `baby_report_period.dart` (原典 `src/app/api/baby-report/route.ts:13-25`,
/// `:41-43`) のテスト。期間は暦月でなく固定日数 (7/30/90) の quirk を固定する。
void main() {
  group('babyReportStartDate (原典 getStartDate / route.ts:16-25)', () {
    test('1week → today - 7 日', () {
      expect(
        babyReportStartDate(BabyReportPeriod.oneWeek, '2026-04-11'),
        '2026-04-04',
      );
    });

    test('1month → today - 30 日 (固定 30 日 — 暦月ではない)', () {
      expect(
        babyReportStartDate(BabyReportPeriod.oneMonth, '2026-04-11'),
        '2026-03-12',
      );
    });

    test('3months → today - 90 日 (固定 90 日)', () {
      expect(
        babyReportStartDate(BabyReportPeriod.threeMonths, '2026-04-11'),
        '2026-01-11',
      );
    });

    test('月跨ぎ・年跨ぎ: 2026-03-01 起点 (非閏年 2 月を跨ぐ)', () {
      expect(
        babyReportStartDate(BabyReportPeriod.oneWeek, '2026-03-01'),
        '2026-02-22',
      );
      expect(
        babyReportStartDate(BabyReportPeriod.oneMonth, '2026-03-01'),
        '2026-01-30',
      );
      expect(
        babyReportStartDate(BabyReportPeriod.threeMonths, '2026-03-01'),
        '2025-12-01',
      );
    });
  });

  group('babyReportDateRange (route.ts:41-43)', () {
    test('endDate は today 当日 (当日を含む期間)', () {
      expect(
        babyReportDateRange(BabyReportPeriod.oneWeek, '2026-04-11'),
        (startDate: '2026-04-04', endDate: '2026-04-11'),
      );
    });
  });

  group('BabyReportPeriod.wireName (原典 VALID_PERIODS / route.ts:13-14)', () {
    test('原典 period 文字列と 1:1 対応する', () {
      expect(BabyReportPeriod.values.map((p) => p.wireName).toList(), [
        '1week',
        '1month',
        '3months',
      ]);
    });
  });
}
