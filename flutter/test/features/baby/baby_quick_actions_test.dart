import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/presentation/widgets/baby_quick_actions.dart';

class _Repo extends Fake implements BabyRepository {
  FeedingType? feedingType;
  DiaperType? diaperType;
  int startSleepCalls = 0;
  String? endedSleepId;

  @override
  Future<void> recordFeeding({
    required String householdId,
    required String userId,
    required FeedingType feedingType,
    int? amountMl,
    int? durationMin,
    String? memo,
  }) async {
    this.feedingType = feedingType;
  }

  @override
  Future<void> recordDiaper({
    required String householdId,
    required String userId,
    required DiaperType diaperType,
    String? memo,
  }) async {
    this.diaperType = diaperType;
  }

  @override
  Future<void> startSleep({
    required String householdId,
    required String userId,
  }) async {
    startSleepCalls++;
  }

  @override
  Future<void> endSleep({
    required String householdId,
    required String logId,
    DateTime? endedAt,
  }) async {
    endedSleepId = logId;
  }
}

BabyLog _sleepLog() {
  return BabyLog(
    id: 'sleep-1',
    householdId: 'hh-1',
    logType: BabyLogType.sleep,
    loggedAt: DateTime.utc(2026, 1, 1, 12, 0),
    loggedBy: 'user-1',
    createdAt: DateTime.utc(2026, 1, 1, 12, 0),
  );
}

Widget _wrap({
  required _Repo repo,
  BabyLog? activeSleep,
  DateTime? now,
  void Function(BabyLogType type)? onCreateLog,
}) {
  return ProviderScope(
    overrides: [
      babyRepositoryProvider.overrideWithValue(repo),
      babyMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: BabyQuickActions(
          activeSleep: activeSleep,
          now: now ?? DateTime.utc(2026, 1, 1, 12, 30),
          onCreateLog: onCreateLog ?? (_) {},
        ),
      ),
    ),
  );
}

void main() {
  group('BabyQuickActions', () {
    testWidgets('feeding button records feeding immediately without timer', (
      tester,
    ) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('ミルク'));
      await tester.pumpAndSettle();

      expect(repo.feedingType, FeedingType.bottle);
      expect(find.text('授乳を記録しました'), findsOneWidget);
    });

    testWidgets('diaper button records diaper', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('うんち'));
      await tester.pumpAndSettle();

      expect(repo.diaperType, DiaperType.poop);
      expect(find.text('おむつ交換を記録しました'), findsOneWidget);
    });

    testWidgets('sleep button starts sleep when no active sleep exists', (
      tester,
    ) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo));

      await tester.tap(find.text('ねんね'));
      await tester.pumpAndSettle();

      expect(repo.startSleepCalls, 1);
      expect(find.text('おやすみなさい'), findsOneWidget);
    });

    testWidgets('sleep button ends active sleep', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(
        _wrap(repo: repo, activeSleep: _sleepLog()),
      );

      expect(find.text('30分'), findsOneWidget);
      await tester.tap(find.text('30分'));
      await tester.pumpAndSettle();

      expect(repo.endedSleepId, 'sleep-1');
      expect(find.textContaining('おはよう'), findsOneWidget);
    });

    testWidgets('temperature/growth/memo buttons delegate to form opener', (
      tester,
    ) async {
      final repo = _Repo();
      final opened = <BabyLogType>[];
      await tester.pumpWidget(
        _wrap(repo: repo, onCreateLog: opened.add),
      );

      await tester.tap(find.text('体温'));
      await tester.tap(find.text('成長'));
      await tester.tap(find.text('メモ'));
      await tester.pump();

      expect(opened, [
        BabyLogType.temperature,
        BabyLogType.growth,
        BabyLogType.memo,
      ]);
    });
  });
}
