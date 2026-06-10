import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/stock/data/stock_repository.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

/// 一覧 select の期待値 (リポジトリ実装と独立にテスト側でも正を持ち、
/// 改変を検出する)。web `cached-queries.ts` の select に `household_id` を
/// 追加したもの (`StockItem` が Row 1:1 のための意図的差異)。
const _kExpectedColumns =
    'id, household_id, name, category, quantity, unit, expires_at, '
    'created_by, created_at, updated_at';

/// stock_items 単一テーブルの fake 一式。
({
  StockRepository repo,
  FakeSupabaseClient client,
  FakeQueryBuilder table,
  FakeFilterBuilder read,
  FakeFilterBuilder mutation,
})
_repo({
  PostgrestList rows = const [],
  Object? readError,
  Object? mutationError,
  PostgrestMap? singleValue,
  Object? singleError,
}) {
  final read = FakeFilterBuilder(cannedValue: rows, cannedError: readError);
  final mutation = FakeFilterBuilder(
    cannedValue: const [],
    cannedError: mutationError,
    singleValue: singleValue,
    singleError: singleError,
  );
  final table = FakeQueryBuilder(read, mutationFilter: mutation);
  final client = FakeSupabaseClient(fromBuilders: {'stock_items': table});
  return (
    repo: StockRepository(client),
    client: client,
    table: table,
    read: read,
    mutation: mutation,
  );
}

void main() {
  group('StockRepository.fetchItems', () {
    test('select 文字列が web 版 + household_id である', () async {
      final r = _repo();

      await r.repo.fetchItems('hh-1');

      expect(r.table.lastSelectColumns, _kExpectedColumns);
    });

    test('household eq + name 昇順 order で絞る', () async {
      final r = _repo();

      await r.repo.fetchItems('hh-1');

      expect(r.read.eqFilters, [(column: 'household_id', value: 'hh-1')]);
      // web の .order("name") は ascending — Dart 既定 (descending) のままだと
      // 並びが逆転するため、明示 ascending を検証する。
      expect(r.read.orderCalls, [(column: 'name', ascending: true)]);
    });

    test('行を StockItem に復元して返す', () async {
      final r = _repo(
        rows: [
          {
            'id': 'stock-1',
            'household_id': 'hh-1',
            'name': '牛乳',
            'category': 'dairy',
            'quantity': 2,
            'unit': '本',
            'expires_at': '2026-06-13',
            'created_by': 'user-1',
            'created_at': '2026-06-08T00:00:00+09:00',
            'updated_at': '2026-06-08T00:00:00+09:00',
          },
        ],
      );

      final items = await r.repo.fetchItems('hh-1');

      expect(items, hasLength(1));
      expect(items.single.id, 'stock-1');
      expect(items.single.category, ItemCategory.dairy);
      expect(items.single.expiresAt, '2026-06-13');
    });

    test('PostgrestException は握り潰されず rethrow される', () async {
      final r = _repo(
        readError: const PostgrestException(message: 'boom', code: '500'),
      );

      await expectLater(
        r.repo.fetchItems('hh-1'),
        throwsA(isA<PostgrestException>().having((e) => e.code, 'code', '500')),
      );
    });
  });

  group('StockRepository.addItem', () {
    test('insert 行が web addStockItem と同一の列構成になる', () async {
      final r = _repo();

      await r.repo.addItem(
        householdId: 'hh-1',
        userId: 'user-1',
        name: ' 牛乳 ', // 前後空白は trim される (web: name.trim())
        category: ItemCategory.dairy,
        quantity: 2,
        unit: '本',
        expiresAt: '2026-06-13',
      );

      expect(r.client.fromTables, ['stock_items']);
      expect(r.table.lastInsertValues, {
        'household_id': 'hh-1',
        'name': '牛乳',
        'category': 'dairy',
        'quantity': 2,
        'unit': '本',
        'expires_at': '2026-06-13',
        'created_by': 'user-1',
      });
    });

    test('category / quantity の既定値は web parseStockFormData と同一', () async {
      // web: `(category) || "other_food"` / `Number(quantity) || 1`。
      final r = _repo();

      await r.repo.addItem(
        householdId: 'hh-1',
        userId: 'user-1',
        name: '塩',
      );

      expect(r.table.lastInsertValues, {
        'household_id': 'hh-1',
        'name': '塩',
        'category': 'other_food',
        'quantity': 1,
        'unit': null,
        'expires_at': null,
        'created_by': 'user-1',
      });
    });

    test('unit / expiresAt の空文字は null に正規化される (web 同形)', () async {
      final r = _repo();

      await r.repo.addItem(
        householdId: 'hh-1',
        userId: 'user-1',
        name: '塩',
        unit: '',
        expiresAt: '',
      );

      final values = r.table.lastInsertValues as Map<String, dynamic>?;
      expect(values, isNotNull);
      expect(values!['unit'], isNull);
      expect(values['expires_at'], isNull);
    });

    test('name が空 / 空白のみなら ArgumentError で insert に進まない', () async {
      final r = _repo();

      for (final name in ['', '   ']) {
        await expectLater(
          r.repo.addItem(householdId: 'hh-1', userId: 'user-1', name: name),
          throwsA(
            isA<ArgumentError>().having(
              (e) => e.message,
              'message',
              'アイテム名を入力してください', // web と同一文言
            ),
          ),
        );
      }
      expect(r.table.lastInsertValues, isNull);
    });

    test('quantity が 0 以下 / 非有限なら ArgumentError で insert に進まない', () async {
      // web は `|| 1` で 0/NaN を黙って 1 に補完するが、Flutter は型付き
      // 引数のため黙殺せず表面化させる (意図的差異)。
      final r = _repo();

      for (final quantity in <num>[0, -1, double.nan, double.infinity]) {
        await expectLater(
          r.repo.addItem(
            householdId: 'hh-1',
            userId: 'user-1',
            name: '塩',
            quantity: quantity,
          ),
          throwsA(isA<ArgumentError>()),
        );
      }
      expect(r.table.lastInsertValues, isNull);
    });

    test('quantity の境界値 1 と正の小数 (web step=0.1 が許す値) は通る', () async {
      // `< 1` で弾くと web が DB に保存した 0.5 等の在庫を Flutter で
      // 編集できなくなる (PR #19 レビュー指摘) ため、正の有限値は全て受理。
      final r = _repo();

      await r.repo.addItem(
        householdId: 'hh-1',
        userId: 'user-1',
        name: '塩',
        quantity: 1,
      );
      expect(r.table.lastInsertValues, isNotNull);

      await r.repo.addItem(
        householdId: 'hh-1',
        userId: 'user-1',
        name: '豚肉',
        quantity: 0.5,
      );
      final values = r.table.lastInsertValues as Map<String, dynamic>?;
      expect(values, isNotNull);
      expect(values!['quantity'], 0.5);
    });

    test('expiresAt が YYYY-MM-DD 形式でなければ ArgumentError', () async {
      final r = _repo();

      for (final expiresAt in ['2026-6-1', '2026/06/13', '13-06-2026', 'abc']) {
        await expectLater(
          r.repo.addItem(
            householdId: 'hh-1',
            userId: 'user-1',
            name: '塩',
            expiresAt: expiresAt,
          ),
          throwsA(isA<ArgumentError>()),
        );
      }
      expect(r.table.lastInsertValues, isNull);
    });

    test('insert の PostgrestException は握り潰されず rethrow される', () async {
      final r = _repo(
        mutationError: const PostgrestException(message: 'boom', code: '500'),
      );

      await expectLater(
        r.repo.addItem(householdId: 'hh-1', userId: 'user-1', name: '塩'),
        throwsA(isA<PostgrestException>()),
      );
    });
  });

  group('StockRepository.updateItem', () {
    test('household スコープ + .select(id).single() の行数検証つき update', () async {
      final r = _repo(singleValue: {'id': 'stock-1'});

      await r.repo.updateItem(
        householdId: 'hh-1',
        itemId: 'stock-1',
        name: '低脂肪牛乳',
        category: ItemCategory.dairy,
        quantity: 3,
        unit: '本',
        expiresAt: '2026-06-20',
      );

      // web updateStockItem の parsed 5 列と同一 (created_by は更新しない)。
      expect(r.table.lastUpdateValues, {
        'name': '低脂肪牛乳',
        'category': 'dairy',
        'quantity': 3,
        'unit': '本',
        'expires_at': '2026-06-20',
      });
      // household スコープ + .select('id').single() の行数検証
      // (CLAUDE.md「.update() は 0 行更新でも error: null」)。
      expect(r.mutation.eqFilters, [
        (column: 'id', value: 'stock-1'),
        (column: 'household_id', value: 'hh-1'),
      ]);
      expect(r.mutation.selectedColumns, 'id');
    });

    test('web が書いた小数 quantity を fetch→update しても値が変わらない', () async {
      // 回帰防止 (PR #19 レビュー指摘): 旧実装は int + round() で
      // 1.5 → 2 に丸め、別項目編集の保存で DB の 1.5 を 2 へ恒久破壊していた。
      // CLAUDE.md「外部APIレスポンスの値で既存値を破壊しない」。
      final r = _repo(
        rows: [
          {
            'id': 'stock-1',
            'household_id': 'hh-1',
            'name': '豚肉',
            'category': 'meat',
            'quantity': 1.5, // web (step=0.1) が保存した小数在庫
            'unit': 'kg',
            'expires_at': '2026-06-13',
            'created_by': 'user-1',
            'created_at': '2026-06-08T00:00:00+09:00',
            'updated_at': '2026-06-08T00:00:00+09:00',
          },
        ],
        singleValue: {'id': 'stock-1'},
      );

      final fetched = (await r.repo.fetchItems('hh-1')).single;
      expect(fetched.quantity, 1.5, reason: 'fetch で丸めない');

      // 期限だけ変えて保存する F6 の編集フロー相当 — quantity は fetch 値を
      // そのまま渡す。
      await r.repo.updateItem(
        householdId: 'hh-1',
        itemId: fetched.id,
        name: fetched.name,
        category: fetched.category,
        quantity: fetched.quantity,
        unit: fetched.unit,
        expiresAt: '2026-06-20',
      );

      final updated = r.table.lastUpdateValues;
      expect(updated, isNotNull);
      expect(updated!['quantity'], 1.5, reason: 'update の書き戻しでも丸めない');
    });

    test('対象 0 行 (他世帯/既削除) の PGRST116 は rethrow される', () async {
      // web の「在庫の更新に失敗しました」相当を UI 層が変換できるよう、
      // silent success にしない (行数検証の回帰防止)。
      final r = _repo(
        singleError: const PostgrestException(
          message: 'JSON object requested, multiple (or no) rows returned',
          code: 'PGRST116',
        ),
      );

      await expectLater(
        r.repo.updateItem(
          householdId: 'hh-other',
          itemId: 'stock-1',
          name: '牛乳',
        ),
        throwsA(
          isA<PostgrestException>().having((e) => e.code, 'code', 'PGRST116'),
        ),
      );
    });

    test('name 検証は update でも効く (ArgumentError で update に進まない)', () async {
      final r = _repo(singleValue: {'id': 'stock-1'});

      await expectLater(
        r.repo.updateItem(householdId: 'hh-1', itemId: 'stock-1', name: '  '),
        throwsA(isA<ArgumentError>()),
      );
      expect(r.table.lastUpdateValues, isNull);
    });
  });

  group('StockRepository.deleteItem', () {
    test('household スコープ付き delete (web deleteStockItem と同一)', () async {
      final r = _repo();

      await r.repo.deleteItem(householdId: 'hh-1', itemId: 'stock-1');

      expect(r.table.deleteCallCount, 1);
      expect(r.mutation.eqFilters, [
        (column: 'id', value: 'stock-1'),
        (column: 'household_id', value: 'hh-1'),
      ]);
    });

    test('delete の PostgrestException は握り潰されず rethrow される', () async {
      final r = _repo(
        mutationError: const PostgrestException(message: 'boom', code: '500'),
      );

      await expectLater(
        r.repo.deleteItem(householdId: 'hh-1', itemId: 'stock-1'),
        throwsA(isA<PostgrestException>()),
      );
    });
  });
}
