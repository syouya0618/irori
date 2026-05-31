import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/baby/data/baby_logs_notifier.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/data/selected_baby_date_provider.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// `BabyRepository` のフェイク。`implements` で constructor (SupabaseClient 要求)
/// を回避し、3 メソッドのみをテストから制御する。
class _FakeBabyRepository implements BabyRepository {
  _FakeBabyRepository({this.todayLogs = const [], this.error, this.fetchGate});

  final List<BabyLog> todayLogs;
  final Object? error;

  /// 非 null なら `fetchLogsForDate` がこの future を await してから返す。
  /// 「subscribe 済みだが fetch 未完」= `_initialized==false` の初期化中 window を
  /// テストから作り、realtime バッファリング (#54 item2 / C2) を検証するためのゲート。
  final Future<void>? fetchGate;

  @override
  Future<List<BabyLog>> fetchLogsForDate(
    String householdId,
    String dateJst,
  ) async {
    if (fetchGate != null) await fetchGate;
    if (error != null) throw error!;
    return todayLogs;
  }

  @override
  Future<List<BabyLog>> fetchTodayLogs(
    String householdId,
    String dateJst,
  ) => fetchLogsForDate(householdId, dateJst);

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

/// realtime INSERT payload を構築する (C2 seam テスト用)。
/// `newRecord` は `BabyLog.toJson()` の snake_case 行 (fromJson が受ける形)。
PostgresChangePayload _insertPayload(BabyLog log) => PostgresChangePayload(
  schema: 'public',
  table: 'baby_logs',
  commitTimestamp: DateTime.utc(2026, 5, 29),
  eventType: PostgresChangeEvent.insert,
  newRecord: log.toJson(),
  oldRecord: const {},
  errors: null,
);

/// realtime DELETE payload を構築する (oldRecord に PK のみ)。
PostgresChangePayload _deletePayload(String id) => PostgresChangePayload(
  schema: 'public',
  table: 'baby_logs',
  commitTimestamp: DateTime.utc(2026, 5, 29),
  eventType: PostgresChangeEvent.delete,
  newRecord: const {},
  oldRecord: {'id': id},
  errors: null,
);

/// selectedBabyDate を固定する Notifier (C2 テストで日付を固定し
/// INSERT date-window guard を通すため)。
class _FixedDateNotifier extends SelectedBabyDateNotifier {
  _FixedDateNotifier(this._d);
  final String _d;
  @override
  String build() => _d;
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
  String? selectedDate,
}) {
  return ProviderContainer(
    overrides: [
      supabaseClientProvider.overrideWithValue(
        SupabaseClient('http://localhost:54321', 'test-anon-key'),
      ),
      currentHouseholdIdProvider.overrideWith((ref) async => householdId),
      babyRepositoryProvider.overrideWithValue(repo),
      if (selectedDate != null)
        selectedBabyDateProvider.overrideWith(
          () => _FixedDateNotifier(selectedDate),
        ),
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

    test('INSERT: logged_at 降順を維持する位置に挿入される (#54 sorted insert)', () {
      // 既存: a=05:00, c=01:00 (降順)。新規 b=03:00 は a と c の間に入るべき。
      final current = [
        _log('a', loggedAt: DateTime.utc(2026, 5, 29, 5)),
        _log('c', loggedAt: DateTime.utc(2026, 5, 29, 1)),
      ];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.insert,
        log: _log('b', loggedAt: DateTime.utc(2026, 5, 29, 3)),
        dateJst: '2026-05-29',
      );
      expect(result.map((l) => l.id), ['a', 'b', 'c']);
    });

    test('INSERT: 同タイムスタンプなら新規が前 (#54 stable prepend-on-equal)', () {
      // a/b/c すべて同一 loggedAt。新規 c は先頭に来る (原典 prepend 互換)。
      final current = [_log('a'), _log('b')];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.insert,
        log: _log('c'),
        dateJst: '2026-05-29',
      );
      expect(result.map((l) => l.id), ['c', 'a', 'b']);
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

    // UPDATE 4 遷移 (#54): belongs = log が selectedDate (dateJst) に属するか、
    // exists = current に同 id があるか。Next.js 原典 baby-dashboard.tsx L123-136。
    test('UPDATE 遷移1 (belongs && exists): 同一 id を置換する', () {
      final current = [_log('a', memo: '旧'), _log('b')];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.update,
        log: _log('a', memo: '新'),
        dateJst: '2026-05-29', // _log の loggedAt = JST 2026-05-29
      );
      expect(result.length, 2);
      expect(result.firstWhere((l) => l.id == 'a').memo, '新');
    });

    test('UPDATE 遷移2 (belongs && !exists): selectedDate に入ってきたら追加', () {
      // 別日のログが編集で selectedDate (5/29) に移動してきたケース。
      final current = [
        _log('a', loggedAt: DateTime.utc(2026, 5, 29, 5)),
        _log('b', loggedAt: DateTime.utc(2026, 5, 29, 1)),
      ];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.update,
        // 新 loggedAt = 5/29 03:00 UTC → b と a の間 (降順維持なら index 1)
        log: _log('new', loggedAt: DateTime.utc(2026, 5, 29, 3)),
        dateJst: '2026-05-29',
      );
      // 追加され、logged_at 降順 (a=05:00, new=03:00, b=01:00) を維持する。
      expect(result.map((l) => l.id), ['a', 'new', 'b']);
    });

    test('UPDATE 遷移3 (!belongs && exists): selectedDate から外れたら除外', () {
      // selectedDate (5/29) にあったログが編集で別日に移動したケース。
      final current = [_log('a'), _log('b')];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.update,
        // 新 loggedAt が過去日 (5/20) → selectedDate 5/29 に属さない
        log: _log('a', loggedAt: DateTime.utc(2026, 5, 20, 3)),
        dateJst: '2026-05-29',
      );
      expect(result.map((l) => l.id), ['b']);
    });

    test('UPDATE 遷移4 (!belongs && !exists): 無関係な更新は noop', () {
      final current = [_log('a'), _log('b')];
      final result = BabyLogsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.update,
        // 別日 (5/20) かつ未存在 id
        log: _log('z', loggedAt: DateTime.utc(2026, 5, 20, 3)),
        dateJst: '2026-05-29',
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

  group('BabyLogsNotifier realtime バッファ & live 経路 (#54 item2 / C2)', () {
    test(
      '初期化中に届いた INSERT はバッファされ fetch 後に drain される (取りこぼしゼロ)',
      () async {
        final gate = Completer<void>();
        final container = _makeContainer(
          repo: _FakeBabyRepository(
            todayLogs: [_log('base')],
            fetchGate: gate.future,
          ),
          householdId: 'hh-1',
          selectedDate: '2026-05-29', // _log の loggedAt = JST 2026-05-29
        );
        addTearDown(container.dispose);

        // build 起動。fetch は gate で停止 → subscribe 済み / _initialized=false。
        // build() 冒頭で _pendingDuringInit.clear() 済みの状態に到達させる。
        container.listen(
          babyLogsNotifierProvider,
          (_, _) {},
          fireImmediately: true,
        );
        final notifier = container.read(babyLogsNotifierProvider.notifier);

        // build が fetch await (gate) に到達するまで進める。
        await Future<void>.delayed(const Duration(milliseconds: 5));
        expect(
          notifier.debugInitialized,
          isFalse,
          reason: 'fetch 未完なので未初期化',
        );

        // 初期化中に realtime INSERT 到着 → 破棄されずバッファに溜まる。
        notifier.debugHandlePayload(_insertPayload(_log('rt1')));
        expect(notifier.debugPendingCount, 1);

        // fetch 完了 → build() が drain。
        gate.complete();
        await container.read(babyLogsNotifierProvider.future);

        expect(notifier.debugInitialized, isTrue);
        expect(notifier.debugPendingCount, 0, reason: 'drain 後バッファは空');
        final state = container.read(babyLogsNotifierProvider);
        // rt1 (初期化中 event) が取りこぼされず base と共に反映される。
        expect(state.value!.map((l) => l.id), containsAll(['rt1', 'base']));
      },
    );

    test('build 完了後の live INSERT は即 state に反映される', () async {
      final container = _makeContainer(
        repo: _FakeBabyRepository(todayLogs: [_log('base')]),
        householdId: 'hh-1',
        selectedDate: '2026-05-29',
      );
      addTearDown(container.dispose);

      container.listen(
        babyLogsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(babyLogsNotifierProvider.notifier);
      await container.read(babyLogsNotifierProvider.future);
      expect(notifier.debugInitialized, isTrue);

      notifier.debugHandlePayload(_insertPayload(_log('rt2')));
      final state = container.read(babyLogsNotifierProvider);
      expect(state.value!.map((l) => l.id), containsAll(['rt2', 'base']));
    });

    test('build 完了後の live DELETE は state から除外される', () async {
      final container = _makeContainer(
        repo: _FakeBabyRepository(todayLogs: [_log('a'), _log('b')]),
        householdId: 'hh-1',
        selectedDate: '2026-05-29',
      );
      addTearDown(container.dispose);

      container.listen(
        babyLogsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(babyLogsNotifierProvider.notifier);
      await container.read(babyLogsNotifierProvider.future);

      notifier.debugHandlePayload(_deletePayload('a'));
      final state = container.read(babyLogsNotifierProvider);
      expect(state.value!.map((l) => l.id), ['b']);
    });
  });
}
