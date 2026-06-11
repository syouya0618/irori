import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/stock/data/stock_repository.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

/// PR-G「在庫⇆買い物の消耗品連携」の repository 層テスト。
///
/// 対象: `StockRepository.addToShoppingList` (在庫→買い物リスト手動追加) と
/// `StockRepository.autoAddLowStockItems` (低在庫自動追加)。
/// web 原典: `stock/actions.ts` `addToShoppingList` (:107-160) /
/// `lib/supabase/low-stock.ts` `autoAddLowStockItems`。

/// `addToShoppingList` 用の fake 一式 (stock_items + shopping_items)。
({
  StockRepository repo,
  FakeSupabaseClient client,
  FakeQueryBuilder stockTable,
  FakeFilterBuilder stockRead,
  FakeQueryBuilder shoppingTable,
  FakeFilterBuilder shoppingRead,
  FakeFilterBuilder shoppingMutation,
})
_manualAddRepo({
  PostgrestMap? stockSingleValue,
  Object? stockSingleError,
  PostgrestList duplicateRows = const [],
  Object? duplicateError,
  PostgrestMap? sortOrderRow,
  Object? insertError,
}) {
  final stockRead = FakeFilterBuilder(
    singleValue: stockSingleValue,
    singleError: stockSingleError,
  );
  final stockTable = FakeQueryBuilder(stockRead);
  // shopping_items は同一 builder で ilike 重複チェック (await → cannedValue)
  // と sort_order lookup (maybeSingle) の両 read を受ける。
  final shoppingRead = FakeFilterBuilder(
    cannedValue: duplicateRows,
    cannedError: duplicateError,
    maybeSingleValue: sortOrderRow,
  );
  final shoppingMutation = FakeFilterBuilder(
    cannedValue: const [],
    cannedError: insertError,
  );
  final shoppingTable = FakeQueryBuilder(
    shoppingRead,
    mutationFilter: shoppingMutation,
  );
  final client = FakeSupabaseClient(
    fromBuilders: {
      'stock_items': stockTable,
      'shopping_items': shoppingTable,
    },
  );
  return (
    repo: StockRepository(client),
    client: client,
    stockTable: stockTable,
    stockRead: stockRead,
    shoppingTable: shoppingTable,
    shoppingRead: shoppingRead,
    shoppingMutation: shoppingMutation,
  );
}

/// `autoAddLowStockItems` 用の fake 一式 (4 テーブル)。
({
  StockRepository repo,
  FakeSupabaseClient client,
  FakeFilterBuilder householdRead,
  FakeFilterBuilder logsRead,
  FakeFilterBuilder stockRead,
  FakeFilterBuilder shoppingRead,
  FakeQueryBuilder shoppingTable,
  FakeFilterBuilder shoppingMutation,
})
_autoAddRepo({
  PostgrestMap? householdValue,
  Object? householdError,
  PostgrestList logRows = const [],
  Object? logsError,
  PostgrestList stockRows = const [],
  Object? stockError,
  PostgrestList shoppingRows = const [],
  Object? shoppingReadError,
  PostgrestMap? sortOrderRow,
  Object? insertError,
}) {
  final householdRead = FakeFilterBuilder(
    singleValue:
        householdValue ??
        {
          'auto_stock_categories': ['baby'],
        },
    singleError: householdError,
  );
  final logsRead = FakeFilterBuilder(
    cannedValue: logRows,
    cannedError: logsError,
  );
  final stockRead = FakeFilterBuilder(
    cannedValue: stockRows,
    cannedError: stockError,
  );
  final shoppingRead = FakeFilterBuilder(
    cannedValue: shoppingRows,
    cannedError: shoppingReadError,
    maybeSingleValue: sortOrderRow,
  );
  final shoppingMutation = FakeFilterBuilder(
    cannedValue: const [],
    cannedError: insertError,
  );
  final shoppingTable = FakeQueryBuilder(
    shoppingRead,
    mutationFilter: shoppingMutation,
  );
  final client = FakeSupabaseClient(
    fromBuilders: {
      'households': FakeQueryBuilder(householdRead),
      'baby_logs': FakeQueryBuilder(logsRead),
      'stock_items': FakeQueryBuilder(stockRead),
      'shopping_items': shoppingTable,
    },
  );
  return (
    repo: StockRepository(client),
    client: client,
    householdRead: householdRead,
    logsRead: logsRead,
    stockRead: stockRead,
    shoppingRead: shoppingRead,
    shoppingTable: shoppingTable,
    shoppingMutation: shoppingMutation,
  );
}

/// JST 固定の基準時刻 (now seam)。today = 2026-06-10 (JST)。
final _now = DateTime.parse('2026-06-10T12:00:00+09:00');

/// diaper ログ行 (low-stock.ts の select 3 列の形)。
PostgrestMap _diaperLog(String loggedAtJst) => {
  'log_type': 'diaper',
  'logged_at': loggedAtJst,
  'amount_ml': null,
};

PostgrestMap _stockRow(
  String id,
  String name, {
  String category = 'baby',
  Object quantity = 1,
}) => {'id': id, 'name': name, 'category': category, 'quantity': quantity};

void main() {
  group('StockRepository.addToShoppingList', () {
    test('stock_items を name, category で household スコープ single 取得する', () async {
      final r = _manualAddRepo(
        stockSingleValue: {'name': 'おむつ', 'category': 'baby'},
        sortOrderRow: {'sort_order': 3},
      );

      await r.repo.addToShoppingList(
        householdId: 'hh-1',
        userId: 'user-1',
        itemId: 'stock-1',
      );

      expect(r.stockTable.lastSelectColumns, 'name, category');
      expect(r.stockRead.eqFilters, [
        (column: 'id', value: 'stock-1'),
        (column: 'household_id', value: 'hh-1'),
      ]);
    });

    test('重複チェックは ilike に生の name を渡す (% _ をエスケープしない web quirk)', () async {
      // web stock/actions.ts:128 `.ilike("name", stockItem.name)` は
      // % / _ をエスケープしない。'50%引き_おむつ' の % は任意長 wildcard、
      // _ は任意 1 文字として解釈される latent quirk をそのまま移植する。
      final r = _manualAddRepo(
        stockSingleValue: {'name': '50%引き_おむつ', 'category': 'baby'},
        sortOrderRow: {'sort_order': 1},
      );

      await r.repo.addToShoppingList(
        householdId: 'hh-1',
        userId: 'user-1',
        itemId: 'stock-1',
      );

      expect(r.shoppingRead.ilikeFilters, [
        (column: 'name', pattern: '50%引き_おむつ'),
      ]);
      // web と同じ household スコープ + limit(1)。
      expect(
        r.shoppingRead.eqFilters,
        contains((column: 'household_id', value: 'hh-1')),
      );
      expect(r.shoppingRead.limitCalls, contains(1));
    });

    test(
      '既に買い物リストにあるときは DuplicateShoppingItemException で insert しない',
      () async {
        final r = _manualAddRepo(
          stockSingleValue: {'name': 'おむつ', 'category': 'baby'},
          duplicateRows: [
            {'id': 'shopping-9'},
          ],
        );

        await expectLater(
          r.repo.addToShoppingList(
            householdId: 'hh-1',
            userId: 'user-1',
            itemId: 'stock-1',
          ),
          throwsA(isA<DuplicateShoppingItemException>()),
        );
        expect(r.shoppingTable.lastInsertValues, isNull);
        // web actions.ts:135 と同一文言。
        expect(DuplicateShoppingItemException.message, '既に買い物リストにあります');
      },
    );

    test(
      'insert は store_type supermarket (drugstore ではない) + sort_order 最大+1',
      () async {
        final r = _manualAddRepo(
          stockSingleValue: {'name': 'おむつ', 'category': 'baby'},
          sortOrderRow: {'sort_order': 4},
        );

        await r.repo.addToShoppingList(
          householdId: 'hh-1',
          userId: 'user-1',
          itemId: 'stock-1',
        );

        // web actions.ts:141-150 の insert 行と同一。category は stock から
        // 取得した生文字列のパススルー。
        expect(r.shoppingTable.lastInsertValues, {
          'household_id': 'hh-1',
          'name': 'おむつ',
          'category': 'baby',
          'store_type': 'supermarket',
          'created_by': 'user-1',
          'sort_order': 5,
        });
      },
    );

    test('重複チェック失敗はログのみで insert へ続行する (web parity)', () async {
      // web actions.ts:130-134: existingError は logSupabaseError のみで
      // return しない → existing null 扱いで insert に進む。
      final r = _manualAddRepo(
        stockSingleValue: {'name': 'おむつ', 'category': 'baby'},
        duplicateError: const PostgrestException(message: 'boom', code: '500'),
        sortOrderRow: {'sort_order': 1},
      );

      await r.repo.addToShoppingList(
        householdId: 'hh-1',
        userId: 'user-1',
        itemId: 'stock-1',
      );

      expect(r.shoppingTable.lastInsertValues, isNotNull);
    });

    test('stock_items の取得失敗は rethrow される', () async {
      final r = _manualAddRepo(
        stockSingleError: const PostgrestException(
          message: 'not found',
          code: 'PGRST116',
        ),
      );

      await expectLater(
        r.repo.addToShoppingList(
          householdId: 'hh-1',
          userId: 'user-1',
          itemId: 'stock-x',
        ),
        throwsA(isA<PostgrestException>()),
      );
      expect(r.shoppingTable.lastInsertValues, isNull);
    });

    test('insert 失敗は rethrow される', () async {
      final r = _manualAddRepo(
        stockSingleValue: {'name': 'おむつ', 'category': 'baby'},
        sortOrderRow: {'sort_order': 1},
        insertError: const PostgrestException(message: 'boom', code: '500'),
      );

      await expectLater(
        r.repo.addToShoppingList(
          householdId: 'hh-1',
          userId: 'user-1',
          itemId: 'stock-1',
        ),
        throwsA(isA<PostgrestException>()),
      );
    });
  });

  group('StockRepository.autoAddLowStockItems', () {
    test('残日数 ≤3 の baby 在庫のみ drugstore で一括 insert する '
        '(remaining == 0 は「今日切れ」の有効値として含む)', () async {
      // diaper 4 件 / ユニーク 2 日 → rate 2.0/日。
      final r = _autoAddRepo(
        logRows: [
          _diaperLog('2026-06-10T08:00:00+09:00'),
          _diaperLog('2026-06-10T09:00:00+09:00'),
          _diaperLog('2026-06-09T08:00:00+09:00'),
          _diaperLog('2026-06-09T09:00:00+09:00'),
        ],
        stockRows: [
          // remaining = floor(6/2.0) = 3 → 対象。
          _stockRow('s1', 'おむつ', quantity: 6),
          // remaining = floor(8/2.0) = 4 → 対象外。
          _stockRow('s2', 'おしりふき', quantity: 8),
          // remaining = 0 (quantity 0 は「今日切れ」) → 対象。
          // `if (remaining != null)` でなく truthy 風判定を書くとここが漏れる。
          _stockRow('s3', '新生児おむつ', quantity: 0),
          // baby 以外はレート未対応 (rates['vegetable'] == null) → 対象外。
          _stockRow('s4', 'トマト', category: 'vegetable', quantity: 1),
        ],
        sortOrderRow: {'sort_order': 9},
      );

      final result = await r.repo.autoAddLowStockItems(
        householdId: 'hh-1',
        userId: 'user-1',
        now: _now,
      );

      expect(result.error, isNull);
      expect(result.addedItems, ['おむつ', '新生児おむつ']);
      // web low-stock.ts の insertRows と同一列: drugstore / created_by /
      // sort_order 連番 (max+1 から ++)。
      expect(r.shoppingTable.lastInsertValues, [
        {
          'household_id': 'hh-1',
          'name': 'おむつ',
          'category': 'baby',
          'store_type': 'drugstore',
          'created_by': 'user-1',
          'sort_order': 10,
        },
        {
          'household_id': 'hh-1',
          'name': '新生児おむつ',
          'category': 'baby',
          'store_type': 'drugstore',
          'created_by': 'user-1',
          'sort_order': 11,
        },
      ]);
    });

    test('baby_logs は diaper/feeding を JST 7 日前 0 時以降で絞り、'
        'shopping_items は未チェックのみ取得する', () async {
      final r = _autoAddRepo(
        logRows: [_diaperLog('2026-06-10T08:00:00+09:00')],
        stockRows: [_stockRow('s1', 'おむつ', quantity: 1)],
        sortOrderRow: {'sort_order': 0},
      );

      await r.repo.autoAddLowStockItems(
        householdId: 'hh-1',
        userId: 'user-1',
        now: _now,
      );

      // web low-stock.ts:38-41 の in + gte。gte は web の TZ 無指定
      // `${weekAgo}T00:00:00` より広い +09:00 明示の superset
      // (calculateDailyRate の JST 再フィルタで結果同一)。
      // record 内の List は == が identity のため分解して deep 比較する。
      expect(r.logsRead.inFilters, hasLength(1));
      expect(r.logsRead.inFilters.single.column, 'log_type');
      expect(r.logsRead.inFilters.single.values, ['diaper', 'feeding']);
      expect(r.logsRead.gteFilters, [
        (column: 'logged_at', value: '2026-06-03T00:00:00+09:00'),
      ]);
      // web low-stock.ts:47-50: 既存除外は is_checked=false のみ対象
      // (チェック済み同名は除外されず再追加される web parity の機械検証)。
      expect(
        r.shoppingRead.eqFilters,
        containsAll([
          (column: 'household_id', value: 'hh-1'),
          (column: 'is_checked', value: false),
        ]),
      );
    });

    test('未チェックの同名 (toLowerCase 一致) は除外し、残りのみ追加する', () async {
      final r = _autoAddRepo(
        logRows: [
          _diaperLog('2026-06-10T08:00:00+09:00'),
          _diaperLog('2026-06-10T09:00:00+09:00'),
        ],
        stockRows: [
          // remaining = floor(1/2.0) = 0 → 対象だが既存 (大文字小文字違い)。
          _stockRow('s1', 'Diaper Pants', quantity: 1),
          _stockRow('s2', 'おしりふき', quantity: 1),
        ],
        shoppingRows: [
          {'name': 'diaper pants'},
        ],
        sortOrderRow: {'sort_order': 2},
      );

      final result = await r.repo.autoAddLowStockItems(
        householdId: 'hh-1',
        userId: 'user-1',
        now: _now,
      );

      expect(result.error, isNull);
      expect(result.addedItems, ['おしりふき']);
    });

    test('auto_stock_categories に baby が無ければ何も追加しない', () async {
      final r = _autoAddRepo(
        householdValue: {
          'auto_stock_categories': ['vegetable'],
        },
        logRows: [_diaperLog('2026-06-10T08:00:00+09:00')],
        stockRows: [_stockRow('s1', 'おむつ', quantity: 0)],
      );

      final result = await r.repo.autoAddLowStockItems(
        householdId: 'hh-1',
        userId: 'user-1',
        now: _now,
      );

      expect(result.error, isNull);
      expect(result.addedItems, isEmpty);
      expect(r.shoppingTable.lastInsertValues, isNull);
    });

    test(
      'auto_stock_categories が空配列なら何も追加しない (web の length===0 ガード)',
      () async {
        final r = _autoAddRepo(
          householdValue: {'auto_stock_categories': <Object?>[]},
          logRows: [_diaperLog('2026-06-10T08:00:00+09:00')],
          stockRows: [_stockRow('s1', 'おむつ', quantity: 0)],
        );

        final result = await r.repo.autoAddLowStockItems(
          householdId: 'hh-1',
          userId: 'user-1',
          now: _now,
        );

        expect(result.error, isNull);
        expect(result.addedItems, isEmpty);
        expect(r.shoppingTable.lastInsertValues, isNull);
      },
    );

    test('ログ 0 件 (rate null) なら何も追加しない', () async {
      final r = _autoAddRepo(
        stockRows: [_stockRow('s1', 'おむつ', quantity: 0)],
      );

      final result = await r.repo.autoAddLowStockItems(
        householdId: 'hh-1',
        userId: 'user-1',
        now: _now,
      );

      expect(result.error, isNull);
      expect(result.addedItems, isEmpty);
      expect(r.shoppingTable.lastInsertValues, isNull);
    });

    test(
      'read 失敗 1 本 (stock_items) で error: null + 空戻り (web parity)',
      () async {
        // web low-stock.ts:53-61: 4 read のいずれかが error なら
        // `{ error: null, addedItems: [] }` で静かに諦める (error は null!)。
        final r = _autoAddRepo(
          logRows: [_diaperLog('2026-06-10T08:00:00+09:00')],
          stockError: const PostgrestException(message: 'boom', code: '500'),
        );

        final result = await r.repo.autoAddLowStockItems(
          householdId: 'hh-1',
          userId: 'user-1',
          now: _now,
        );

        expect(result.error, isNull);
        expect(result.addedItems, isEmpty);
        expect(r.shoppingTable.lastInsertValues, isNull);
      },
    );

    test('households read 失敗でも error: null + 空戻り', () async {
      final r = _autoAddRepo(
        householdError: const PostgrestException(message: 'boom', code: '500'),
        logRows: [_diaperLog('2026-06-10T08:00:00+09:00')],
        stockRows: [_stockRow('s1', 'おむつ', quantity: 0)],
      );

      final result = await r.repo.autoAddLowStockItems(
        householdId: 'hh-1',
        userId: 'user-1',
        now: _now,
      );

      expect(result.error, isNull);
      expect(result.addedItems, isEmpty);
    });

    test('insert 失敗は error 非 null + 空戻り (スロットル未記録の根拠)', () async {
      // web low-stock.ts:115-117 の「買い物リストへの追加に失敗しました」。
      // 呼び出し側 (web stock-list.tsx:124-125 `if (result.error) return`) は
      // この時だけタイムスタンプを記録せず次回再試行する。
      final r = _autoAddRepo(
        logRows: [
          _diaperLog('2026-06-10T08:00:00+09:00'),
          _diaperLog('2026-06-10T09:00:00+09:00'),
        ],
        stockRows: [_stockRow('s1', 'おむつ', quantity: 1)],
        sortOrderRow: {'sort_order': 0},
        insertError: const PostgrestException(message: 'boom', code: '500'),
      );

      final result = await r.repo.autoAddLowStockItems(
        householdId: 'hh-1',
        userId: 'user-1',
        now: _now,
      );

      expect(result.error, '買い物リストへの追加に失敗しました');
      expect(result.addedItems, isEmpty);
    });

    test('JST 窓外 (cutoff 当日以前) のログはレート算出から除外される', () async {
      // calculateDailyRate の JST 再フィルタは半開区間 (cutoff < logDate)。
      // cutoff = 2026-06-03 ゆえ 06-03 のログは窓外、06-04 は窓内。
      //
      // 判別設計: 窓フィルタが効けば rate = 1 件 / 1 日 = 1.0 →
      // おしりふき (quantity 4) は remaining 4 で対象外。
      // 窓外 3 件が混入すると rate = 4 件 / 2 日 = 2.0 → remaining 2 で
      // 誤って対象になる — addedItems の差で機械検出する。
      final r = _autoAddRepo(
        logRows: [
          _diaperLog('2026-06-03T08:00:00+09:00'), // 窓外
          _diaperLog('2026-06-03T12:00:00+09:00'), // 窓外
          _diaperLog('2026-06-03T23:00:00+09:00'), // 窓外
          _diaperLog('2026-06-04T08:00:00+09:00'), // 窓内
        ],
        stockRows: [
          // remaining = floor(3/1.0) = 3 → 対象 (どちらの rate でも対象)。
          _stockRow('s1', 'おむつ', quantity: 3),
          // remaining = floor(4/1.0) = 4 → 対象外 (rate 2.0 だと誤対象)。
          _stockRow('s2', 'おしりふき', quantity: 4),
        ],
        sortOrderRow: {'sort_order': 0},
      );

      final result = await r.repo.autoAddLowStockItems(
        householdId: 'hh-1',
        userId: 'user-1',
        now: _now,
      );

      expect(result.addedItems, ['おむつ']);
    });
  });
}
