import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'support/fake_supabase.dart';

/// `BabyRepository.fetchReportLogs` / `fetchBabyReportProfile` (Phase 2.6-1)
/// のクエリ構築テスト。原典 `src/app/api/baby-report/route.ts:46-63` の
/// クエリ仕様 (SELECT 列 / household filter / JST 境界 / order / limit) を
/// fake_supabase の呼び出し記録で固定する。

({
  BabyRepository repo,
  FakeSupabaseClient client,
  FakeQueryBuilder query,
  FakeFilterBuilder filter,
})
_logsRepo({PostgrestList? rows, Object? error}) {
  final filter = FakeFilterBuilder(
    cannedValue: rows ?? const [],
    cannedError: error,
  );
  final query = FakeQueryBuilder(filter);
  final client = FakeSupabaseClient(fromBuilders: {'baby_logs': query});
  return (
    repo: BabyRepository(client),
    client: client,
    query: query,
    filter: filter,
  );
}

({
  BabyRepository repo,
  FakeSupabaseClient client,
  FakeQueryBuilder query,
  FakeFilterBuilder filter,
})
_profileRepo({PostgrestMap? row, Object? singleError}) {
  final filter = FakeFilterBuilder(singleValue: row, singleError: singleError);
  final query = FakeQueryBuilder(filter);
  final client = FakeSupabaseClient(fromBuilders: {'households': query});
  return (
    repo: BabyRepository(client),
    client: client,
    query: query,
    filter: filter,
  );
}

void main() {
  group('fetchReportLogs (route.ts:54-62 のクエリ仕様)', () {
    test('SELECT 9 列 / household filter / JST 境界 / 昇順 / limit 5000', () async {
      final r = _logsRepo();

      await r.repo.fetchReportLogs('hh-1', '2026-04-04', '2026-04-11');

      expect(r.client.lastFromTable, 'baby_logs');
      // 手組み SELECT 文字列の typo 防止 (weeklyOrFilter テストと同じ意図)。
      expect(
        r.query.lastSelectColumns,
        'log_type, logged_at, feeding_type, amount_ml, diaper_type, ended_at, '
        'temperature, weight_g, height_cm',
      );
      expect(r.query.lastSelectColumns, BabyRepository.babyReportColumns);
      expect(r.filter.eqFilters, [(column: 'household_id', value: 'hh-1')]);
      expect(r.filter.gteFilters, [
        (column: 'logged_at', value: '2026-04-04T00:00:00+09:00'),
      ]);
      // 上限は endDate **翌日** 0:00 JST の半開区間 (endDate 当日を含む)。
      expect(r.filter.ltFilters, [
        (column: 'logged_at', value: '2026-04-12T00:00:00+09:00'),
      ]);
      expect(r.filter.orderCalls, [(column: 'logged_at', ascending: true)]);
      expect(r.filter.limitCalls, [5000]);
    });

    test('lt 上限の shiftYmd(endDate, 1) は月跨ぎ・年跨ぎを正規化する', () async {
      final monthEnd = _logsRepo();
      await monthEnd.repo.fetchReportLogs('hh-1', '2026-05-01', '2026-05-31');
      expect(monthEnd.filter.ltFilters, [
        (column: 'logged_at', value: '2026-06-01T00:00:00+09:00'),
      ]);

      final yearEnd = _logsRepo();
      await yearEnd.repo.fetchReportLogs('hh-1', '2026-12-01', '2026-12-31');
      expect(yearEnd.filter.ltFilters, [
        (column: 'logged_at', value: '2027-01-01T00:00:00+09:00'),
      ]);
    });

    test('rows を AggregationLogInput へ復元する (numeric 文字列 quirk 含む)', () async {
      final r = _logsRepo(
        rows: [
          {
            'log_type': 'feeding',
            'logged_at': '2026-04-11T01:00:00+00:00',
            'feeding_type': 'bottle',
            'amount_ml': 120,
            'diaper_type': null,
            'ended_at': null,
            'temperature': null,
            'weight_g': null,
            'height_cm': null,
          },
          {
            'log_type': 'growth',
            'logged_at': '2026-04-11T02:00:00+00:00',
            'feeding_type': null,
            'amount_ml': null,
            'diaper_type': null,
            'ended_at': null,
            'temperature': null,
            'weight_g': 5200,
            'height_cm': '58.5',
          },
        ],
      );

      final logs = await r.repo.fetchReportLogs(
        'hh-1',
        '2026-04-04',
        '2026-04-11',
      );

      expect(logs, hasLength(2));
      expect(logs[0].logType, BabyLogType.feeding);
      expect(logs[0].feedingType, FeedingType.bottle);
      expect(logs[0].amountMl, 120);
      expect(logs[1].logType, BabyLogType.growth);
      expect(logs[1].weightG, 5200);
      expect(logs[1].heightCm, 58.5);
    });

    test('PostgrestException は握り潰さず rethrow する', () async {
      final r = _logsRepo(
        error: const PostgrestException(message: 'boom', code: '500'),
      );

      await expectLater(
        r.repo.fetchReportLogs('hh-1', '2026-04-04', '2026-04-11'),
        throwsA(isA<PostgrestException>()),
      );
    });
  });

  group('fetchBabyReportProfile (route.ts:48-52 のクエリ仕様)', () {
    test('households から baby_name / baby_birth_date を single で取る', () async {
      final r = _profileRepo(
        row: {'baby_name': 'さくら', 'baby_birth_date': '2026-01-11'},
      );

      final profile = await r.repo.fetchBabyReportProfile('hh-1');

      expect(r.client.lastFromTable, 'households');
      expect(r.query.lastSelectColumns, 'baby_name, baby_birth_date');
      expect(r.filter.eqFilters, [(column: 'id', value: 'hh-1')]);
      expect(profile, (babyName: 'さくら', babyBirthDate: '2026-01-11'));
    });

    test('未設定 (null) はそのまま返す (縮退表示は Phase 2.6-2 の責務)', () async {
      final r = _profileRepo(
        row: {'baby_name': null, 'baby_birth_date': null},
      );

      final profile = await r.repo.fetchBabyReportProfile('hh-1');

      expect(profile, (babyName: null, babyBirthDate: null));
    });

    test('PostgrestException (0 行など) は握り潰さず rethrow する', () async {
      final r = _profileRepo(
        singleError: const PostgrestException(
          message: 'JSON object requested, multiple (or no) rows returned',
          code: 'PGRST116',
        ),
      );

      await expectLater(
        r.repo.fetchBabyReportProfile('hh-1'),
        throwsA(isA<PostgrestException>()),
      );
    });
  });
}
