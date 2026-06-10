import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/stock/domain/stock_item.dart';

void main() {
  group('StockItem.fromJson (stock_items.Row に 1:1)', () {
    test('一覧 select の row 形が復元される', () {
      // `StockRepository._kStockItemColumns` が返す生 JSON 形
      // (snake_case + ENUM 文字列 + DATE/timestamptz 文字列)。
      final json = <String, dynamic>{
        'id': 'stock-1',
        'household_id': 'hh-1',
        'name': '牛乳',
        'category': 'dairy',
        'quantity': 2,
        'unit': '本',
        'expires_at': '2026-06-13',
        'created_by': 'user-1',
        'created_at': '2026-06-08T00:00:00+09:00',
        'updated_at': '2026-06-09T00:00:00+09:00',
      };

      final item = StockItem.fromJson(json);

      expect(item.id, 'stock-1');
      expect(item.householdId, 'hh-1');
      expect(item.name, '牛乳');
      expect(item.category, ItemCategory.dairy);
      expect(item.quantity, 2);
      expect(item.unit, '本');
      // expires_at は DATE 列の 'YYYY-MM-DD' を String のまま保持 (UTC 罠回避)。
      expect(item.expiresAt, '2026-06-13');
      expect(item.createdBy, 'user-1');
      expect(item.createdAt, DateTime.parse('2026-06-08T00:00:00+09:00'));
      expect(item.updatedAt, DateTime.parse('2026-06-09T00:00:00+09:00'));
    });

    test('nullable 列 (unit / expires_at) が null でも復元される', () {
      final item = StockItem.fromJson(<String, dynamic>{
        'id': 'stock-2',
        'household_id': 'hh-1',
        'name': '塩',
        'category': 'seasoning',
        'quantity': 1,
        'unit': null,
        'expires_at': null,
        'created_by': 'user-1',
        'created_at': '2026-06-08T00:00:00+09:00',
        'updated_at': null,
      });

      expect(item.unit, isNull);
      expect(item.expiresAt, isNull);
      expect(item.updatedAt, isNull);
    });

    test('updated_at キーが欠落しても null になる (realtime payload 防御)', () {
      final item = StockItem.fromJson(<String, dynamic>{
        'id': 'stock-3',
        'household_id': 'hh-1',
        'name': '卵',
        'category': 'egg',
        'quantity': 10,
        'created_by': 'user-1',
        'created_at': '2026-06-08T00:00:00+09:00',
      });

      expect(item.updatedAt, isNull);
      expect(item.unit, isNull);
      expect(item.expiresAt, isNull);
    });
  });

  group('StockItem.fromJson の category tolerant パース', () {
    StockItem parse(Object? category) => StockItem.fromJson(<String, dynamic>{
      'id': 'x',
      'household_id': 'hh-1',
      'name': '何か',
      'category': category,
      'quantity': 1,
      'created_by': 'u',
      'created_at': '2026-06-08T00:00:00+09:00',
    });

    test('既知の category 文字列は対応する enum に復元される', () {
      expect(parse('vegetable').category, ItemCategory.vegetable);
      expect(parse('snack_food').category, ItemCategory.snackFood);
      expect(parse('other_daily').category, ItemCategory.otherDaily);
    });

    test('未知の category は throw せず otherDaily に fallback する', () {
      // ENUM 追加等の schema drift 1 行で在庫一覧全体の fetch を
      // AsyncError に倒さない (F0 ItemCategory.fromDbValue の方針)。
      expect(parse('mystery_meat').category, ItemCategory.otherDaily);
    });

    test('category が null / 非文字列でも otherDaily に fallback する', () {
      expect(parse(null).category, ItemCategory.otherDaily);
      expect(parse(123).category, ItemCategory.otherDaily);
    });
  });

  group('StockItem.fromJson の quantity tolerant パース (NUMERIC 列)', () {
    StockItem parse(Object? quantity) => StockItem.fromJson(<String, dynamic>{
      'id': 'x',
      'household_id': 'hh-1',
      'name': '何か',
      'category': 'other_food',
      'quantity': quantity,
      'created_by': 'u',
      'created_at': '2026-06-08T00:00:00+09:00',
    });

    test('int はそのまま', () {
      expect(parse(3).quantity, 3);
    });

    test('double (web は step=0.1 で小数を保存しうる) は round される', () {
      expect(parse(2.5).quantity, 3);
      expect(parse(1.4).quantity, 1);
      expect(parse(0.5).quantity, 1);
    });

    test('引用符付き文字列 (PostgREST の numeric 列挙動) もパースされる', () {
      // baby_log.dart `_numericFromJson` で確認済みの PostgREST 挙動。
      expect(parse('2').quantity, 2);
      expect(parse('0.5').quantity, 1);
    });

    test('null / パース不能は web `|| 1` / DB DEFAULT 1 と同じ 1 に fallback', () {
      expect(parse(null).quantity, 1);
      expect(parse('abc').quantity, 1);
    });
  });

  group('StockItem.toJson', () {
    test('snake_case の DB 列名で出力される (realtime payload 構築に使う)', () {
      final item = StockItem(
        id: 'stock-1',
        householdId: 'hh-1',
        name: '牛乳',
        category: ItemCategory.dairy,
        quantity: 2,
        unit: '本',
        expiresAt: '2026-06-13',
        createdBy: 'user-1',
        createdAt: DateTime.utc(2026, 6, 8),
      );

      final json = item.toJson();

      expect(json['household_id'], 'hh-1');
      expect(json['category'], 'dairy');
      expect(json['expires_at'], '2026-06-13');
      expect(json['created_by'], 'user-1');
      // roundtrip で同値に戻る (notifier テストの payload 構築経路を保証)。
      expect(StockItem.fromJson(json), item);
    });
  });
}
