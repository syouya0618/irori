import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/domain/baby_log.dart';

import 'support/fake_supabase.dart';

({BabyRepository repo, FakeQueryBuilder query, FakeFilterBuilder mutation})
_repo() {
  final mutation = FakeFilterBuilder(
    cannedValue: const [],
    singleValue: {'id': 'sleep-1'},
  );
  final query = FakeQueryBuilder(
    FakeFilterBuilder(cannedValue: const []),
    mutationFilter: mutation,
  );
  final client = FakeSupabaseClient(fromBuilders: {'baby_logs': query});
  return (repo: BabyRepository(client), query: query, mutation: mutation);
}

void main() {
  group('BabyRepository mutations', () {
    test('recordFeeding inserts household/user/type payload', () async {
      final r = _repo();

      await r.repo.recordFeeding(
        householdId: 'hh-1',
        userId: 'user-1',
        feedingType: FeedingType.bottle,
        amountMl: 120,
        memo: 'よく飲んだ',
      );

      expect(r.query.lastInsertValues, {
        'household_id': 'hh-1',
        'log_type': 'feeding',
        'logged_by': 'user-1',
        'feeding_type': 'bottle',
        'amount_ml': 120,
        'duration_min': null,
        'memo': 'よく飲んだ',
      });
    });

    test('recordFeeding ignores amount_ml for breast feeding', () async {
      final r = _repo();

      await r.repo.recordFeeding(
        householdId: 'hh-1',
        userId: 'user-1',
        feedingType: FeedingType.breastLeft,
        amountMl: 120,
      );

      final row = r.query.lastInsertValues! as Map<dynamic, dynamic>;
      expect(row['feeding_type'], 'breast_left');
      expect(row['amount_ml'], isNull);
    });

    test(
      'updateFeeding filters by id + household and clears amount for breast',
      () async {
        final r = _repo();

        await r.repo.updateFeeding(
          householdId: 'hh-1',
          logId: 'log-1',
          feedingType: FeedingType.breastRight,
          amountMl: 80,
        );

        expect(r.query.lastUpdateValues, {
          'feeding_type': 'breast_right',
          'amount_ml': null,
          'memo': null,
        });
        expect(r.mutation.eqFilters, [
          (column: 'id', value: 'log-1'),
          (column: 'household_id', value: 'hh-1'),
        ]);
      },
    );

    test('endSleep updates only an active sleep row', () async {
      final r = _repo();
      final endedAt = DateTime.utc(2026, 5, 31, 3, 0);

      await r.repo.endSleep(
        householdId: 'hh-1',
        logId: 'sleep-1',
        endedAt: endedAt,
      );

      expect(r.query.lastUpdateValues, {
        'ended_at': endedAt.toIso8601String(),
      });
      expect(r.mutation.eqFilters, [
        (column: 'id', value: 'sleep-1'),
        (column: 'household_id', value: 'hh-1'),
      ]);
      expect(r.mutation.isFilters, [(column: 'ended_at', value: null)]);
      expect(r.mutation.selectedColumns, 'id');
    });

    test('deleteLog filters by id + household', () async {
      final r = _repo();

      await r.repo.deleteLog(householdId: 'hh-1', logId: 'log-1');

      expect(r.query.deleteCallCount, 1);
      expect(r.mutation.eqFilters, [
        (column: 'id', value: 'log-1'),
        (column: 'household_id', value: 'hh-1'),
      ]);
    });

    test('validates user-facing input before writing', () async {
      final r = _repo();

      await expectLater(
        r.repo.recordTemperature(
          householdId: 'hh-1',
          userId: 'user-1',
          temperature: 43,
        ),
        throwsArgumentError,
      );
      await expectLater(
        r.repo.recordMemo(
          householdId: 'hh-1',
          userId: 'user-1',
          memo: '   ',
        ),
        throwsArgumentError,
      );
    });
  });
}
