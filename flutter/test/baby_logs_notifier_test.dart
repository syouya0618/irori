import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/baby/data/baby_logs_notifier.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// `BabyRepository` のフェイク。`implements` で constructor (SupabaseClient 要求)
/// を回避し、3 メソッドのみをテストから制御する。
class _FakeBabyRepository implements BabyRepository {
  _FakeBabyRepository({this.todayLogs = const [], this.error});

  final List<BabyLog> todayLogs;
  final Object? error;

  @override
  Future<List<BabyLog>> fetchTodayLogs(
    String householdId,
    String dateJst,
  ) async {
    if (error != null) throw error!;
    return todayLogs;
  }

  @override
  Future<DateTime?> fetchLastSleep(String householdId) async => null;

  @override
  Future<List<BabyLog>> fetchWeeklyLogs(
    String householdId,
    String from,
    String to,
  ) async => const [];
}

BabyLog _log(
  String id, {
  BabyLogType type = BabyLogType.memo,
  String memo = '',
  DateTime? loggedAt,
}) {
  final at = loggedAt ?? DateTime.utc(2026, 5, 29, 3);
  return BabyLog(
    id: id,
    householdId: 'hh-1',
    logType: type,
    loggedAt: at,
    loggedBy: 'user-1',
    memo: memo,
    createdAt: at,
  );
}

/// テスト用の `ProviderContainer` を構築する。
///
/// `supabaseClientProvider` を直接構築した client で override する。
/// `SupabaseClient(...)` の constructor は `Supabase.initialize()` 不要で、
/// 同期的に接続を張らない。Realtime の `subscribe()` は接続を queue するだけで
/// テスト本体内では throw しない (advisor 指示)。
///
/// 戻り値型 `Override` は riverpod 3.x で公開 export されていないため、
/// helper は型を露出せず container を直接返す。
ProviderContainer _makeContainer({
  required _FakeBabyRepository repo,
  required String? householdId,
}) {
  return ProviderContainer(
    overrides: [
      supabaseClientProvider.overrideWithValue(
        SupabaseClient('http://localhost:54321', 'test-anon-key'),
      ),
      currentHouseholdIdProvider.overrideWith((ref) async => householdId),
      babyRepositoryProvider.overrideWithValue(repo),
    ],
  );
}

void main() {
  group('BabyLogsNotifier AsyncValue 状態遷移 (Issue #49)', () {
    test('初回 read は AsyncLoading を返す', () {
      final container = _makeContainer(
        repo: _FakeBabyRepository(todayLogs: [_log('a')]),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      final state = container.read(babyLogsNotifierProvider);
      expect(state, isA<AsyncLoading<List<BabyLog>>>());
    });

    test('fetch 成功で AsyncData に今日のログが入る', () async {
      final logs = [_log('a', memo: '授乳'), _log('b', memo: 'おむつ')];
      final container = _makeContainer(
        repo: _FakeBabyRepository(todayLogs: logs),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      final result = await container.read(babyLogsNotifierProvider.future);
      expect(result.map((l) => l.id), ['a', 'b']);

      final state = container.read(babyLogsNotifierProvider);
      expect(state, isA<AsyncData<List<BabyLog>>>());
      expect(state.value, isNotNull);
      expect(state.value!.length, 2);
    });

    test('household_id が null (世帯未参加) なら空リストを返す', () async {
      // この経路は subscribe() を呼ばないため client override は不要だが、
      // 共通 helper を流用する (client は使われない)。
      final container = _makeContainer(
        repo: _FakeBabyRepository(todayLogs: [_log('a')]),
        householdId: null,
      );
      addTearDown(container.dispose);

      final result = await container.read(babyLogsNotifierProvider.future);
      expect(result, isEmpty);
      expect(
        container.read(babyLogsNotifierProvider),
        isA<AsyncData<List<BabyLog>>>(),
      );
    });

    test('fetch が PostgrestException を投げると AsyncError になる', () async {
      final container = _makeContainer(
        repo: _FakeBabyRepository(
          error: const PostgrestException(message: 'boom', code: '500'),
        ),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      // listen で provider を生かしたまま build() を起動する。
      //
      // NOTE: ここで `await provider.future` に頼らない理由 ——
      // 観測上、build() が PostgrestException を throw すると
      // `AsyncNotifierProvider.future` が pending のままになった (原因未特定。
      //  state は正しく AsyncError に遷移する)。UI が消費するのは
      // `AsyncValue.when(error:)` = state 側なので、ここでは state を直接
      // 検証する (実 UI の error 分岐と等価)。
      container.listen(
        babyLogsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );

      // 初期状態は loading であること (遷移の起点を明示し tautology を回避)。
      expect(container.read(babyLogsNotifierProvider).isLoading, isTrue);

      // build() は household 解決 → subscribe → fetch と複数の async hop を経るため、
      // 状態が loading から抜けるまで event loop を bounded に回して待つ
      // (固定回数の Duration.zero は hop 数依存で脆い)。
      for (
        var i = 0;
        i < 50 && container.read(babyLogsNotifierProvider).isLoading;
        i++
      ) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }

      final state = container.read(babyLogsNotifierProvider);
      expect(state.hasError, isTrue, reason: 'fetch 失敗で AsyncError になるはず');
      expect(state.error, isA<PostgrestException>());
    });
  });

  group('BabyLogsNotifier reducer (inline _reduce のロジック)', () {
    test('INSERT: 新規 id は先頭に追加される', () {
      final current = [_log('a'), _log('b')];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.insert,
        log: _log('c'),
        dateJst: '2026-05-29', // _log の loggedAt = JST 2026-05-29
      );
      expect(result.map((l) => l.id), ['c', 'a', 'b']);
    });

    test('INSERT: 既存 id は重複追加されない (dedup)', () {
      final current = [_log('a'), _log('b')];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.insert,
        log: _log('a', memo: '別内容'),
        dateJst: '2026-05-29',
      );
      // 重複追加せず、元のリストをそのまま保つ。
      expect(result.length, 2);
      expect(result.map((l) => l.id), ['a', 'b']);
    });

    test('INSERT: 今日 (JST) 範囲外のログは無視される (#49 date-window guard)', () {
      final current = [_log('a'), _log('b')];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.insert,
        // loggedAt が today (2026-05-29 JST) と異なる過去日
        log: _log('past', loggedAt: DateTime.utc(2026, 5, 20, 3)),
        dateJst: '2026-05-29',
      );
      // 過去日ログは追加されない (cross-client で過去日ログが today に漏れない)。
      expect(result.map((l) => l.id), ['a', 'b']);
    });

    test('UPDATE: 同一 id を置換する', () {
      final current = [_log('a', memo: '旧'), _log('b')];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.update,
        log: _log('a', memo: '新'),
      );
      expect(result.length, 2);
      expect(result.firstWhere((l) => l.id == 'a').memo, '新');
    });

    test('UPDATE: 範囲外 (未存在 id) は無視される', () {
      final current = [_log('a'), _log('b')];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.update,
        log: _log('z', memo: '範囲外'),
      );
      expect(result.map((l) => l.id), ['a', 'b']);
    });

    test('DELETE: 指定 id を除外する', () {
      final current = [_log('a'), _log('b'), _log('c')];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.delete,
        deletedId: 'b',
      );
      expect(result.map((l) => l.id), ['a', 'c']);
    });
  });
}
