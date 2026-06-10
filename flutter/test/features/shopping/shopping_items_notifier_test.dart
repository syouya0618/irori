import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/domain/store_type.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/shopping/data/shopping_items_notifier.dart';
import 'package:irori/features/shopping/data/shopping_repository.dart';
import 'package:irori/features/shopping/domain/shopping_item.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// `ShoppingRepository` のフェイク。`Fake` で constructor (SupabaseClient
/// 要求) を回避し、`fetchItems` のみテストから制御する
/// (baby `_FakeBabyRepository` と同じ流儀)。
class _FakeShoppingRepository extends Fake implements ShoppingRepository {
  _FakeShoppingRepository({this.items = const [], this.error, this.fetchGate});

  final List<ShoppingItem> items;
  final Object? error;

  /// 非 null なら `fetchItems` がこの future を await してから返す。
  /// 「subscribe 済みだが fetch 未完」= `_initialized==false` の初期化中
  /// window をテストから作り、realtime バッファリングを検証するためのゲート。
  final Future<void>? fetchGate;

  int fetchCount = 0;
  final fetchCalls = <String>[];

  @override
  Future<List<ShoppingItem>> fetchItems(String householdId) async {
    fetchCount++;
    fetchCalls.add(householdId);
    if (fetchGate != null) await fetchGate;
    if (error != null) throw error!;
    return items;
  }
}

ShoppingItem _item(
  String id, {
  String name = 'アイテム',
  bool isChecked = false,
  int sortOrder = 1,
}) => ShoppingItem(
  id: id,
  householdId: 'hh-1',
  name: name,
  category: ItemCategory.otherFood,
  storeType: StoreType.supermarket,
  isChecked: isChecked,
  sortOrder: sortOrder,
  createdBy: 'user-1',
  createdAt: DateTime.utc(2026, 6, 8, 9),
);

/// realtime INSERT/UPDATE payload を構築する。
/// `newRecord` は `ShoppingItem.toJson()` の snake_case フル行
/// (実際の Realtime payload と同じ形 — fromJson が受ける形)。
PostgresChangePayload _changePayload(
  PostgresChangeEvent event,
  ShoppingItem item,
) => PostgresChangePayload(
  schema: 'public',
  table: 'shopping_items',
  commitTimestamp: DateTime.utc(2026, 6, 8),
  eventType: event,
  newRecord: item.toJson(),
  oldRecord: const {},
  errors: null,
);

/// realtime DELETE payload を構築する (oldRecord に PK のみ)。
PostgresChangePayload _deletePayload(String id) => PostgresChangePayload(
  schema: 'public',
  table: 'shopping_items',
  commitTimestamp: DateTime.utc(2026, 6, 8),
  eventType: PostgresChangeEvent.delete,
  newRecord: const {},
  oldRecord: {'id': id},
  errors: null,
);

ProviderContainer _makeContainer({
  required _FakeShoppingRepository repo,
  required String? householdId,
  SupabaseClient? client,
}) {
  return ProviderContainer(
    overrides: [
      supabaseClientProvider.overrideWithValue(
        client ?? SupabaseClient('http://localhost:54321', 'test-anon-key'),
      ),
      currentHouseholdIdProvider.overrideWith((ref) async => householdId),
      shoppingRepositoryProvider.overrideWithValue(repo),
    ],
  );
}

/// `.future` を await せず、state が条件を満たすまで event loop を bounded に
/// 回して待つ (baby/meals テストと同じ流儀 — build() throw 時に `.future` が
/// pending のまま残る既知の挙動を踏まないため)。
Future<void> _pumpUntil(bool Function() done) async {
  for (var i = 0; i < 50 && !done(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
}

void main() {
  group('ShoppingItemsNotifier AsyncValue 状態遷移', () {
    test('初回 read は AsyncLoading を返す', () {
      final container = _makeContainer(
        repo: _FakeShoppingRepository(items: [_item('a')]),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      final state = container.read(shoppingItemsNotifierProvider);
      expect(state, isA<AsyncLoading<List<ShoppingItem>>>());
    });

    test('fetch 成功で AsyncData に世帯のアイテムが入る', () async {
      final repo = _FakeShoppingRepository(
        items: [_item('a'), _item('b', sortOrder: 2)],
      );
      final container = _makeContainer(repo: repo, householdId: 'hh-1');
      addTearDown(container.dispose);

      final result = await container.read(
        shoppingItemsNotifierProvider.future,
      );
      expect(result.map((i) => i.id), ['a', 'b']);
      expect(repo.fetchCalls, ['hh-1']);

      final state = container.read(shoppingItemsNotifierProvider);
      expect(state, isA<AsyncData<List<ShoppingItem>>>());
    });

    test('household_id が null (世帯未参加) なら空リストを返し fetch しない', () async {
      final repo = _FakeShoppingRepository(items: [_item('a')]);
      final container = _makeContainer(repo: repo, householdId: null);
      addTearDown(container.dispose);

      final result = await container.read(
        shoppingItemsNotifierProvider.future,
      );
      expect(result, isEmpty);
      expect(repo.fetchCount, 0);
    });

    test('fetch が PostgrestException を投げると AsyncError になる', () async {
      final container = _makeContainer(
        repo: _FakeShoppingRepository(
          error: const PostgrestException(message: 'boom', code: '500'),
        ),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      container.listen(
        shoppingItemsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      expect(container.read(shoppingItemsNotifierProvider).isLoading, isTrue);

      await _pumpUntil(
        () => !container.read(shoppingItemsNotifierProvider).isLoading,
      );

      final state = container.read(shoppingItemsNotifierProvider);
      expect(state.hasError, isTrue, reason: 'fetch 失敗で AsyncError になるはず');
      expect(state.error, isA<PostgrestException>());
    });
  });

  group('ShoppingItemsNotifier reducer (web shopping-list.tsx と同一セマンティクス)', () {
    test('INSERT: 新規 id は末尾に追加される (web: [...prev, newItem])', () {
      final current = [_item('a'), _item('b', sortOrder: 2)];
      final result = ShoppingItemsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.insert,
        item: _item('c', sortOrder: 3),
      );
      // baby の sorted insert と異なり、web 同様 append (並びの最終確定は
      // UI 層の sort_order ソート — F4)。
      expect(result.map((i) => i.id), ['a', 'b', 'c']);
    });

    test('INSERT: 既存 id は重複追加されない (楽観更新との dedup)', () {
      final current = [_item('a'), _item('b')];
      final result = ShoppingItemsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.insert,
        item: _item('a', name: '別内容'),
      );
      expect(result.length, 2);
      expect(result.map((i) => i.id), ['a', 'b']);
      // dedup 時は既存要素を保持する (web: prev をそのまま返す)。
      expect(result.first.name, 'アイテム');
    });

    test('UPDATE: 同一 id が置換される (位置は維持)', () {
      final current = [_item('a'), _item('b', name: '旧'), _item('c')];
      final result = ShoppingItemsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.update,
        item: _item('b', name: '新', isChecked: true),
      );
      expect(result.map((i) => i.id), ['a', 'b', 'c']);
      expect(result[1].name, '新');
      expect(result[1].isChecked, isTrue);
    });

    test('UPDATE: 未存在 id は追加されない (web の map は要素を増やさない)', () {
      final current = [_item('a'), _item('b')];
      final result = ShoppingItemsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.update,
        item: _item('z'),
      );
      expect(result.map((i) => i.id), ['a', 'b']);
    });

    test('DELETE: 指定 id を除外する', () {
      final current = [_item('a'), _item('b'), _item('c')];
      final result = ShoppingItemsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.delete,
        deletedId: 'b',
      );
      expect(result.map((i) => i.id), ['a', 'c']);
    });

    test('DELETE: 未存在 id は noop', () {
      final current = [_item('a'), _item('b')];
      final result = ShoppingItemsNotifier.reduceForTest(
        current,
        PostgresChangeEvent.delete,
        deletedId: 'z',
      );
      expect(result.map((i) => i.id), ['a', 'b']);
    });
  });

  group('ShoppingItemsNotifier realtime バッファ & live 経路', () {
    test('初期化中に届いた INSERT はバッファされ fetch 後に drain される '
        '(取りこぼしゼロ)', () async {
      final gate = Completer<void>();
      final container = _makeContainer(
        repo: _FakeShoppingRepository(
          items: [_item('base')],
          fetchGate: gate.future,
        ),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      container.listen(
        shoppingItemsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(shoppingItemsNotifierProvider.notifier);

      // build が fetch await (gate) に到達するまで進める。
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(notifier.debugInitialized, isFalse, reason: 'fetch 未完なので未初期化');

      // 初期化中に realtime INSERT 到着 → 破棄されずバッファに溜まる。
      notifier.debugHandlePayload(
        _changePayload(PostgresChangeEvent.insert, _item('rt1', sortOrder: 2)),
      );
      expect(notifier.debugPendingCount, 1);

      // fetch 完了 → build() が drain。
      gate.complete();
      await container.read(shoppingItemsNotifierProvider.future);

      expect(notifier.debugInitialized, isTrue);
      expect(notifier.debugPendingCount, 0, reason: 'drain 後バッファは空');
      final state = container.read(shoppingItemsNotifierProvider);
      // rt1 (初期化中 event) が取りこぼされず base の後ろに追加される。
      expect(state.value!.map((i) => i.id), ['base', 'rt1']);
    });

    test('初期化中バッファの drain でも dedup が効く (fetch 結果と重複しない)', () async {
      final gate = Completer<void>();
      final container = _makeContainer(
        repo: _FakeShoppingRepository(
          items: [_item('base'), _item('dup')],
          fetchGate: gate.future,
        ),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      container.listen(
        shoppingItemsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(shoppingItemsNotifierProvider.notifier);
      await Future<void>.delayed(const Duration(milliseconds: 5));

      // fetch 結果にも含まれる行の INSERT payload が初期化中に届くケース
      // (subscribe→fetch window で INSERT された行は両経路から来る)。
      notifier.debugHandlePayload(
        _changePayload(PostgresChangeEvent.insert, _item('dup')),
      );

      gate.complete();
      await container.read(shoppingItemsNotifierProvider.future);

      final state = container.read(shoppingItemsNotifierProvider);
      expect(state.value!.map((i) => i.id), ['base', 'dup']);
    });

    test('build 完了後の live INSERT は即 state に反映される', () async {
      final container = _makeContainer(
        repo: _FakeShoppingRepository(items: [_item('base')]),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      container.listen(
        shoppingItemsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(shoppingItemsNotifierProvider.notifier);
      await container.read(shoppingItemsNotifierProvider.future);
      expect(notifier.debugInitialized, isTrue);

      notifier.debugHandlePayload(
        _changePayload(PostgresChangeEvent.insert, _item('rt2', sortOrder: 2)),
      );
      final state = container.read(shoppingItemsNotifierProvider);
      expect(state.value!.map((i) => i.id), ['base', 'rt2']);
    });

    test('build 完了後の live UPDATE (パートナーのチェック) が置換反映される', () async {
      final container = _makeContainer(
        repo: _FakeShoppingRepository(items: [_item('a'), _item('b')]),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      container.listen(
        shoppingItemsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(shoppingItemsNotifierProvider.notifier);
      await container.read(shoppingItemsNotifierProvider.future);

      notifier.debugHandlePayload(
        _changePayload(
          PostgresChangeEvent.update,
          _item('a', isChecked: true),
        ),
      );
      final state = container.read(shoppingItemsNotifierProvider);
      expect(state.value!.map((i) => i.id), ['a', 'b']);
      expect(state.value!.first.isChecked, isTrue);
    });

    test('build 完了後の live DELETE は state から除外される', () async {
      final container = _makeContainer(
        repo: _FakeShoppingRepository(items: [_item('a'), _item('b')]),
        householdId: 'hh-1',
      );
      addTearDown(container.dispose);

      container.listen(
        shoppingItemsNotifierProvider,
        (_, _) {},
        fireImmediately: true,
      );
      final notifier = container.read(shoppingItemsNotifierProvider.notifier);
      await container.read(shoppingItemsNotifierProvider.future);

      notifier.debugHandlePayload(_deletePayload('a'));
      final state = container.read(shoppingItemsNotifierProvider);
      expect(state.value!.map((i) => i.id), ['b']);
    });
  });

  group('ShoppingItemsNotifier channel ライフサイクル', () {
    test(
      'topic は shopping_items:householdId で、dispose で removeChannel される',
      () async {
        final client = SupabaseClient(
          'http://localhost:54321',
          'test-anon-key',
        );
        final repo = _FakeShoppingRepository(items: [_item('a')]);
        final container = _makeContainer(
          repo: repo,
          householdId: 'hh-1',
          client: client,
        );

        container.listen(
          shoppingItemsNotifierProvider,
          (_, _) {},
          fireImmediately: true,
        );
        final notifier = container.read(shoppingItemsNotifierProvider.notifier);
        await container.read(shoppingItemsNotifierProvider.future);

        expect(client.getChannels(), hasLength(1));
        // `RealtimeChannel.topic` は @internal のため notifier の seam で検証。
        expect(notifier.debugChannelTopic, 'shopping_items:hh-1');

        container.dispose();
        await _pumpUntil(() => client.getChannels().isEmpty);
        expect(
          client.getChannels(),
          isEmpty,
          reason: 'leak 防止 (ref.onDispose)',
        );
      },
    );

    test('世帯未参加 (householdId null) なら subscribe しない', () async {
      final client = SupabaseClient('http://localhost:54321', 'test-anon-key');
      final container = _makeContainer(
        repo: _FakeShoppingRepository(),
        householdId: null,
        client: client,
      );
      addTearDown(container.dispose);

      await container.read(shoppingItemsNotifierProvider.future);
      expect(client.getChannels(), isEmpty);
    });
  });
}
