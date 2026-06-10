import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/domain/store_type.dart';
import 'package:irori/features/shopping/data/shopping_repository.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

/// `shopping_items.Row` (database.ts) と 1:1 の全 13 列 select 文字列
/// (リポジトリ実装と独立にテスト側でも正を持ち、改変を検出する)。
const _kExpectedItemColumns =
    'id, household_id, name, quantity, category, store_type, is_checked, '
    'checked_by, checked_at, meal_id, sort_order, created_by, created_at';

/// shopping_items / purchase_history の 2 テーブル fake 一式。
({
  ShoppingRepository repo,
  FakeSupabaseClient client,
  FakeQueryBuilder items,
  FakeFilterBuilder itemsRead,
  FakeFilterBuilder itemsMutation,
  FakeQueryBuilder history,
  FakeFilterBuilder historyMutation,
})
_repo({
  PostgrestList itemsRows = const [],
  Object? itemsReadError,
  PostgrestMap? itemsMaybeSingleValue,
  Object? itemsMaybeSingleError,
  PostgrestMap? itemsSingleValue,
  Object? itemsSingleError,
  Object? historyInsertError,
}) {
  final itemsRead = FakeFilterBuilder(
    cannedValue: itemsRows,
    cannedError: itemsReadError,
    maybeSingleValue: itemsMaybeSingleValue,
    maybeSingleError: itemsMaybeSingleError,
  );
  final itemsMutation = FakeFilterBuilder(
    cannedValue: const [],
    singleValue: itemsSingleValue,
    singleError: itemsSingleError,
  );
  final items = FakeQueryBuilder(itemsRead, mutationFilter: itemsMutation);

  final historyMutation = FakeFilterBuilder(
    cannedValue: const [],
    cannedError: historyInsertError,
  );
  final history = FakeQueryBuilder(
    FakeFilterBuilder(cannedValue: const []),
    mutationFilter: historyMutation,
  );

  final client = FakeSupabaseClient(
    fromBuilders: {'shopping_items': items, 'purchase_history': history},
  );
  return (
    repo: ShoppingRepository(client),
    client: client,
    items: items,
    itemsRead: itemsRead,
    itemsMutation: itemsMutation,
    history: history,
    historyMutation: historyMutation,
  );
}

/// fetch 系が返す生 row (全 13 列)。
PostgrestMap _row(String id, {int sortOrder = 1}) => {
  'id': id,
  'household_id': 'hh-1',
  'name': '牛乳',
  'quantity': null,
  'category': 'dairy',
  'store_type': 'supermarket',
  'is_checked': false,
  'checked_by': null,
  'checked_at': null,
  'meal_id': null,
  'sort_order': sortOrder,
  'created_by': 'user-1',
  'created_at': '2026-06-08T09:00:00+00:00',
};

void main() {
  group('ShoppingRepository.fetchItems', () {
    test('全 13 列 select + household eq + sort_order 昇順 order で取得する', () async {
      final r = _repo(itemsRows: [_row('a'), _row('b', sortOrder: 2)]);

      final items = await r.repo.fetchItems('hh-1');

      expect(r.items.lastSelectColumns, _kExpectedItemColumns);
      expect(r.itemsRead.eqFilters, [(column: 'household_id', value: 'hh-1')]);
      // web の `.order("sort_order", { ascending: true })` — Dart 既定
      // (descending) のままだとリストが逆順になるため、明示 ascending を検証。
      expect(r.itemsRead.orderCalls, [(column: 'sort_order', ascending: true)]);
      expect(items.map((i) => i.id), ['a', 'b']);
      expect(items.first.category, ItemCategory.dairy);
      expect(items.first.storeType, StoreType.supermarket);
    });

    test('PostgrestException は握り潰されず rethrow される', () async {
      final r = _repo(
        itemsReadError: const PostgrestException(message: 'boom', code: '500'),
      );

      await expectLater(
        r.repo.fetchItems('hh-1'),
        throwsA(isA<PostgrestException>()),
      );
    });
  });

  group('ShoppingRepository.addItem の sort_order 採番', () {
    test('既存最大値 + 1 で insert する (web getNextSortOrder)', () async {
      final r = _repo(itemsMaybeSingleValue: {'sort_order': 5});

      await r.repo.addItem(
        householdId: 'hh-1',
        userId: 'user-1',
        name: '  牛乳  ',
        quantity: '2本',
        category: ItemCategory.dairy,
        storeType: StoreType.drugstore,
      );

      // lookup は sort_order 降順 + limit 1 + maybeSingle (0 行は正常系)。
      expect(r.items.lastSelectColumns, 'sort_order');
      expect(r.itemsRead.eqFilters, [(column: 'household_id', value: 'hh-1')]);
      expect(r.itemsRead.orderCalls, [
        (column: 'sort_order', ascending: false),
      ]);
      expect(r.itemsRead.limitCalls, [1]);

      expect(r.items.lastInsertValues, {
        'household_id': 'hh-1',
        // name は trim される (web: name.trim())。
        'name': '牛乳',
        'quantity': '2本',
        'category': 'dairy',
        'store_type': 'drugstore',
        'created_by': 'user-1',
        'sort_order': 6,
      });
    });

    test('リストが空 (maybeSingle null) なら sort_order = 1', () async {
      final r = _repo(itemsMaybeSingleValue: null);

      await r.repo.addItem(householdId: 'hh-1', userId: 'user-1', name: 'パン');

      final inserted = r.items.lastInsertValues as Map<dynamic, dynamic>;
      expect(inserted['sort_order'], 1);
      // category / store_type の既定値は web のフォーム既定と同一。
      expect(inserted['category'], 'other_food');
      expect(inserted['store_type'], 'supermarket');
      // 空 quantity は null に正規化 (web: quantity || null)。
      expect(inserted['quantity'], isNull);
    });

    test('lookup 失敗はログのみで sort_order = 1 に fallback し insert は続行 '
        '(web parity)', () async {
      final r = _repo(
        itemsMaybeSingleError: const PostgrestException(
          message: 'boom',
          code: '500',
        ),
      );

      await r.repo.addItem(householdId: 'hh-1', userId: 'user-1', name: '卵');

      final inserted = r.items.lastInsertValues as Map<dynamic, dynamic>;
      expect(
        inserted['sort_order'],
        1,
        reason: 'web: (data?.sort_order ?? 0) + 1',
      );
      expect(inserted['name'], '卵');
    });

    test('quantity の空文字は null に正規化される (web: quantity || null)', () async {
      final r = _repo(itemsMaybeSingleValue: null);

      await r.repo.addItem(
        householdId: 'hh-1',
        userId: 'user-1',
        name: '豆腐',
        quantity: '',
      );

      final inserted = r.items.lastInsertValues as Map<dynamic, dynamic>;
      expect(inserted['quantity'], isNull);
    });

    test('name が空白のみなら ArgumentError で insert に進まない', () async {
      final r = _repo();

      await expectLater(
        r.repo.addItem(householdId: 'hh-1', userId: 'user-1', name: '   '),
        throwsA(isA<ArgumentError>()),
      );
      expect(r.items.lastInsertValues, isNull);
      // lookup にも進まない (validation が先)。
      expect(r.itemsRead.limitCalls, isEmpty);
    });
  });

  group('ShoppingRepository.toggleItem', () {
    test('チェック ON: is_checked/checked_by/checked_at のみ更新 + 行数検証', () async {
      final r = _repo(itemsSingleValue: {'id': 'item-1'});

      await r.repo.toggleItem(
        householdId: 'hh-1',
        itemId: 'item-1',
        isChecked: true,
        userId: 'user-2',
      );

      final values = r.items.lastUpdateValues!;
      expect(
        values.keys,
        unorderedEquals(['is_checked', 'checked_by', 'checked_at']),
      );
      expect(values['is_checked'], true);
      expect(values['checked_by'], 'user-2');
      // checked_at は現在時刻の ISO 文字列 (web: new Date().toISOString())。
      expect(values['checked_at'], isA<String>());
      expect(DateTime.parse(values['checked_at'] as String).isUtc, isTrue);

      // household スコープ + .select('id').single() の行数検証
      // (CLAUDE.md「.update() は 0 行更新でも error: null」)。
      expect(r.itemsMutation.eqFilters, [
        (column: 'id', value: 'item-1'),
        (column: 'household_id', value: 'hh-1'),
      ]);
      expect(r.itemsMutation.selectedColumns, 'id');
    });

    test('チェック OFF: checked_by / checked_at が null に戻る', () async {
      final r = _repo(itemsSingleValue: {'id': 'item-1'});

      await r.repo.toggleItem(
        householdId: 'hh-1',
        itemId: 'item-1',
        isChecked: false,
        userId: 'user-2',
      );

      final values = r.items.lastUpdateValues!;
      expect(values['is_checked'], false);
      expect(values['checked_by'], isNull);
      expect(values['checked_at'], isNull);
    });

    test('対象 0 行 (他世帯/既削除) の PGRST116 は rethrow される', () async {
      final r = _repo(
        itemsSingleError: const PostgrestException(
          message: 'JSON object requested, multiple (or no) rows returned',
          code: 'PGRST116',
        ),
      );

      await expectLater(
        r.repo.toggleItem(
          householdId: 'hh-other',
          itemId: 'item-1',
          isChecked: true,
          userId: 'user-2',
        ),
        throwsA(
          isA<PostgrestException>().having((e) => e.code, 'code', 'PGRST116'),
        ),
      );
    });
  });

  group('ShoppingRepository.deleteItem', () {
    test('id + household スコープで削除する (web 同形)', () async {
      final r = _repo();

      await r.repo.deleteItem(householdId: 'hh-1', itemId: 'item-1');

      expect(r.items.deleteCallCount, 1);
      expect(r.itemsMutation.eqFilters, [
        (column: 'id', value: 'item-1'),
        (column: 'household_id', value: 'hh-1'),
      ]);
    });
  });

  group('ShoppingRepository.clearChecked (web 3 段処理)', () {
    const checkedRows = [
      {'name': '牛乳', 'category': 'dairy', 'store_type': 'supermarket'},
      {'name': '洗剤', 'category': 'cleaning', 'store_type': 'drugstore'},
      // 未知 ENUM 値も enum 往復せず**生の値のまま**履歴へパススルーする
      // (web と同一 — tolerant パースで other_daily に化けさせない)。
      {'name': '謎の物体', 'category': 'mystery_meat', 'store_type': 'online'},
    ];

    test('fetch → 履歴 insert → 削除の順で実行し件数を返す', () async {
      final r = _repo(itemsRows: checkedRows);

      final count = await r.repo.clearChecked('hh-1');

      expect(count, 3);
      // web actions.ts の 3 段の順序。
      expect(r.client.fromTables, [
        'shopping_items',
        'purchase_history',
        'shopping_items',
      ]);

      // 1 段目: チェック済み取得の対象列と filter (web と同一)。
      expect(r.items.lastSelectColumns, 'name, category, store_type');
      expect(r.itemsRead.eqFilters, [
        (column: 'household_id', value: 'hh-1'),
        (column: 'is_checked', value: true),
      ]);

      // 2 段目: 履歴行は {household_id, item_name, category, store_type}。
      expect(r.history.lastInsertValues, [
        {
          'household_id': 'hh-1',
          'item_name': '牛乳',
          'category': 'dairy',
          'store_type': 'supermarket',
        },
        {
          'household_id': 'hh-1',
          'item_name': '洗剤',
          'category': 'cleaning',
          'store_type': 'drugstore',
        },
        {
          'household_id': 'hh-1',
          'item_name': '謎の物体',
          'category': 'mystery_meat',
          'store_type': 'online',
        },
      ]);

      // 3 段目: household + is_checked=true で削除。
      expect(r.items.deleteCallCount, 1);
      expect(r.itemsMutation.eqFilters, [
        (column: 'household_id', value: 'hh-1'),
        (column: 'is_checked', value: true),
      ]);
    });

    test('履歴 insert 失敗はログのみで削除を続行する (web parity)', () async {
      final r = _repo(
        itemsRows: checkedRows,
        historyInsertError: const PostgrestException(
          message: 'history boom',
          code: '500',
        ),
      );

      final count = await r.repo.clearChecked('hh-1');

      // 履歴失敗でも throw せず、削除まで完走して件数を返す。
      expect(count, 3);
      expect(r.items.deleteCallCount, 1);
      expect(r.client.fromTables, [
        'shopping_items',
        'purchase_history',
        'shopping_items',
      ]);
    });

    test('チェック済み 0 件は NoCheckedShoppingItemsException で履歴/削除に進まない', () async {
      final r = _repo(itemsRows: const []);

      await expectLater(
        r.repo.clearChecked('hh-1'),
        throwsA(isA<NoCheckedShoppingItemsException>()),
      );
      expect(r.client.fromTables, ['shopping_items']);
      expect(r.history.lastInsertValues, isNull);
      expect(r.items.deleteCallCount, 0);
      // web actions.ts と同一文言 (F4 がそのまま表示する)。
      expect(NoCheckedShoppingItemsException.message, 'チェック済みのアイテムがありません');
    });

    test('fetch 失敗は rethrow され履歴/削除に進まない', () async {
      final r = _repo(
        itemsReadError: const PostgrestException(message: 'boom', code: '500'),
      );

      await expectLater(
        r.repo.clearChecked('hh-1'),
        throwsA(isA<PostgrestException>()),
      );
      expect(r.history.lastInsertValues, isNull);
      expect(r.items.deleteCallCount, 0);
    });

    test('削除失敗は rethrow される (履歴は既に記録済み)', () async {
      // FakeFilterBuilder の mutation は await 時に cannedError を投げる。
      final itemsRead = FakeFilterBuilder(cannedValue: checkedRows);
      final itemsMutation = FakeFilterBuilder(
        cannedError: const PostgrestException(
          message: 'delete boom',
          code: '500',
        ),
      );
      final items = FakeQueryBuilder(itemsRead, mutationFilter: itemsMutation);
      final historyMutation = FakeFilterBuilder(cannedValue: const []);
      final history = FakeQueryBuilder(
        FakeFilterBuilder(cannedValue: const []),
        mutationFilter: historyMutation,
      );
      final client = FakeSupabaseClient(
        fromBuilders: {'shopping_items': items, 'purchase_history': history},
      );
      final repo = ShoppingRepository(client);

      await expectLater(
        repo.clearChecked('hh-1'),
        throwsA(
          isA<PostgrestException>().having(
            (e) => e.message,
            'message',
            'delete boom',
          ),
        ),
      );
      // 履歴 insert は削除より前に実行済み (web の順序)。
      expect(history.lastInsertValues, isNotNull);
    });
  });
}
