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

/// households fake の既定行。auto_stock_categories は DB DEFAULT
/// `'["baby","cleaning","hygiene"]'` (migration 20260411000002) と同一。
const PostgrestMap _kDefaultHouseholdRow = {
  'auto_stock_categories': ['baby', 'cleaning', 'hygiene'],
};

/// shopping_items / purchase_history / households / stock_items の
/// 4 テーブル fake 一式 (households / stock_items は PR P2.5-B の
/// `autoAddToStock` 用 — fake_supabase 本体は変更せず builder 登録のみ)。
({
  ShoppingRepository repo,
  FakeSupabaseClient client,
  FakeQueryBuilder items,
  FakeFilterBuilder itemsRead,
  FakeFilterBuilder itemsMutation,
  FakeQueryBuilder history,
  FakeFilterBuilder historyMutation,
  FakeQueryBuilder households,
  FakeFilterBuilder householdsRead,
  FakeQueryBuilder stock,
  FakeFilterBuilder stockRead,
  FakeFilterBuilder stockMutation,
})
_repo({
  PostgrestList itemsRows = const [],
  Object? itemsReadError,
  PostgrestMap? itemsMaybeSingleValue,
  Object? itemsMaybeSingleError,
  PostgrestMap? itemsSingleValue,
  Object? itemsSingleError,
  Object? historyInsertError,
  PostgrestMap? householdRow = _kDefaultHouseholdRow,
  Object? householdReadError,
  PostgrestList stockRows = const [],
  Object? stockReadError,
  Object? stockMutationError,
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

  final householdsRead = FakeFilterBuilder(
    cannedValue: const [],
    singleValue: householdRow,
    singleError: householdReadError,
  );
  final households = FakeQueryBuilder(householdsRead);

  final stockRead = FakeFilterBuilder(
    cannedValue: stockRows,
    cannedError: stockReadError,
  );
  final stockMutation = FakeFilterBuilder(
    cannedValue: const [],
    cannedError: stockMutationError,
  );
  final stock = FakeQueryBuilder(stockRead, mutationFilter: stockMutation);

  final client = FakeSupabaseClient(
    fromBuilders: {
      'shopping_items': items,
      'purchase_history': history,
      'households': households,
      'stock_items': stock,
    },
  );
  return (
    repo: ShoppingRepository(client),
    client: client,
    items: items,
    itemsRead: itemsRead,
    itemsMutation: itemsMutation,
    history: history,
    historyMutation: historyMutation,
    households: households,
    householdsRead: householdsRead,
    stock: stock,
    stockRead: stockRead,
    stockMutation: stockMutation,
  );
}

/// `autoAddToStock` を強制 throw させる stub。`toggleItem` がこの throw を
/// 握り込んでチェック操作を成功させる防御 (web actions.ts:90-92 の
/// `catch {}` parity) の検証用。
class _ThrowingAutoStockRepository extends ShoppingRepository {
  _ThrowingAutoStockRepository(super.client);

  int autoStockCalls = 0;

  @override
  Future<bool> autoAddToStock({
    required String householdId,
    required String userId,
    required String itemName,
    required String itemCategory,
  }) async {
    autoStockCalls++;
    throw StateError('autoAddToStock boom');
  }
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
      // dairy は auto_stock_categories の既定値に含まれない → この test は
      // 在庫自動登録に入らず、update payload の検証に集中する。
      final r = _repo(itemsSingleValue: {'name': '牛乳', 'category': 'dairy'});

      final result = await r.repo.toggleItem(
        householdId: 'hh-1',
        itemId: 'item-1',
        isChecked: true,
        userId: 'user-2',
      );

      expect(result, (autoStocked: false, autoStockedName: null));

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

      // household スコープ + .select('name, category').single()。
      // 行数検証 (CLAUDE.md「.update() は 0 行更新でも error: null」) と
      // autoAddToStock への入力取得を兼ねる (web actions.ts:66 と同一列)。
      expect(r.itemsMutation.eqFilters, [
        (column: 'id', value: 'item-1'),
        (column: 'household_id', value: 'hh-1'),
      ]);
      expect(r.itemsMutation.selectedColumns, 'name, category');
    });

    test('チェック OFF: checked_by / checked_at が null に戻り、'
        '在庫自動登録には一切入らない', () async {
      final r = _repo(itemsSingleValue: {'name': 'おむつ', 'category': 'baby'});

      final result = await r.repo.toggleItem(
        householdId: 'hh-1',
        itemId: 'item-1',
        isChecked: false,
        userId: 'user-2',
      );

      expect(result, (autoStocked: false, autoStockedName: null));

      final values = r.items.lastUpdateValues!;
      expect(values['is_checked'], false);
      expect(values['checked_by'], isNull);
      expect(values['checked_at'], isNull);

      // OFF では autoAddToStock 自体を呼ばない (web actions.ts:77 の
      // `if (isChecked && updatedItem)`) — auto 対象カテゴリ (baby) でも
      // households / stock_items に触れない。
      expect(r.client.fromTables, ['shopping_items']);
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

  group('ShoppingRepository.toggleItem の在庫自動登録 (web auto-stock.ts:15-77)', () {
    /// チェック ON の toggle を実行する共通呼び出し
    /// (このグループの関心は autoAddToStock 側のため引数は固定)。
    Future<ToggleItemResult> toggleOn(ShoppingRepository repo) {
      return repo.toggleItem(
        householdId: 'hh-1',
        itemId: 'item-1',
        isChecked: true,
        userId: 'user-2',
      );
    }

    test('(a) auto 対象カテゴリ & 同名在庫あり: 既存 quantity + 1 の update を発行する', () async {
      final r = _repo(
        itemsSingleValue: {'name': 'おむつ', 'category': 'baby'},
        stockRows: [
          {'id': 'stock-1', 'name': 'おむつ', 'quantity': 2},
        ],
      );

      final result = await toggleOn(r.repo);

      expect(result, (autoStocked: true, autoStockedName: 'おむつ'));
      // toggle 更新 → households lookup → 在庫照合 → 在庫 update の順。
      expect(r.client.fromTables, [
        'shopping_items',
        'households',
        'stock_items',
        'stock_items',
      ]);
      expect(r.households.lastSelectColumns, 'auto_stock_categories');
      expect(r.householdsRead.eqFilters, [(column: 'id', value: 'hh-1')]);
      // read-modify-write の +1 (web auto-stock.ts:58-63。atomic 化しない)。
      expect(r.stock.lastUpdateValues, {'quantity': 3});
      expect(r.stockMutation.eqFilters, [(column: 'id', value: 'stock-1')]);
      expect(r.stock.lastInsertValues, isNull);
    });

    test(
      '(a補) quantity は num のまま +1 する (1.5 → 2.5、int 化・round() しない)',
      () async {
        final r = _repo(
          itemsSingleValue: {'name': 'おむつ', 'category': 'baby'},
          stockRows: [
            {'id': 'stock-1', 'name': 'おむつ', 'quantity': 1.5},
          ],
        );

        await toggleOn(r.repo);

        // StockItem.quantity は num (int 化はデータ破壊 — stock_item.dart doc)。
        expect(r.stock.lastUpdateValues, {'quantity': 2.5});
      },
    );

    test('(b) 同名在庫なし: quantity 1 / unit 個 で新規 insert する', () async {
      final r = _repo(
        itemsSingleValue: {'name': 'おしりふき', 'category': 'baby'},
        stockRows: const [],
      );

      final result = await toggleOn(r.repo);

      expect(result, (autoStocked: true, autoStockedName: 'おしりふき'));
      // insert 行は web auto-stock.ts:65-72 と同一 (category は DB の生値
      // パススルー — enum 往復しない)。
      expect(r.stock.lastInsertValues, {
        'household_id': 'hh-1',
        'name': 'おしりふき',
        'category': 'baby',
        'quantity': 1,
        'unit': '個',
        'created_by': 'user-2',
      });
      expect(r.stock.lastUpdateValues, isNull);
    });

    test('(f) 在庫照合は trim のみの case-sensitive eq + order なし limit(1) '
        '(web auto-stock.ts:43-48)', () async {
      final r = _repo(
        itemsSingleValue: {'name': '  Baby Wipes  ', 'category': 'baby'},
        stockRows: const [],
      );

      await toggleOn(r.repo);

      expect(r.stock.lastSelectColumns, 'id, name, quantity');
      // trim はするが toLowerCase はしない (case-sensitive — 意図的 quirk。
      // 機能ごとに照合規格が異なる: 計画 risks 欄参照)。
      expect(r.stockRead.eqFilters, [
        (column: 'household_id', value: 'hh-1'),
        (column: 'name', value: 'Baby Wipes'),
      ]);
      expect(r.stockRead.limitCalls, [1]);
      // order なしの limit(1) (web parity — 同名複数行は非決定で 1 行)。
      expect(r.stockRead.orderCalls, isEmpty);
      // insert する name も trim 済みの生値 (web auto-stock.ts:67)。
      final inserted = r.stock.lastInsertValues as Map<dynamic, dynamic>?;
      expect(inserted?['name'], 'Baby Wipes');
    });

    test('(c) カテゴリが auto 対象外なら stock_items にアクセスしない', () async {
      final r = _repo(itemsSingleValue: {'name': '牛乳', 'category': 'dairy'});

      final result = await toggleOn(r.repo);

      expect(result, (autoStocked: false, autoStockedName: null));
      expect(r.client.fromTables, ['shopping_items', 'households']);
      expect(r.stock.lastInsertValues, isNull);
      expect(r.stock.lastUpdateValues, isNull);
    });

    test('(c補) auto_stock_categories が配列でない場合も skip する '
        '(web Array.isArray ガード)', () async {
      final r = _repo(
        itemsSingleValue: {'name': 'おむつ', 'category': 'baby'},
        householdRow: {'auto_stock_categories': 'baby'},
      );

      final result = await toggleOn(r.repo);

      expect(result, (autoStocked: false, autoStockedName: null));
      expect(r.client.fromTables, ['shopping_items', 'households']);
    });

    test('(d) households 取得エラーはログのみで skip し、チェック操作は成功する', () async {
      final r = _repo(
        itemsSingleValue: {'name': 'おむつ', 'category': 'baby'},
        householdReadError: const PostgrestException(
          message: 'household boom',
          code: '500',
        ),
      );

      final result = await toggleOn(r.repo);

      // throw されずチェック操作は完了 (web auto-stock.ts:29-35 の
      // log + `if (!household) return false`)。
      expect(result, (autoStocked: false, autoStockedName: null));
      expect(r.client.fromTables, ['shopping_items', 'households']);
      expect(r.stock.lastInsertValues, isNull);
    });

    test('在庫照合の失敗はログのみで「既存なし」扱いとなり insert に進む '
        '(web auto-stock.ts:56 の matchedItems?.[0] ?? null)', () async {
      final r = _repo(
        itemsSingleValue: {'name': 'おむつ', 'category': 'baby'},
        stockReadError: const PostgrestException(
          message: 'match boom',
          code: '500',
        ),
      );

      final result = await toggleOn(r.repo);

      expect(result, (autoStocked: true, autoStockedName: 'おむつ'));
      expect(r.stock.lastInsertValues, isNotNull);
      expect(r.stock.lastUpdateValues, isNull);
    });

    test('在庫 update 失敗は autoStocked=false でチェック操作は成功する '
        '(web auto-stock.ts:63)', () async {
      final r = _repo(
        itemsSingleValue: {'name': 'おむつ', 'category': 'baby'},
        stockRows: [
          {'id': 'stock-1', 'name': 'おむつ', 'quantity': 2},
        ],
        stockMutationError: const PostgrestException(
          message: 'update boom',
          code: '500',
        ),
      );

      final result = await toggleOn(r.repo);

      expect(result, (autoStocked: false, autoStockedName: null));
    });

    test('在庫 insert 失敗は autoStocked=false でチェック操作は成功する '
        '(web auto-stock.ts:73)', () async {
      final r = _repo(
        itemsSingleValue: {'name': 'おむつ', 'category': 'baby'},
        stockRows: const [],
        stockMutationError: const PostgrestException(
          message: 'insert boom',
          code: '500',
        ),
      );

      final result = await toggleOn(r.repo);

      expect(result, (autoStocked: false, autoStockedName: null));
    });

    test('(e) autoAddToStock 自体の throw は toggleItem を fail させない '
        '(web actions.ts:90-92)', () async {
      final r = _repo(itemsSingleValue: {'name': 'おむつ', 'category': 'baby'});
      final repo = _ThrowingAutoStockRepository(r.client);

      final result = await toggleOn(repo);

      // throw は握り込まれ (構造化ログのみ)、チェック操作は成功扱い。
      expect(repo.autoStockCalls, 1);
      expect(result, (autoStocked: false, autoStockedName: null));
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
