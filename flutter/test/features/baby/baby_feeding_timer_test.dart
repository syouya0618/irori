import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/data/feeding_timer_store.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/presentation/widgets/baby_feeding_timer.dart';

class _Repo extends Fake implements BabyRepository {
  FeedingType? feedingType;
  int? durationMin;
  int recordFeedingCalls = 0;

  @override
  Future<void> recordFeeding({
    required String householdId,
    required String userId,
    required FeedingType feedingType,
    int? amountMl,
    int? durationMin,
    String? memo,
  }) async {
    recordFeedingCalls++;
    this.feedingType = feedingType;
    this.durationMin = durationMin;
  }
}

class _FakeStore implements FeedingTimerStore {
  _FakeStore([this.state]);

  FeedingTimerState? state;
  int clearCalls = 0;
  int saveCalls = 0;

  @override
  Future<FeedingTimerState?> load() async => state;

  @override
  Future<void> save(FeedingTimerState newState) async {
    state = newState;
    saveCalls++;
  }

  @override
  Future<void> clear() async {
    state = null;
    clearCalls++;
  }
}

Widget _wrap({
  required _Repo repo,
  required _FakeStore store,
  required DateTime Function() clock,
  FeedingType initialType = FeedingType.breastLeft,
  VoidCallback? onClose,
}) {
  return ProviderScope(
    overrides: [
      babyRepositoryProvider.overrideWithValue(repo),
      feedingTimerStoreProvider.overrideWithValue(store),
      babyMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
    ],
    child: MaterialApp(
      home: Scaffold(
        body: BabyFeedingTimerSheet(
          initialType: initialType,
          clock: clock,
          onClose: onClose,
        ),
      ),
    ),
  );
}

/// 非同期の `_restoreOrStart` (store.load → setState → ticker) を完了させる。
Future<void> _settleRestore(WidgetTester tester) async {
  await tester.pump(); // initState の microtask
  await tester.pump(const Duration(milliseconds: 10));
}

void main() {
  group('BabyFeedingTimerSheet', () {
    testWidgets('開くと新規タイマーを開始し保存する', (tester) async {
      final repo = _Repo();
      final store = _FakeStore();
      final now = DateTime(2026, 4, 11, 10, 0, 0);

      await tester.pumpWidget(
        _wrap(repo: repo, store: store, clock: () => now),
      );
      await _settleRestore(tester);

      expect(find.text('授乳タイマー'), findsOneWidget);
      expect(find.text('00:00'), findsOneWidget);
      // 新規開始は保存される (中断復元のため)。
      expect(store.saveCalls, 1);
      expect(store.state?.feedingType, FeedingType.breastLeft);
    });

    testWidgets('停止で経過分を durationMin として記録し閉じる', (tester) async {
      final repo = _Repo();
      final store = _FakeStore();
      var now = DateTime(2026, 4, 11, 10, 0, 0);
      var closed = false;

      await tester.pumpWidget(
        _wrap(
          repo: repo,
          store: store,
          clock: () => now,
          onClose: () => closed = true,
        ),
      );
      await _settleRestore(tester);

      // 3 分経過させる。
      now = DateTime(2026, 4, 11, 10, 3, 0);
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('03:00'), findsOneWidget);

      await tester.tap(find.text('停止して記録'));
      await tester.pump(); // _handleStop の await 群
      await tester.pump();

      expect(repo.recordFeedingCalls, 1);
      expect(repo.feedingType, FeedingType.breastLeft);
      expect(repo.durationMin, 3);
      expect(store.clearCalls, greaterThanOrEqualTo(1));
      expect(closed, isTrue);
      expect(find.text('授乳を記録しました（3分）'), findsOneWidget);
    });

    testWidgets('左右切替が記録 feedingType と保存に反映される', (tester) async {
      final repo = _Repo();
      final store = _FakeStore();
      var now = DateTime(2026, 4, 11, 10, 0, 0);

      await tester.pumpWidget(
        _wrap(repo: repo, store: store, clock: () => now, onClose: () {}),
      );
      await _settleRestore(tester);

      await tester.tap(find.text('右'));
      await tester.pump();
      expect(store.state?.feedingType, FeedingType.breastRight);

      now = DateTime(2026, 4, 11, 10, 1, 0);
      await tester.tap(find.text('停止して記録'));
      await tester.pump();
      await tester.pump();

      expect(repo.feedingType, FeedingType.breastRight);
      expect(repo.durationMin, 1);
    });

    testWidgets('経過 0 でも durationMin は最低 1 になる', (tester) async {
      final repo = _Repo();
      final store = _FakeStore();
      final now = DateTime(2026, 4, 11, 10, 0, 0);

      await tester.pumpWidget(
        _wrap(repo: repo, store: store, clock: () => now, onClose: () {}),
      );
      await _settleRestore(tester);

      await tester.tap(find.text('停止して記録'));
      await tester.pump();
      await tester.pump();

      expect(repo.durationMin, 1);
    });

    testWidgets('経過 180 分超でも durationMin は上限 180 にクランプされる', (tester) async {
      final repo = _Repo();
      final store = _FakeStore();
      var now = DateTime(2026, 4, 11, 10, 0, 0);

      await tester.pumpWidget(
        _wrap(repo: repo, store: store, clock: () => now, onClose: () {}),
      );
      await _settleRestore(tester);

      // 200 分経過 → DB CHECK (0..180) に合わせて 180 にクランプ。
      now = DateTime(2026, 4, 11, 13, 20, 0);
      await tester.tap(find.text('停止して記録'));
      await tester.pump();
      await tester.pump();

      expect(repo.durationMin, 180);
    });

    testWidgets('中断中の非 stale タイマーを復元する', (tester) async {
      final repo = _Repo();
      // 5 分前に開始した breast_right を保存しておく。
      final now = DateTime(2026, 4, 11, 10, 5, 0);
      final store = _FakeStore((
        startedAt: DateTime(2026, 4, 11, 10, 0, 0),
        feedingType: FeedingType.breastRight,
      ));

      await tester.pumpWidget(
        _wrap(
          repo: repo,
          store: store,
          clock: () => now,
          onClose: () {},
        ),
      );
      await _settleRestore(tester);

      // 復元されて 5 分経過表示、新規 save はしない。
      expect(find.text('05:00'), findsOneWidget);
      expect(store.saveCalls, 0);

      await tester.tap(find.text('停止して記録'));
      await tester.pump();
      await tester.pump();

      expect(repo.feedingType, FeedingType.breastRight);
      expect(repo.durationMin, 5);
    });

    testWidgets('stale (2h 超) な保存は破棄して新規開始する', (tester) async {
      final repo = _Repo();
      final now = DateTime(2026, 4, 11, 13, 0, 0);
      // 3 時間前 = stale。
      final store = _FakeStore((
        startedAt: DateTime(2026, 4, 11, 10, 0, 0),
        feedingType: FeedingType.breastRight,
      ));

      await tester.pumpWidget(
        _wrap(repo: repo, store: store, clock: () => now, onClose: () {}),
      );
      await _settleRestore(tester);

      // 新規開始 (00:00) + breast_left (initialType) で保存し直す。
      expect(find.text('00:00'), findsOneWidget);
      expect(store.clearCalls, greaterThanOrEqualTo(1));
      expect(store.saveCalls, greaterThanOrEqualTo(1));
      expect(store.state?.feedingType, FeedingType.breastLeft);
    });

    testWidgets('キャンセルは記録せず保存をクリアして閉じる', (tester) async {
      final repo = _Repo();
      final store = _FakeStore();
      final now = DateTime(2026, 4, 11, 10, 0, 0);
      var closed = false;

      await tester.pumpWidget(
        _wrap(
          repo: repo,
          store: store,
          clock: () => now,
          onClose: () => closed = true,
        ),
      );
      await _settleRestore(tester);

      await tester.tap(find.text('キャンセル（記録しない）'));
      await tester.pump();

      expect(repo.recordFeedingCalls, 0);
      expect(store.clearCalls, greaterThanOrEqualTo(1));
      expect(store.state, isNull);
      expect(closed, isTrue);
    });
  });

  // `showBabyFeedingTimer` の opener 経路: 停止/キャンセル以外 (スワイプ dismiss)
  // で閉じた (result == null) ときに保存を破棄する分岐を検証する。
  group('showBabyFeedingTimer', () {
    testWidgets('result なく閉じる (スワイプ相当) と保存をクリアする', (tester) async {
      final store = _FakeStore();
      late BuildContext ctx;
      late WidgetRef capturedRef;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            babyRepositoryProvider.overrideWithValue(_Repo()),
            feedingTimerStoreProvider.overrideWithValue(store),
            babyMutationContextProvider.overrideWith(
              (ref) async => (householdId: 'hh-1', userId: 'user-1'),
            ),
          ],
          child: MaterialApp(
            home: Consumer(
              builder: (context, ref, _) {
                ctx = context;
                capturedRef = ref;
                return const Scaffold(body: SizedBox());
              },
            ),
          ),
        ),
      );

      // タイマーを開く (await しない — modal は開いたまま)。
      unawaited(
        showBabyFeedingTimer(
          ctx,
          capturedRef,
          initialType: FeedingType.breastLeft,
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 10)); // restore → save

      expect(find.text('授乳タイマー'), findsOneWidget);
      expect(store.state, isNotNull); // 開いた時点で新規保存される

      // 停止/キャンセルを経ず route を pop (result == null = スワイプ dismiss 相当)。
      Navigator.of(ctx).pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 10)); // opener の clear()

      expect(store.state, isNull); // 破棄される
    });
  });
}
