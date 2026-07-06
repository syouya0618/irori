import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/data/baby_weekly_summary_provider.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/domain/baby_weekly_summary.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// `BabyRepository` のフェイク。`Fake` で constructor (SupabaseClient 要求) を
/// 回避し、`fetchWeeklyLogs` のみテストから制御する (`_FakeMealsRepository` の
/// weekly 版)。
///
/// [gated] が true なら fetch ごとに `Completer` を [gates] に積んで停止する。
/// テスト側が任意順に complete することで「初期化中 window」を再現する。
class _FakeBabyRepository extends Fake implements BabyRepository {
  _FakeBabyRepository({this.logs = const [], this.error, this.gated = false});

  /// gated でない fetch が返す canned 値。テスト中に差し替え可能。
  List<BabyLog> logs;

  /// 非 null なら fetch がこの例外で失敗する。テスト中に差し替え可能
  /// (refetch 失敗ケースを初期 fetch 成功後に注入するため)。
  Object? error;
  final bool gated;
  final gates = <Completer<List<BabyLog>>>[];

  int fetchCount = 0;
  final fetchCalls = <({String householdId, String from, String to})>[];

  @override
  Future<List<BabyLog>> fetchWeeklyLogs(
    String householdId,
    String from,
    String to,
  ) {
    fetchCount++;
    fetchCalls.add((householdId: householdId, from: from, to: to));
    if (gated) {
      final gate = Completer<List<BabyLog>>();
      gates.add(gate);
      return gate.future;
    }
    if (error != null) return Future.error(error!);
    return Future.value(logs);
  }
}

/// 「今日 (JST)」に属する授乳ログ。`buildBabyWeeklySummary` は JST 日付で
/// feeding をカウントするため、`loggedAt = now` は必ず週窓の末日 (today) に入る。
BabyLog _feedingNow() => BabyLog(
  id: 'f-1',
  householdId: 'hh-1',
  logType: BabyLogType.feeding,
  loggedAt: DateTime.now().toUtc(),
  loggedBy: 'user-1',
  feedingType: FeedingType.bottle,
  createdAt: DateTime.now().toUtc(),
);

/// realtime payload を構築する (refetch シグナルとして使うため中身は最小)。
PostgresChangePayload _payload() => PostgresChangePayload(
  schema: 'public',
  table: 'baby_logs',
  commitTimestamp: DateTime.utc(2026, 6, 8),
  eventType: PostgresChangeEvent.insert,
  newRecord: const {'id': 'x'},
  oldRecord: const {},
  errors: null,
);

int _totalFeeding(List<BabyWeeklySummaryDay> days) =>
    totalBabyWeeklySummary(days).feedingCount;

ProviderContainer _makeContainer({
  required _FakeBabyRepository repo,
  required String? householdId,
  SupabaseClient? client,
}) {
  return ProviderContainer(
    overrides: [
      supabaseClientProvider.overrideWithValue(
        client ?? SupabaseClient('http://localhost:54321', 'test-anon-key'),
      ),
      currentHouseholdIdProvider.overrideWith((ref) async => householdId),
      babyRepositoryProvider.overrideWithValue(repo),
    ],
  );
}

/// `.future` を await せず、state が条件を満たすまで event loop を bounded に
/// 回して待つ (baby/meals notifier テストと同じ流儀 — build() throw 時に
/// `.future` が pending のまま残る既知の挙動を踏まないため)。
Future<void> _pumpUntil(bool Function() done) async {
  for (var i = 0; i < 50 && !done(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
}

void main() {
  group('BabyWeeklySummaryNotifier 状態遷移', () {
    test('fetch 成功で AsyncData に直近 7 日分が入る', () async {
      final repo = _FakeBabyRepository(logs: [_feedingNow()]);
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      container.listen(
        babyWeeklySummaryProvider,
        (_, _) {},
        fireImmediately: true,
      );
      await _pumpUntil(
        () => container.read(babyWeeklySummaryProvider).hasValue,
      );

      final state = container.read(babyWeeklySummaryProvider);
      expect(state.value, hasLength(7), reason: '週窓は常に 7 日');
      expect(_totalFeeding(state.value!), 1);
      expect(repo.fetchCalls.single.householdId, 'hh-1');
      // 週窓 [today-6, today] を JST 日界で切る (+09:00 付き ISO)。
      expect(repo.fetchCalls.single.from, endsWith('T00:00:00+09:00'));
      expect(repo.fetchCalls.single.to, endsWith('T00:00:00+09:00'));
    });

    test('household_id が null (世帯未参加) なら空を返し fetch も subscribe もしない', () async {
      final client = SupabaseClient('http://localhost:54321', 'test-anon-key');
      final repo = _FakeBabyRepository(logs: [_feedingNow()]);
      final container = _makeContainer(
        repo: repo,
        householdId: null,
        client: client,
      );
      addTearDown(container.dispose);

      final result = await container.read(babyWeeklySummaryProvider.future);
      expect(result, isEmpty);
      expect(repo.fetchCount, 0);
      expect(client.getChannels(), isEmpty, reason: '未参加なら購読しない');
    });

    test('初期 fetch が PostgrestException を投げると AsyncError になる', () async {
      final repo = _FakeBabyRepository(
        error: const PostgrestException(message: 'boom', code: '500'),
      );
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      container.listen(
        babyWeeklySummaryProvider,
        (_, _) {},
        fireImmediately: true,
      );
      expect(container.read(babyWeeklySummaryProvider).isLoading, isTrue);

      await _pumpUntil(
        () => !container.read(babyWeeklySummaryProvider).isLoading,
      );

      final state = container.read(babyWeeklySummaryProvider);
      expect(state.hasError, isTrue, reason: '初期 fetch 失敗は AsyncError');
      expect(state.error, isA<PostgrestException>());
    });
  });

  group('BabyWeeklySummaryNotifier realtime refetch 方式', () {
    test('payload で週窓を refetch し days が差し替わる', () async {
      final repo = _FakeBabyRepository(logs: const []);
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      container.listen(
        babyWeeklySummaryProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(babyWeeklySummaryProvider.notifier);
      await _pumpUntil(
        () => container.read(babyWeeklySummaryProvider).hasValue,
      );
      expect(notifier.debugInitialized, isTrue);
      expect(repo.fetchCount, 1);
      expect(
        _totalFeeding(container.read(babyWeeklySummaryProvider).value!),
        0,
      );

      // 週内の cross-client 書き込みで授乳が 1 件増えた想定 (payload からは
      // 集計を畳めないため、canned データを差し替えて refetch 反映を検証する)。
      repo.logs = [_feedingNow()];
      notifier.debugHandlePayload(_payload());

      await _pumpUntil(() => repo.fetchCount >= 2);
      await _pumpUntil(
        () =>
            _totalFeeding(
              container.read(babyWeeklySummaryProvider).value ?? const [],
            ) ==
            1,
      );
      expect(repo.fetchCount, 2);
      final state = container.read(babyWeeklySummaryProvider);
      expect(state.value, hasLength(7));
      expect(_totalFeeding(state.value!), 1);
    });

    test('refetch 失敗は state を AsyncError に倒さず現状維持する', () async {
      final repo = _FakeBabyRepository(logs: [_feedingNow()]);
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      container.listen(
        babyWeeklySummaryProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(babyWeeklySummaryProvider.notifier);
      await _pumpUntil(
        () => container.read(babyWeeklySummaryProvider).hasValue,
      );
      expect(
        _totalFeeding(container.read(babyWeeklySummaryProvider).value!),
        1,
      );

      // 初期 fetch 成功後、次の fetch (refetch) だけ失敗させる。
      repo.error = const PostgrestException(message: 'boom', code: '500');
      notifier.debugHandlePayload(_payload());

      await _pumpUntil(() => repo.fetchCount >= 2);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      // background refresh の失敗で表示中の週間チャートを吹き飛ばさない。
      final state = container.read(babyWeeklySummaryProvider);
      expect(state.hasError, isFalse);
      expect(state.value, hasLength(7));
      expect(_totalFeeding(state.value!), 1, reason: '現状維持');
    });
  });

  group('BabyWeeklySummaryNotifier 初期化中の payload (フラグ → build 内 refetch)', () {
    test('初期 fetch 中の payload は並走 refetch せず、完了後に 1 回 fetch し直す', () async {
      final repo = _FakeBabyRepository(gated: true);
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      container.listen(
        babyWeeklySummaryProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(babyWeeklySummaryProvider.notifier);

      // build が fetch1 の await (gate) に到達するまで進める。
      await _pumpUntil(() => repo.gates.length == 1);
      expect(notifier.debugInitialized, isFalse, reason: 'fetch 未完なので未初期化');

      // 初期化中に payload 到着 → 破棄せずフラグに畳む。並走 refetch はしない。
      notifier.debugHandlePayload(_payload());
      expect(notifier.debugRefetchQueued, isTrue);
      expect(repo.fetchCount, 1, reason: '初期化中は refetch を並走させない');

      // fetch1 完了 → build がフラグを消費して fetch2 を行う。
      repo.gates[0].complete(const []);
      await _pumpUntil(() => repo.gates.length == 2);
      expect(notifier.debugRefetchQueued, isFalse);

      // fetch2 の結果が最終的な初期 state になる (取りこぼしゼロ)。
      repo.gates[1].complete([_feedingNow()]);
      await _pumpUntil(
        () => container.read(babyWeeklySummaryProvider).hasValue,
      );
      expect(notifier.debugInitialized, isTrue);
      final state = container.read(babyWeeklySummaryProvider);
      expect(state.value, hasLength(7));
      expect(_totalFeeding(state.value!), 1);
      expect(repo.fetchCount, 2);
    });
  });

  group('BabyWeeklySummaryNotifier channel ライフサイクル', () {
    test('subscribe された channel は dispose で removeChannel される', () async {
      final client = SupabaseClient('http://localhost:54321', 'test-anon-key');
      final repo = _FakeBabyRepository(logs: const []);
      final container = _makeContainer(
        repo: repo,
        householdId: 'hh-1',
        client: client,
      );

      container.listen(
        babyWeeklySummaryProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(babyWeeklySummaryProvider.notifier);
      await _pumpUntil(
        () => container.read(babyWeeklySummaryProvider).hasValue,
      );

      expect(client.getChannels(), hasLength(1));
      // topic は household + 単調カウンタで一意化される (resubscribe の teardown
      // window で旧/新 channel が衝突しないため)。seq は module-level で
      // テスト実行順に依存するため、prefix のみ検証する。
      expect(notifier.debugChannelTopic, startsWith('baby_weekly:hh-1:'));

      container.dispose();
      await _pumpUntil(() => client.getChannels().isEmpty);
      expect(client.getChannels(), isEmpty, reason: 'leak 防止 (ref.onDispose)');
    });

    test('topic は subscribe ごとに一意 (同一世帯でも別 topic)', () async {
      final client1 = SupabaseClient('http://localhost:54321', 'test-anon-key');
      final container1 = _makeContainer(
        repo: _FakeBabyRepository(logs: const []),
        householdId: 'hh-1',
        client: client1,
      );
      addTearDown(container1.dispose);
      container1.listen(
        babyWeeklySummaryProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier1 = container1.read(babyWeeklySummaryProvider.notifier);
      await _pumpUntil(
        () => container1.read(babyWeeklySummaryProvider).hasValue,
      );

      final client2 = SupabaseClient('http://localhost:54321', 'test-anon-key');
      final container2 = _makeContainer(
        repo: _FakeBabyRepository(logs: const []),
        householdId: 'hh-1',
        client: client2,
      );
      addTearDown(container2.dispose);
      container2.listen(
        babyWeeklySummaryProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier2 = container2.read(babyWeeklySummaryProvider.notifier);
      await _pumpUntil(
        () => container2.read(babyWeeklySummaryProvider).hasValue,
      );

      expect(notifier1.debugChannelTopic, startsWith('baby_weekly:hh-1:'));
      expect(notifier2.debugChannelTopic, startsWith('baby_weekly:hh-1:'));
      expect(
        notifier1.debugChannelTopic,
        isNot(notifier2.debugChannelTopic),
        reason: '単調カウンタで globally 一意',
      );
    });
  });
}
