import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/data/meals_week_notifier.dart';
import 'package:irori/features/meals/data/selected_week_start_provider.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// `MealsRepository` のフェイク。`Fake` で constructor (SupabaseClient 要求)
/// を回避し、`fetchWeekMeals` のみテストから制御する。
///
/// [gated] が true なら fetch ごとに `Completer` を [gates] に積んで停止する。
/// テスト側が任意の順序で complete することで「初期化中 window」「stale fetch の
/// 遅延完了」を再現する (baby の fetchGate の複数 fetch 版)。
class _FakeMealsRepository extends Fake implements MealsRepository {
  _FakeMealsRepository({this.meals = const [], this.error, this.gated = false});

  /// gated でない fetch が返す canned 値。テスト中に差し替え可能。
  List<Meal> meals;

  /// 非 null なら fetch がこの例外で失敗する。テスト中に差し替え可能
  /// (refetch 失敗ケースを初期 fetch 成功後に注入するため)。
  Object? error;
  final bool gated;
  final gates = <Completer<List<Meal>>>[];

  int fetchCount = 0;
  final fetchCalls = <({String householdId, String weekStartYmd})>[];

  @override
  Future<List<Meal>> fetchWeekMeals(String householdId, String weekStartYmd) {
    fetchCount++;
    fetchCalls.add((householdId: householdId, weekStartYmd: weekStartYmd));
    if (gated) {
      final gate = Completer<List<Meal>>();
      gates.add(gate);
      return gate.future;
    }
    if (error != null) return Future.error(error!);
    return Future.value(meals);
  }
}

Meal _meal(String id, {String date = '2026-06-08'}) => Meal(
  id: id,
  date: date,
  mealType: MealType.dinner,
  title: '献立$id',
  isEatingOut: false,
);

/// realtime payload を構築する (refetch シグナルとして使うため中身は最小)。
PostgresChangePayload _payload({String table = 'meals'}) =>
    PostgresChangePayload(
      schema: 'public',
      table: table,
      commitTimestamp: DateTime.utc(2026, 6, 8),
      eventType: PostgresChangeEvent.insert,
      newRecord: const {'id': 'm-new'},
      oldRecord: const {},
      errors: null,
    );

/// selectedWeekStart の初期値を固定する Notifier (週切替メソッドは実装を継承)。
class _FixedWeekNotifier extends SelectedWeekStartNotifier {
  _FixedWeekNotifier(this._w);
  final String _w;
  @override
  String build() => _w;
}

ProviderContainer _makeContainer({
  required _FakeMealsRepository repo,
  required String? householdId,
  String weekStart = '2026-06-08',
  SupabaseClient? client,
}) {
  return ProviderContainer(
    overrides: [
      supabaseClientProvider.overrideWithValue(
        client ?? SupabaseClient('http://localhost:54321', 'test-anon-key'),
      ),
      currentHouseholdIdProvider.overrideWith((ref) async => householdId),
      mealsRepositoryProvider.overrideWithValue(repo),
      selectedWeekStartProvider.overrideWith(
        () => _FixedWeekNotifier(weekStart),
      ),
    ],
  );
}

/// `.future` を await せず、state が条件を満たすまで event loop を bounded に
/// 回して待つ (baby テストと同じ流儀 — build() throw 時に `.future` が pending
/// のまま残る既知の挙動を踏まないため)。
Future<void> _pumpUntil(bool Function() done) async {
  for (var i = 0; i < 50 && !done(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
}

void main() {
  group('MealsWeekNotifier 状態遷移', () {
    test('fetch 成功で AsyncData に週の献立が入る', () async {
      final repo = _FakeMealsRepository(meals: [_meal('a'), _meal('b')]);
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      container.listen(
        mealsWeekNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      await _pumpUntil(
        () => container.read(mealsWeekNotifierProvider).hasValue,
      );

      final state = container.read(mealsWeekNotifierProvider);
      expect(state.value!.map((m) => m.id), ['a', 'b']);
      expect(repo.fetchCalls.single, (
        householdId: 'hh-1',
        weekStartYmd: '2026-06-08',
      ));
    });

    test('household_id が null (世帯未参加) なら空リストを返し fetch しない', () async {
      final repo = _FakeMealsRepository(meals: [_meal('a')]);
      final container = _makeContainer(repo: repo, householdId: null);
      addTearDown(container.dispose);

      final result = await container.read(mealsWeekNotifierProvider.future);
      expect(result, isEmpty);
      expect(repo.fetchCount, 0);
    });

    test('fetch が PostgrestException を投げると AsyncError になる', () async {
      final repo = _FakeMealsRepository(
        error: const PostgrestException(message: 'boom', code: '500'),
      );
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      container.listen(
        mealsWeekNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      expect(container.read(mealsWeekNotifierProvider).isLoading, isTrue);

      await _pumpUntil(
        () => !container.read(mealsWeekNotifierProvider).isLoading,
      );

      final state = container.read(mealsWeekNotifierProvider);
      expect(state.hasError, isTrue, reason: 'fetch 失敗で AsyncError になるはず');
      expect(state.error, isA<PostgrestException>());
    });
  });

  group('MealsWeekNotifier realtime refetch 方式', () {
    test('meals payload で現在週を refetch し state が更新される', () async {
      final repo = _FakeMealsRepository(meals: [_meal('a')]);
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      container.listen(
        mealsWeekNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(mealsWeekNotifierProvider.notifier);
      await _pumpUntil(
        () => container.read(mealsWeekNotifierProvider).hasValue,
      );
      expect(notifier.debugInitialized, isTrue);
      expect(repo.fetchCount, 1);

      // パートナーの操作で行が増えた想定 (payload に nested は来ないため、
      // canned データを差し替えて refetch 結果で反映されることを検証する)。
      repo.meals = [_meal('a'), _meal('rt')];
      notifier.debugHandlePayload(_payload());

      await _pumpUntil(() => repo.fetchCount >= 2);
      await _pumpUntil(
        () => container.read(mealsWeekNotifierProvider).value?.length == 2,
      );
      expect(repo.fetchCount, 2);
      final state = container.read(mealsWeekNotifierProvider);
      expect(state.value!.map((m) => m.id), ['a', 'rt']);
    });

    test('meal_reactions payload でも refetch が発火する (web 版の弱点解消)', () async {
      final repo = _FakeMealsRepository(meals: [_meal('a')]);
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      container.listen(
        mealsWeekNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(mealsWeekNotifierProvider.notifier);
      await _pumpUntil(
        () => container.read(mealsWeekNotifierProvider).hasValue,
      );

      notifier.debugHandlePayload(_payload(table: 'meal_reactions'));

      await _pumpUntil(() => repo.fetchCount >= 2);
      expect(repo.fetchCount, 2);
    });

    test('refetch 失敗は state を AsyncError に倒さず現状維持する', () async {
      final repo = _FakeMealsRepository(meals: [_meal('a')]);
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      container.listen(
        mealsWeekNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(mealsWeekNotifierProvider.notifier);
      await _pumpUntil(
        () => container.read(mealsWeekNotifierProvider).hasValue,
      );

      // 初期 fetch 成功後、次の fetch (refetch) だけ失敗させる。
      repo.error = const PostgrestException(message: 'boom', code: '500');
      notifier.debugHandlePayload(_payload());

      await _pumpUntil(() => repo.fetchCount >= 2);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      // background refresh の失敗で表示中の週ビューを吹き飛ばさない。
      final state = container.read(mealsWeekNotifierProvider);
      expect(state.hasError, isFalse);
      expect(state.value!.map((m) => m.id), ['a']);
    });
  });

  group('MealsWeekNotifier 週切替と世代カウンタ', () {
    test('週切替で build が再実行され新しい週で refetch される', () async {
      final repo = _FakeMealsRepository(meals: [_meal('a')]);
      final container = _makeContainer(
        repo: repo,
        householdId: 'hh-1',
        weekStart: '2026-06-08',
      );
      addTearDown(container.dispose);

      container.listen(
        mealsWeekNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      await _pumpUntil(
        () => container.read(mealsWeekNotifierProvider).hasValue,
      );
      expect(repo.fetchCalls.last.weekStartYmd, '2026-06-08');

      container.read(selectedWeekStartProvider.notifier).previousWeek();

      await _pumpUntil(() => repo.fetchCount >= 2);
      expect(repo.fetchCalls.last.weekStartYmd, '2026-06-01');
    });

    test('世代カウンタ: 週切替後に完了した古い refetch の結果は破棄される', () async {
      final repo = _FakeMealsRepository(gated: true);
      final container = _makeContainer(
        repo: repo,
        householdId: 'hh-1',
        weekStart: '2026-06-08',
      );
      addTearDown(container.dispose);

      container.listen(
        mealsWeekNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(mealsWeekNotifierProvider.notifier);

      // fetch1 (build) を完了させ初期化する。
      await _pumpUntil(() => repo.gates.length == 1);
      repo.gates[0].complete([_meal('w1')]);
      await _pumpUntil(
        () => container.read(mealsWeekNotifierProvider).hasValue,
      );
      expect(notifier.debugInitialized, isTrue);

      // 旧週への live payload → fetch2 (refetch) が in-flight になる。
      notifier.debugHandlePayload(_payload());
      await _pumpUntil(() => repo.gates.length == 2);

      // 週切替 → build 再実行 → fetch3。
      container.read(selectedWeekStartProvider.notifier).previousWeek();
      await _pumpUntil(() => repo.gates.length == 3);

      // 新週の fetch3 を先に完了 → state は新週のデータになる。
      repo.gates[2].complete([_meal('w2', date: '2026-06-01')]);
      await _pumpUntil(
        () =>
            container.read(mealsWeekNotifierProvider).value?.single.id == 'w2',
      );

      // 旧週の fetch2 (stale) が遅れて完了しても上書きされない (世代ガード)。
      repo.gates[1].complete([_meal('stale')]);
      await Future<void>.delayed(const Duration(milliseconds: 10));
      final state = container.read(mealsWeekNotifierProvider);
      expect(state.value!.single.id, 'w2', reason: 'stale fetch 結果は破棄されるはず');
    });
  });

  group('MealsWeekNotifier 初期化中の payload (フラグ → build 内 refetch)', () {
    test('初期 fetch 中の payload は並走 refetch せず、完了後に 1 回 fetch し直す', () async {
      final repo = _FakeMealsRepository(gated: true);
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      container.listen(
        mealsWeekNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(mealsWeekNotifierProvider.notifier);

      // build が fetch1 の await (gate) に到達するまで進める。
      await _pumpUntil(() => repo.gates.length == 1);
      expect(notifier.debugInitialized, isFalse, reason: 'fetch 未完なので未初期化');

      // 初期化中に payload 到着 → 破棄せずフラグに畳む。並走 refetch はしない。
      notifier.debugHandlePayload(_payload());
      expect(notifier.debugRefetchQueued, isTrue);
      expect(repo.fetchCount, 1, reason: '初期化中は refetch を並走させない');

      // fetch1 完了 → build がフラグを消費して fetch2 を行う。
      repo.gates[0].complete([_meal('stale-initial')]);
      await _pumpUntil(() => repo.gates.length == 2);
      expect(notifier.debugRefetchQueued, isFalse);

      // fetch2 の結果が最終的な初期 state になる (取りこぼしゼロ)。
      repo.gates[1].complete([_meal('fresh')]);
      await _pumpUntil(
        () => container.read(mealsWeekNotifierProvider).hasValue,
      );
      expect(notifier.debugInitialized, isTrue);
      final state = container.read(mealsWeekNotifierProvider);
      expect(state.value!.single.id, 'fresh');
      expect(repo.fetchCount, 2);
    });
  });

  group('MealsWeekNotifier channel ライフサイクル', () {
    test('subscribe された channel は dispose で removeChannel される', () async {
      final client = SupabaseClient('http://localhost:54321', 'test-anon-key');
      final repo = _FakeMealsRepository(meals: [_meal('a')]);
      final container = _makeContainer(
        repo: repo,
        householdId: 'hh-1',
        client: client,
      );

      container.listen(
        mealsWeekNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(mealsWeekNotifierProvider.notifier);
      await _pumpUntil(
        () => container.read(mealsWeekNotifierProvider).hasValue,
      );

      expect(client.getChannels(), hasLength(1));
      // topic は household + 週で一意化される (週切替の teardown window で
      // 旧/新 channel が衝突しないため)。`RealtimeChannel.topic` は @internal
      // のため、notifier の seam で検証する。
      expect(notifier.debugChannelTopic, 'meals:hh-1:2026-06-08');

      container.dispose();
      await _pumpUntil(() => client.getChannels().isEmpty);
      expect(client.getChannels(), isEmpty, reason: 'leak 防止 (ref.onDispose)');
    });
  });
}
