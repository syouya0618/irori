import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/domain/baby_weekly_summary.dart';

/// 原典 `src/lib/domain/__tests__/baby-weekly-summary.test.ts` の `log()` 相当。
///
/// domain ロジックが読むのは `logType` / `loggedAt` / `endedAt` のみ。required の
/// id / householdId / loggedBy / createdAt にはダミー値を入れる。
BabyLog _log(
  BabyLogType type,
  String loggedAt, [
  String? endedAt,
]) {
  return BabyLog(
    id: 'x',
    householdId: 'hh',
    logType: type,
    loggedAt: DateTime.parse(loggedAt),
    loggedBy: 'u',
    endedAt: endedAt == null ? null : DateTime.parse(endedAt),
    createdAt: DateTime.parse(loggedAt),
  );
}

void main() {
  group('buildBabyWeeklySummary', () {
    test('終了日を含む7日分をゼロ埋めで返す', () {
      final result = buildBabyWeeklySummary(const [], '2026-04-11');

      expect(result, const [
        (date: '2026-04-05', feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
        (date: '2026-04-06', feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
        (date: '2026-04-07', feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
        (date: '2026-04-08', feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
        (date: '2026-04-09', feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
        (date: '2026-04-10', feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
        (date: '2026-04-11', feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
      ]);
    });

    test('授乳・おむつ・完了済み睡眠を日別に集計する', () {
      final logs = [
        _log(BabyLogType.feeding, '2026-04-10T08:00:00+09:00'),
        _log(BabyLogType.feeding, '2026-04-10T11:00:00+09:00'),
        _log(BabyLogType.diaper, '2026-04-10T12:00:00+09:00'),
        _log(
          BabyLogType.sleep,
          '2026-04-10T13:00:00+09:00',
          '2026-04-10T14:30:00+09:00',
        ),
        _log(
          BabyLogType.sleep,
          '2026-04-10T16:00:00+09:00',
          '2026-04-10T16:45:00+09:00',
        ),
        _log(BabyLogType.diaper, '2026-04-11T07:00:00+09:00'),
      ];

      final result = buildBabyWeeklySummary(logs, '2026-04-11');

      expect(
        result[5],
        const (
          date: '2026-04-10',
          feedingCount: 2,
          diaperCount: 1,
          sleepMinutes: 135,
        ),
      );
      expect(
        result[6],
        const (
          date: '2026-04-11',
          feedingCount: 0,
          diaperCount: 1,
          sleepMinutes: 0,
        ),
      );
    });

    test('範囲外と未完了睡眠を除外する', () {
      final logs = [
        _log(BabyLogType.feeding, '2026-04-04T23:59:00+09:00'),
        _log(BabyLogType.sleep, '2026-04-11T09:00:00+09:00'),
      ];

      final result = buildBabyWeeklySummary(logs, '2026-04-11');

      expect(
        totalBabyWeeklySummary(result),
        const (feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
      );
    });

    test('完全に範囲外の睡眠を除外する', () {
      final result = buildBabyWeeklySummary(
        [
          _log(
            BabyLogType.sleep,
            '2026-04-03T22:00:00+09:00',
            '2026-04-04T06:00:00+09:00',
          ),
          _log(
            BabyLogType.sleep,
            '2026-04-12T00:00:00+09:00',
            '2026-04-12T02:00:00+09:00',
          ),
        ],
        '2026-04-11',
      );

      expect(
        totalBabyWeeklySummary(result),
        const (feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
      );
    });

    test('終了時刻が開始時刻以前の睡眠を除外する', () {
      final result = buildBabyWeeklySummary(
        [
          _log(
            BabyLogType.sleep,
            '2026-04-10T10:00:00+09:00',
            '2026-04-10T09:59:00+09:00',
          ),
        ],
        '2026-04-11',
      );

      expect(
        totalBabyWeeklySummary(result),
        const (feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
      );
    });

    test('週間日数が0以下なら空配列を返す', () {
      expect(buildBabyWeeklySummary(const [], '2026-04-11', days: 0), isEmpty);
      expect(buildBabyWeeklySummary(const [], '2026-04-11', days: -1), isEmpty);
    });

    test('週間サマリー対象外のログ種別を無視する', () {
      final result = buildBabyWeeklySummary(
        [
          _log(BabyLogType.temperature, '2026-04-10T08:00:00+09:00'),
          _log(BabyLogType.growth, '2026-04-10T09:00:00+09:00'),
          _log(BabyLogType.memo, '2026-04-10T10:00:00+09:00'),
        ],
        '2026-04-11',
      );

      expect(
        totalBabyWeeklySummary(result),
        const (feedingCount: 0, diaperCount: 0, sleepMinutes: 0),
      );
    });

    test('日跨ぎ睡眠をJSTの日別に分割する', () {
      final result = buildBabyWeeklySummary(
        [
          _log(
            BabyLogType.sleep,
            '2026-04-10T22:00:00+09:00',
            '2026-04-11T06:30:00+09:00',
          ),
        ],
        '2026-04-11',
      );

      expect(
        result[5],
        const (
          date: '2026-04-10',
          feedingCount: 0,
          diaperCount: 0,
          sleepMinutes: 120,
        ),
      );
      expect(
        result[6],
        const (
          date: '2026-04-11',
          feedingCount: 0,
          diaperCount: 0,
          sleepMinutes: 390,
        ),
      );
    });

    test('集計開始前に始まった睡眠も範囲内の重なりだけ数える', () {
      final result = buildBabyWeeklySummary(
        [
          _log(
            BabyLogType.sleep,
            '2026-04-04T22:00:00+09:00',
            '2026-04-05T01:30:00+09:00',
          ),
        ],
        '2026-04-11',
      );

      expect(
        result[0],
        const (
          date: '2026-04-05',
          feedingCount: 0,
          diaperCount: 0,
          sleepMinutes: 90,
        ),
      );
      expect(
        totalBabyWeeklySummary(result),
        const (feedingCount: 0, diaperCount: 0, sleepMinutes: 90),
      );
    });

    test('終了日(JST)を端末TZに依存せず正しく解釈する', () {
      // logged_at が UTC 表現 (末尾 Z) でも JST 日界で正しく集計されること。
      // 2026-04-09T23:00:00Z = 2026-04-10T08:00:00+09:00 (JST 4/10)。
      final result = buildBabyWeeklySummary(
        [_log(BabyLogType.feeding, '2026-04-09T23:00:00Z')],
        '2026-04-11',
      );

      expect(result[5].date, '2026-04-10');
      expect(result[5].feedingCount, 1);
    });
  });

  group('totalBabyWeeklySummary', () {
    test('週間合計を返す', () {
      final days = buildBabyWeeklySummary(
        [
          _log(BabyLogType.feeding, '2026-04-10T08:00:00+09:00'),
          _log(BabyLogType.diaper, '2026-04-10T09:00:00+09:00'),
          _log(
            BabyLogType.sleep,
            '2026-04-10T10:00:00+09:00',
            '2026-04-10T11:00:00+09:00',
          ),
        ],
        '2026-04-11',
      );

      expect(
        totalBabyWeeklySummary(days),
        const (feedingCount: 1, diaperCount: 1, sleepMinutes: 60),
      );
    });
  });

  group('babyWeeklyChartBaseline', () {
    test('原典 WEEKLY_CHART_BASELINE と一致する', () {
      expect(babyWeeklyChartBaseline.feedingCount, 8);
      expect(babyWeeklyChartBaseline.diaperCount, 10);
      expect(babyWeeklyChartBaseline.sleepMinutes, 840);
    });
  });
}
