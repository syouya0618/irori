import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/baby_repository.dart';
import 'package:irori/features/baby/data/feeding_timer_store.dart';
import 'package:irori/features/baby/data/wake_lock_service.dart';
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

/// 画面 WakeLock の fake。enable/disable の呼び出しと現在状態を記録する。
class _FakeWakeLock implements WakeLockService {
  bool enabled = false;
  int enableCalls = 0;
  int disableCalls = 0;

  /// true なら enable が失敗する (省電力モード等の取得失敗を模す)。
  bool throwOnEnable = false;

  /// 非 null なら enable はこの gate の完了を待つ (dispose 競合の再現用)。
  Completer<void>? enableGate;

  @override
  Future<void> enable() async {
    enableCalls++;
    if (throwOnEnable) throw StateError('wakelock unavailable');
    final gate = enableGate;
    if (gate != null) await gate.future;
    enabled = true;
  }

  @override
  Future<void> disable() async {
    disableCalls++;
    enabled = false;
  }
}

Widget _wrap({
  required _Repo repo,
  required _FakeStore store,
  required DateTime Function() clock,
  FeedingType initialType = FeedingType.breastLeft,
  VoidCallback? onClose,
  _FakeWakeLock? wakeLock,
}) {
  return ProviderScope(
    overrides: [
      babyRepositoryProvider.overrideWithValue(repo),
      feedingTimerStoreProvider.overrideWithValue(store),
      wakeLockServiceProvider.overrideWithValue(wakeLock ?? _FakeWakeLock()),
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

  // #77: タイマー動作中の画面 WakeLock (原典 `useWakeLock(open && !!startedAt)`)。
  group('BabyFeedingTimerSheet WakeLock', () {
    testWidgets('新規開始で WakeLock を enable する', (tester) async {
      final wakeLock = _FakeWakeLock();
      final now = DateTime(2026, 4, 11, 10, 0, 0);

      await tester.pumpWidget(
        _wrap(
          repo: _Repo(),
          store: _FakeStore(),
          clock: () => now,
          wakeLock: wakeLock,
        ),
      );
      await _settleRestore(tester);

      expect(wakeLock.enableCalls, 1);
      expect(wakeLock.enabled, isTrue);
    });

    testWidgets('復元経路でも WakeLock を enable する', (tester) async {
      final wakeLock = _FakeWakeLock();
      final now = DateTime(2026, 4, 11, 10, 5, 0);
      // 5 分前開始の非 stale 保存 → 復元経路。
      final store = _FakeStore((
        startedAt: DateTime(2026, 4, 11, 10, 0, 0),
        feedingType: FeedingType.breastRight,
      ));

      await tester.pumpWidget(
        _wrap(
          repo: _Repo(),
          store: store,
          clock: () => now,
          wakeLock: wakeLock,
        ),
      );
      await _settleRestore(tester);

      expect(find.text('05:00'), findsOneWidget); // 復元経路であることの確認
      expect(wakeLock.enableCalls, 1);
      expect(wakeLock.enabled, isTrue);
    });

    testWidgets('停止 (記録) で WakeLock を disable する', (tester) async {
      final wakeLock = _FakeWakeLock();
      var now = DateTime(2026, 4, 11, 10, 0, 0);

      await tester.pumpWidget(
        _wrap(
          repo: _Repo(),
          store: _FakeStore(),
          clock: () => now,
          onClose: () {},
          wakeLock: wakeLock,
        ),
      );
      await _settleRestore(tester);
      expect(wakeLock.enabled, isTrue);

      now = DateTime(2026, 4, 11, 10, 3, 0);
      await tester.tap(find.text('停止して記録'));
      await tester.pump();
      await tester.pump();

      expect(wakeLock.disableCalls, greaterThanOrEqualTo(1));
      expect(wakeLock.enabled, isFalse);
    });

    testWidgets('キャンセルで WakeLock を disable する', (tester) async {
      final wakeLock = _FakeWakeLock();
      final now = DateTime(2026, 4, 11, 10, 0, 0);

      await tester.pumpWidget(
        _wrap(
          repo: _Repo(),
          store: _FakeStore(),
          clock: () => now,
          onClose: () {},
          wakeLock: wakeLock,
        ),
      );
      await _settleRestore(tester);
      expect(wakeLock.enabled, isTrue);

      await tester.tap(find.text('キャンセル（記録しない）'));
      await tester.pump();

      expect(wakeLock.disableCalls, greaterThanOrEqualTo(1));
      expect(wakeLock.enabled, isFalse);
    });

    testWidgets('シート破棄 (dispose) で WakeLock を disable する', (tester) async {
      final wakeLock = _FakeWakeLock();
      final now = DateTime(2026, 4, 11, 10, 0, 0);

      await tester.pumpWidget(
        _wrap(
          repo: _Repo(),
          store: _FakeStore(),
          clock: () => now,
          wakeLock: wakeLock,
        ),
      );
      await _settleRestore(tester);
      expect(wakeLock.enabled, isTrue);

      // スワイプ dismiss 相当: 停止/キャンセルを経ず widget を破棄する。
      await tester.pumpWidget(const SizedBox());
      await tester.pump();

      expect(wakeLock.disableCalls, greaterThanOrEqualTo(1));
      expect(wakeLock.enabled, isFalse);
    });

    testWidgets('enable 失敗でもタイマーは継続し記録できる (best-effort)', (
      tester,
    ) async {
      final wakeLock = _FakeWakeLock()..throwOnEnable = true;
      final repo = _Repo();
      var now = DateTime(2026, 4, 11, 10, 0, 0);
      var closed = false;

      await tester.pumpWidget(
        _wrap(
          repo: repo,
          store: _FakeStore(),
          clock: () => now,
          onClose: () => closed = true,
          wakeLock: wakeLock,
        ),
      );
      await _settleRestore(tester);

      // WakeLock は取れないがタイマーは動く。
      expect(wakeLock.enabled, isFalse);
      now = DateTime(2026, 4, 11, 10, 2, 0);
      await tester.pump(const Duration(seconds: 1));
      expect(find.text('02:00'), findsOneWidget);

      await tester.tap(find.text('停止して記録'));
      await tester.pump();
      await tester.pump();

      expect(repo.recordFeedingCalls, 1);
      expect(repo.durationMin, 2);
      expect(closed, isTrue);
    });

    testWidgets('enable 完了前に破棄されたら完了後に即 disable する (リーク防止)', (
      tester,
    ) async {
      final gate = Completer<void>();
      final wakeLock = _FakeWakeLock()..enableGate = gate;
      final now = DateTime(2026, 4, 11, 10, 0, 0);

      await tester.pumpWidget(
        _wrap(
          repo: _Repo(),
          store: _FakeStore(),
          clock: () => now,
          wakeLock: wakeLock,
        ),
      );
      await _settleRestore(tester);
      expect(wakeLock.enableCalls, 1);
      expect(wakeLock.enabled, isFalse); // gate 待ちで未取得

      // enable 未完のまま破棄 → その後 enable が完了しても点灯ロックを残さない
      // (原典 `cancelled` フラグ相当)。
      await tester.pumpWidget(const SizedBox());
      gate.complete();
      await tester.pump();

      expect(wakeLock.enabled, isFalse);
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
            wakeLockServiceProvider.overrideWithValue(_FakeWakeLock()),
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
