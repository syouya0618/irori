import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/stock/data/stock_items_notifier.dart';
import 'package:irori/features/stock/data/stock_repository.dart';
import 'package:irori/features/stock/domain/stock_item.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// `StockRepository` のフェイク (`_FakeBabyRepository` と同じ流儀)。
class _FakeStockRepository extends Fake implements StockRepository {
  _FakeStockRepository({this.items = const [], this.error, this.fetchGate});

  final List<StockItem> items;
  final Object? error;

  /// 非 null なら `fetchItems` がこの future を await してから返す。
  /// 「subscribe 済みだが fetch 未完」= `_initialized==false` の初期化中
  /// window をテストから作り、realtime バッファリングを検証するためのゲート。
  final Future<void>? fetchGate;

  @override
  Future<List<StockItem>> fetchItems(String householdId) async {
    if (fetchGate != null) await fetchGate;
    if (error != null) throw error!;
    return items;
  }
}

StockItem _item(
  String id, {
  String name = '何か',
  ItemCategory category = ItemCategory.otherFood,
  int quantity = 1,
}) {
  return StockItem(
    id: id,
    householdId: 'hh-1',
    name: name,
    category: category,
    quantity: quantity,
    createdBy: 'user-1',
    createdAt: DateTime.utc(2026, 6, 8),
  );
}

/// realtime INSERT/UPDATE payload を構築する (seam テスト用)。
/// `newRecord` は `StockItem.toJson()` の snake_case 行 (fromJson が受ける形)。
PostgresChangePayload _payload(PostgresChangeEvent event, StockItem item) =>
    PostgresChangePayload(
      schema: 'public',
      table: 'stock_items',
      commitTimestamp: DateTime.utc(2026, 6, 8),
      eventType: event,
      newRecord: item.toJson(),
      oldRecord: const {},
      errors: null,
    );

/// realtime DELETE payload を構築する (oldRecord に PK のみ)。
PostgresChangePayload _deletePayload(String id) => PostgresChangePayload(
  schema: 'public',
  table: 'stock_items',
  commitTimestamp: DateTime.utc(2026, 6, 8),
  eventType: PostgresChangeEvent.delete,
  newRecord: const {},
  oldRecord: {'id': id},
  errors: null,
);

/// テスト用の `ProviderContainer` を構築する
/// (`baby_logs_notifier_test.dart` の `_makeContainer` と同じ流儀:
/// `SupabaseClient(...)` 直構築は `Supabase.initialize()` 不要で、
/// `subscribe()` は接続を queue するだけでテスト本体内では throw しない)。
ProviderContainer _makeContainer({
  required _FakeStockRepository repo,
  required String? householdId,
}) {
  return ProviderContainer(
    overrides: [
      supabaseClientProvider.overrideWithValue(
        SupabaseClient('http://localhost:54321', 'test-anon-key'),
      ),
      currentHouseholdIdProvider.overrideWith((ref) async => householdId),
      stockRepositoryProvider.overrideWithValue(repo),
    ],
  );
}

void main() {
  group('StockItemsNotifier AsyncValue 状態遷移', () {
    test('初回 read は AsyncLoading を返す', () {
      final container = _makeContainer(
        repo: _FakeStockRepository(items: [_item('a')]),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      final state = container.read(stockItemsNotifierProvider);
      expect(state, isA<AsyncLoading<List<StockItem>>>());
    });

    test('fetch 成功で AsyncData に在庫一覧が入る (name 昇順の fetch 順を保つ)', () async {
      final items = [_item('a', name: 'にんじん'), _item('b', name: '牛乳')];
      final container = _makeContainer(
        repo: _FakeStockRepository(items: items),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      final result = await container.read(stockItemsNotifierProvider.future);
      expect(result.map((i) => i.id), ['a', 'b']);

      final state = container.read(stockItemsNotifierProvider);
      expect(state, isA<AsyncData<List<StockItem>>>());
      expect(state.value, isNotNull);
      expect(state.value!.length, 2);
    });

    test('household_id が null (世帯未参加) なら空リストを返す', () async {
      final container = _makeContainer(
        repo: _FakeStockRepository(items: [_item('a')]),
        householdId: null,
      );
      addTearDown(container.dispose);

      final result = await container.read(stockItemsNotifierProvider.future);
      expect(result, isEmpty);
      expect(
        container.read(stockItemsNotifierProvider),
        isA<AsyncData<List<StockItem>>>(),
      );
    });

    test('fetch が PostgrestException を投げると AsyncError になる', () async {
      final container = _makeContainer(
        repo: _FakeStockRepository(
          error: const PostgrestException(message: 'boom', code: '500'),
        ),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      // `.future` は build() throw 時に pending のまま残る場合があるため
      // state 経由で検証する (baby_logs_notifier_test と同じ理由)。
      container.listen(
        stockItemsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );

      expect(container.read(stockItemsNotifierProvider).isLoading, isTrue);

      for (
        var i = 0;
        i < 50 && container.read(stockItemsNotifierProvider).isLoading;
        i++
      ) {
        await Future<void>.delayed(const Duration(milliseconds: 1));
      }

      final state = container.read(stockItemsNotifierProvider);
      expect(state.hasError, isTrue, reason: 'fetch 失敗で AsyncError になるはず');
      expect(state.error, isA<PostgrestException>());
    });

    test('channel topic は stock_items:householdId で一意化される', () async {
      final container = _makeContainer(
        repo: _FakeStockRepository(),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      await container.read(stockItemsNotifierProvider.future);
      final notifier = container.read(stockItemsNotifierProvider.notifier);
      expect(notifier.debugChannelTopic, 'stock_items:hh-1');
    });
  });

  group(
    'StockItemsNotifier reducer (web stock-list.tsx インライン reducer の移植)',
    () {
      // web __tests__/stock-list.test.tsx 検証ケース 1:
      // 「INSERT 重複防止: 同一 id を 2 度 emit しても 1 件のまま」
      test('INSERT: 既存 id は重複追加されない (dedup)', () {
        final current = [_item('stock-1', name: '玉ねぎ')];
        final result = StockItemsNotifier.reduceForTest(
          current,
          PostgresChangeEvent.insert,
          item: _item('stock-1', name: '玉ねぎ'),
        );
        expect(result.length, 1);
        expect(result.map((i) => i.id), ['stock-1']);
      });

      test('INSERT: 新規 id は末尾に追加される (web: [...prev, newItem])', () {
        // baby の sorted insert と異なり、web の在庫 reducer は単純 append。
        final current = [_item('a', name: 'にんじん'), _item('b', name: '牛乳')];
        final result = StockItemsNotifier.reduceForTest(
          current,
          PostgresChangeEvent.insert,
          item: _item('c', name: '玉ねぎ'),
        );
        expect(result.map((i) => i.id), ['a', 'b', 'c']);
      });

      // web 検証ケース 2: 「UPDATE で既存 item の name が payload.new に置換される」
      test('UPDATE: 同一 id の行が置換される (並び位置は維持)', () {
        final current = [_item('stock-1', name: '玉ねぎ'), _item('stock-2')];
        final result = StockItemsNotifier.reduceForTest(
          current,
          PostgresChangeEvent.update,
          item: _item('stock-1', name: '人参', quantity: 5),
        );
        expect(result.length, 2);
        expect(result.first.id, 'stock-1');
        expect(result.first.name, '人参');
        expect(result.first.quantity, 5);
        expect(result[1].id, 'stock-2');
      });

      test('UPDATE: 不在 id は noop (web の map と同一 — 追加しない)', () {
        // baby の「belongs && !exists → 追加」遷移とは意図的に異なる
        // (web stock-list の reducer に挿入分岐は無い)。
        final current = [_item('a'), _item('b')];
        final result = StockItemsNotifier.reduceForTest(
          current,
          PostgresChangeEvent.update,
          item: _item('z', name: '新顔'),
        );
        expect(result.map((i) => i.id), ['a', 'b']);
      });

      // web 検証ケース 3: 「DELETE で件数 -1」
      test('DELETE: 指定 id を除外する', () {
        final current = [
          _item('stock-1', name: '玉ねぎ'),
          _item('stock-2', name: '人参'),
        ];
        final result = StockItemsNotifier.reduceForTest(
          current,
          PostgresChangeEvent.delete,
          deletedId: 'stock-1',
        );
        expect(result.map((i) => i.id), ['stock-2']);
      });

      test('DELETE: 不在 id は noop', () {
        final current = [_item('a'), _item('b')];
        final result = StockItemsNotifier.reduceForTest(
          current,
          PostgresChangeEvent.delete,
          deletedId: 'z',
        );
        expect(result.map((i) => i.id), ['a', 'b']);
      });
    },
  );

  group('StockItemsNotifier realtime バッファ & live 経路', () {
    test('初期化中に届いた INSERT はバッファされ fetch 後に drain される (取りこぼしゼロ)', () async {
      final gate = Completer<void>();
      final container = _makeContainer(
        repo: _FakeStockRepository(
          items: [_item('base', name: '牛乳')],
          fetchGate: gate.future,
        ),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      container.listen(
        stockItemsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(stockItemsNotifierProvider.notifier);

      // build が fetch await (gate) に到達するまで進める。
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(notifier.debugInitialized, isFalse, reason: 'fetch 未完なので未初期化');

      // 初期化中に realtime INSERT 到着 → 破棄されずバッファに溜まる。
      notifier.debugHandlePayload(
        _payload(PostgresChangeEvent.insert, _item('rt1', name: '卵')),
      );
      expect(notifier.debugPendingCount, 1);

      // fetch 完了 → build() が drain。
      gate.complete();
      await container.read(stockItemsNotifierProvider.future);

      expect(notifier.debugInitialized, isTrue);
      expect(notifier.debugPendingCount, 0, reason: 'drain 後バッファは空');
      final state = container.read(stockItemsNotifierProvider);
      // rt1 (初期化中 event) が取りこぼされず base の後ろに append される。
      expect(state.value!.map((i) => i.id), ['base', 'rt1']);
    });

    test('build 完了後の live INSERT は即 state に反映される (末尾 append)', () async {
      final container = _makeContainer(
        repo: _FakeStockRepository(items: [_item('base')]),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      container.listen(
        stockItemsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(stockItemsNotifierProvider.notifier);
      await container.read(stockItemsNotifierProvider.future);
      expect(notifier.debugInitialized, isTrue);

      notifier.debugHandlePayload(
        _payload(PostgresChangeEvent.insert, _item('rt2', name: '玉ねぎ')),
      );
      final state = container.read(stockItemsNotifierProvider);
      expect(state.value!.map((i) => i.id), ['base', 'rt2']);
    });

    test('build 完了後の live UPDATE は該当行を置換する', () async {
      final container = _makeContainer(
        repo: _FakeStockRepository(items: [_item('a', name: '玉ねぎ')]),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      container.listen(
        stockItemsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(stockItemsNotifierProvider.notifier);
      await container.read(stockItemsNotifierProvider.future);

      notifier.debugHandlePayload(
        _payload(PostgresChangeEvent.update, _item('a', name: '人参')),
      );
      final state = container.read(stockItemsNotifierProvider);
      expect(state.value!.single.name, '人参');
    });

    test('build 完了後の live DELETE は state から除外される', () async {
      final container = _makeContainer(
        repo: _FakeStockRepository(items: [_item('a'), _item('b')]),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      container.listen(
        stockItemsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(stockItemsNotifierProvider.notifier);
      await container.read(stockItemsNotifierProvider.future);

      notifier.debugHandlePayload(_deletePayload('a'));
      final state = container.read(stockItemsNotifierProvider);
      expect(state.value!.map((i) => i.id), ['b']);
    });
  });
}
