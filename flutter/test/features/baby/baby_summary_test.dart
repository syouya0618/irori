import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/presentation/baby_summary.dart';

BabyLog _log({
  required String id,
  required BabyLogType logType,
  DateTime? loggedAt,
  DateTime? endedAt,
}) {
  return BabyLog(
    id: id,
    householdId: 'hh-1',
    logType: logType,
    loggedAt: loggedAt ?? DateTime.utc(2026, 1, 1, 12),
    loggedBy: 'user-1',
    endedAt: endedAt,
    createdAt: DateTime.utc(2026, 1, 1, 12),
  );
}

void main() {
  group('deriveBabySummary (原典 baby-dashboard.tsx L182-206)', () {
    test('空リストは全て初期値', () {
      final s = deriveBabySummary(const []);
      expect(s.activeSleep, isNull);
      expect(s.lastFeeding, isNull);
      expect(s.diaperCount, 0);
      expect(s.derivedLastSleepEndedAt, isNull);
    });

    test('active sleep は最初の (最新の) ended_at==null の sleep', () {
      // logs は降順前提。先頭の active sleep が拾われる。
      final logs = [
        _log(
          id: 's-new',
          logType: BabyLogType.sleep,
          loggedAt: DateTime.utc(2026, 1, 1, 14),
        ),
        _log(
          id: 's-old',
          logType: BabyLogType.sleep,
          loggedAt: DateTime.utc(2026, 1, 1, 10),
        ),
      ];
      final s = deriveBabySummary(logs);
      expect(s.activeSleep?.id, 's-new');
    });

    test('完了済み sleep のみのとき activeSleep は null、derivedLastSleepEndedAt が入る', () {
      final ended = DateTime.utc(2026, 1, 1, 13);
      final logs = [
        _log(
          id: 's1',
          logType: BabyLogType.sleep,
          loggedAt: DateTime.utc(2026, 1, 1, 12),
          endedAt: ended,
        ),
      ];
      final s = deriveBabySummary(logs);
      expect(s.activeSleep, isNull);
      expect(s.derivedLastSleepEndedAt, ended);
    });

    test('derivedLastSleepEndedAt は最初の (最新の) 完了済み sleep の終了時刻', () {
      final newEnd = DateTime.utc(2026, 1, 1, 15);
      final oldEnd = DateTime.utc(2026, 1, 1, 9);
      final logs = [
        _log(
          id: 's-new',
          logType: BabyLogType.sleep,
          loggedAt: DateTime.utc(2026, 1, 1, 14),
          endedAt: newEnd,
        ),
        _log(
          id: 's-old',
          logType: BabyLogType.sleep,
          loggedAt: DateTime.utc(2026, 1, 1, 8),
          endedAt: oldEnd,
        ),
      ];
      final s = deriveBabySummary(logs);
      expect(s.derivedLastSleepEndedAt, newEnd);
    });

    test('active sleep と完了済み sleep が併存しても両方拾う', () {
      final ended = DateTime.utc(2026, 1, 1, 11);
      final logs = [
        _log(
          id: 's-active',
          logType: BabyLogType.sleep,
          loggedAt: DateTime.utc(2026, 1, 1, 14),
        ),
        _log(
          id: 's-done',
          logType: BabyLogType.sleep,
          loggedAt: DateTime.utc(2026, 1, 1, 10),
          endedAt: ended,
        ),
      ];
      final s = deriveBabySummary(logs);
      expect(s.activeSleep?.id, 's-active');
      expect(s.derivedLastSleepEndedAt, ended);
    });

    test('lastFeeding は最初の (最新の) feeding', () {
      final logs = [
        _log(
          id: 'f-new',
          logType: BabyLogType.feeding,
          loggedAt: DateTime.utc(2026, 1, 1, 14),
        ),
        _log(
          id: 'f-old',
          logType: BabyLogType.feeding,
          loggedAt: DateTime.utc(2026, 1, 1, 8),
        ),
      ];
      final s = deriveBabySummary(logs);
      expect(s.lastFeeding?.id, 'f-new');
    });

    test('diaperCount は diaper ログの総数', () {
      final logs = [
        _log(id: 'd1', logType: BabyLogType.diaper),
        _log(id: 'd2', logType: BabyLogType.diaper),
        _log(id: 'f1', logType: BabyLogType.feeding),
        _log(id: 'd3', logType: BabyLogType.diaper),
      ];
      final s = deriveBabySummary(logs);
      expect(s.diaperCount, 3);
    });

    test('混在ケースを 1 パスで正しく導出', () {
      final ended = DateTime.utc(2026, 1, 1, 11);
      final logs = [
        _log(
          id: 'f-new',
          logType: BabyLogType.feeding,
          loggedAt: DateTime.utc(2026, 1, 1, 15),
        ),
        _log(id: 'd1', logType: BabyLogType.diaper),
        _log(
          id: 's-active',
          logType: BabyLogType.sleep,
          loggedAt: DateTime.utc(2026, 1, 1, 13),
        ),
        _log(
          id: 's-done',
          logType: BabyLogType.sleep,
          loggedAt: DateTime.utc(2026, 1, 1, 10),
          endedAt: ended,
        ),
        _log(id: 'd2', logType: BabyLogType.diaper),
        _log(
          id: 'f-old',
          logType: BabyLogType.feeding,
          loggedAt: DateTime.utc(2026, 1, 1, 7),
        ),
      ];
      final s = deriveBabySummary(logs);
      expect(s.lastFeeding?.id, 'f-new');
      expect(s.activeSleep?.id, 's-active');
      expect(s.derivedLastSleepEndedAt, ended);
      expect(s.diaperCount, 2);
    });
  });
}
