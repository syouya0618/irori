import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/stock/data/low_stock_check_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 低在庫自動追加の 30 分スロットル (PR-G)。
///
/// web 原典 `stock-list.tsx:117-133` の sessionStorage
/// `stock_low_checked_at` + `THIRTY_MIN` 相当。Flutter 版は
/// `SharedPreferences` 永続のためセッション単位 → アプリ単位に広がる
/// (意図的差異 — store の doc 参照)。

/// in-memory fake store (runner の単体テスト用)。
class _MemoryStore implements LowStockCheckStore {
  DateTime? value;
  int saveCount = 0;

  @override
  Future<DateTime?> loadLastCheckedAt() async => value;

  @override
  Future<void> saveLastCheckedAt(DateTime newValue) async {
    value = newValue;
    saveCount++;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('SharedPreferencesLowStockCheckStore', () {
    const store = SharedPreferencesLowStockCheckStore();

    test('save→load が同一 instant を往復する', () async {
      SharedPreferences.setMockInitialValues({});
      final at = DateTime.parse('2026-06-10T12:00:00+09:00');

      await store.saveLastCheckedAt(at);
      final loaded = await store.loadLastCheckedAt();

      expect(loaded, isNotNull);
      expect(loaded!.isAtSameMomentAs(at), isTrue);
    });

    test('保存キーは web sessionStorage と同一の stock_low_checked_at', () async {
      SharedPreferences.setMockInitialValues({});

      await store.saveLastCheckedAt(DateTime.utc(2026, 6, 10));

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getInt('stock_low_checked_at'), isNotNull);
    });

    test('未保存なら null を返す', () async {
      SharedPreferences.setMockInitialValues({});

      expect(await store.loadLastCheckedAt(), isNull);
    });
  });

  group('LowStockAutoAddRunner.runIfDue', () {
    final now = DateTime.parse('2026-06-10T12:00:00+09:00');
    const added = (error: null, addedItems: ['おむつ']);

    test('前回記録なしなら実行し、成功時にタイムスタンプを記録する', () async {
      final store = _MemoryStore();
      var checkCount = 0;
      final runner = LowStockAutoAddRunner(
        store: store,
        runCheck: () async {
          checkCount++;
          return added;
        },
        now: () => now,
      );

      final result = await runner.runIfDue();

      expect(checkCount, 1);
      expect(result, isNotNull);
      expect(result!.error, isNull);
      expect(result.addedItems, ['おむつ']);
      expect(store.value, isNotNull);
      expect(store.value!.isAtSameMomentAs(now), isTrue);
    });

    test('前回から 30 分未満なら skip し runCheck を呼ばない', () async {
      final store = _MemoryStore()
        ..value = now.subtract(const Duration(minutes: 29, seconds: 59));
      var checkCount = 0;
      final runner = LowStockAutoAddRunner(
        store: store,
        runCheck: () async {
          checkCount++;
          return added;
        },
        now: () => now,
      );

      final result = await runner.runIfDue();

      expect(checkCount, 0);
      expect(result, isNull);
      expect(store.saveCount, 0);
    });

    test('前回からちょうど 30 分なら実行する (web: now - last < 30min が偽)', () async {
      final store = _MemoryStore()
        ..value = now.subtract(const Duration(minutes: 30));
      var checkCount = 0;
      final runner = LowStockAutoAddRunner(
        store: store,
        runCheck: () async {
          checkCount++;
          return added;
        },
        now: () => now,
      );

      await runner.runIfDue();

      expect(checkCount, 1);
    });

    test('result.error 非 null ならタイムスタンプを記録しない (次回再試行)', () async {
      // web stock-list.tsx:124-125: `if (result.error) return` —
      // sessionStorage.setItem に到達しない。
      final store = _MemoryStore();
      final runner = LowStockAutoAddRunner(
        store: store,
        runCheck: () async => (
          error: '買い物リストへの追加に失敗しました',
          addedItems: const <String>[],
        ),
        now: () => now,
      );

      final result = await runner.runIfDue();

      expect(result, isNotNull);
      expect(result!.error, isNotNull);
      expect(store.saveCount, 0);
    });

    test('error: null + addedItems 空 (低在庫なし等) でも成功として記録する', () async {
      // web parity: read 失敗 (error: null) や低在庫 0 件でも
      // sessionStorage.setItem は実行される (stock-list.tsx:126)。
      final store = _MemoryStore();
      final runner = LowStockAutoAddRunner(
        store: store,
        runCheck: () async => (error: null, addedItems: const <String>[]),
        now: () => now,
      );

      await runner.runIfDue();

      expect(store.saveCount, 1);
    });
  });
}
