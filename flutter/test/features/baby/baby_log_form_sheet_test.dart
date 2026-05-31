import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/presentation/widgets/baby_log_form_sheet.dart';

class _Repo extends Fake implements BabyRepository {
  double? recordedTemperature;
  String? updatedLogId;
  FeedingType? updatedFeedingType;
  int? updatedAmountMl;
  String? deletedLogId;

  @override
  Future<void> recordTemperature({
    required String householdId,
    required String userId,
    required double temperature,
    String? memo,
  }) async {
    recordedTemperature = temperature;
  }

  @override
  Future<void> updateFeeding({
    required String householdId,
    required String logId,
    required FeedingType feedingType,
    int? amountMl,
    String? memo,
  }) async {
    updatedLogId = logId;
    updatedFeedingType = feedingType;
    updatedAmountMl = amountMl;
  }

  @override
  Future<void> deleteLog({
    required String householdId,
    required String logId,
  }) async {
    deletedLogId = logId;
  }
}

BabyLog _feedingLog() {
  return BabyLog(
    id: 'feeding-1',
    householdId: 'hh-1',
    logType: BabyLogType.feeding,
    loggedAt: DateTime.utc(2026, 1, 1, 3, 0),
    loggedBy: 'user-1',
    feedingType: FeedingType.bottle,
    amountMl: 100,
    createdAt: DateTime.utc(2026, 1, 1, 3, 0),
  );
}

Widget _wrap({
  required _Repo repo,
  BabyLog? log,
  BabyLogType? createLogType,
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
        body: Builder(
          builder: (context) => FilledButton(
            onPressed: () {
              showBabyLogFormSheet(
                context,
                log: log,
                createLogType: createLogType,
              );
            },
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
}

void main() {
  group('BabyLogFormSheet', () {
    testWidgets('temperature create validates range and records value', (
      tester,
    ) async {
      final repo = _Repo();
      await tester.pumpWidget(
        _wrap(repo: repo, createLogType: BabyLogType.temperature),
      );

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('記録する'));
      await tester.pumpAndSettle();
      expect(find.text('体温を入力してください'), findsOneWidget);

      await tester.enterText(
        find.widgetWithText(TextFormField, '体温 (℃)'),
        '36.5',
      );
      await tester.tap(find.text('記録する'));
      await tester.pumpAndSettle();

      expect(repo.recordedTemperature, 36.5);
      expect(find.text('記録しました'), findsOneWidget);
    });

    testWidgets(
      'feeding edit updates selected type and clears amount for breast',
      (
        tester,
      ) async {
        final repo = _Repo();
        await tester.pumpWidget(_wrap(repo: repo, log: _feedingLog()));

        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('左'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('更新する'));
        await tester.pumpAndSettle();

        expect(repo.updatedLogId, 'feeding-1');
        expect(repo.updatedFeedingType, FeedingType.breastLeft);
        expect(repo.updatedAmountMl, isNull);
        expect(find.text('ログを更新しました'), findsOneWidget);
      },
    );

    testWidgets('delete requires confirmation before deleting', (tester) async {
      final repo = _Repo();
      await tester.pumpWidget(_wrap(repo: repo, log: _feedingLog()));

      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('この記録を削除'));
      await tester.pumpAndSettle();

      expect(repo.deletedLogId, isNull);
      await tester.tap(find.text('削除する'));
      await tester.pumpAndSettle();

      expect(repo.deletedLogId, 'feeding-1');
      expect(find.text('ログを削除しました'), findsOneWidget);
    });
  });
}
