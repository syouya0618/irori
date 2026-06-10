import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/domain/store_type.dart';
import 'package:irori/features/shopping/domain/shopping_item.dart';

void main() {
  group('ShoppingItem.fromJson (shopping_items.Row 13 列に 1:1)', () {
    test('全列が埋まった行 (Realtime payload のフル行形) が復元される', () {
      // database.ts `shopping_items.Row` の生 JSON 形
      // (snake_case + ENUM 文字列 + timestamptz ISO 文字列)。
      final json = <String, dynamic>{
        'id': 'item-1',
        'household_id': 'hh-1',
        'name': '牛乳',
        'quantity': '2本',
        'category': 'dairy',
        'store_type': 'supermarket',
        'is_checked': true,
        'checked_by': 'user-2',
        'checked_at': '2026-06-08T10:30:00+00:00',
        'meal_id': 'meal-1',
        'sort_order': 5,
        'created_by': 'user-1',
        'created_at': '2026-06-08T09:00:00+00:00',
      };

      final item = ShoppingItem.fromJson(json);

      expect(item.id, 'item-1');
      expect(item.householdId, 'hh-1');
      expect(item.name, '牛乳');
      expect(item.quantity, '2本');
      expect(item.category, ItemCategory.dairy);
      expect(item.storeType, StoreType.supermarket);
      expect(item.isChecked, isTrue);
      expect(item.checkedBy, 'user-2');
      expect(item.checkedAt, DateTime.utc(2026, 6, 8, 10, 30));
      expect(item.mealId, 'meal-1');
      expect(item.sortOrder, 5);
      expect(item.createdBy, 'user-1');
      expect(item.createdAt, DateTime.utc(2026, 6, 8, 9));
    });

    test('null 許容列 (quantity/checked_by/checked_at/meal_id) の明示 null', () {
      final item = ShoppingItem.fromJson(<String, dynamic>{
        'id': 'item-2',
        'household_id': 'hh-1',
        'name': '卵',
        'quantity': null,
        'category': 'egg',
        'store_type': 'convenience',
        'is_checked': false,
        'checked_by': null,
        'checked_at': null,
        'meal_id': null,
        'sort_order': 1,
        'created_by': 'user-1',
        'created_at': '2026-06-08T09:00:00+00:00',
      });

      expect(item.quantity, isNull);
      expect(item.isChecked, isFalse);
      expect(item.checkedBy, isNull);
      expect(item.checkedAt, isNull);
      expect(item.mealId, isNull);
    });

    test('null 許容列はキー欠落でも null になる', () {
      final item = ShoppingItem.fromJson(<String, dynamic>{
        'id': 'item-3',
        'household_id': 'hh-1',
        'name': 'パン',
        'category': 'grain',
        'store_type': 'supermarket',
        'is_checked': false,
        'sort_order': 2,
        'created_by': 'user-1',
        'created_at': '2026-06-08T09:00:00+00:00',
      });

      expect(item.quantity, isNull);
      expect(item.checkedBy, isNull);
      expect(item.checkedAt, isNull);
      expect(item.mealId, isNull);
    });

    test('toJson は snake_case + ENUM 文字列の行形に戻る (payload 構築用)', () {
      // notifier テストが realtime payload を `item.toJson()` で構築するため、
      // fromJson(toJson(x)) == x の roundtrip を保証しておく。
      final item = ShoppingItem(
        id: 'item-4',
        householdId: 'hh-1',
        name: 'ヨーグルト',
        quantity: '1個',
        category: ItemCategory.dairy,
        storeType: StoreType.drugstore,
        isChecked: true,
        checkedBy: 'user-2',
        checkedAt: DateTime.utc(2026, 6, 8, 10, 30),
        mealId: null,
        sortOrder: 3,
        createdBy: 'user-1',
        createdAt: DateTime.utc(2026, 6, 8, 9),
      );

      final json = item.toJson();
      expect(json['household_id'], 'hh-1');
      expect(json['category'], 'dairy');
      expect(json['store_type'], 'drugstore');
      expect(json['is_checked'], true);
      expect(json['sort_order'], 3);

      expect(ShoppingItem.fromJson(json), item);
    });
  });

  group('ShoppingItem の tolerant ENUM パース (F0/F1 流儀)', () {
    ShoppingItem parse({Object? category, Object? storeType}) =>
        ShoppingItem.fromJson(<String, dynamic>{
          'id': 'x',
          'household_id': 'hh-1',
          'name': '何か',
          'category': category,
          'store_type': storeType,
          'is_checked': false,
          'sort_order': 1,
          'created_by': 'user-1',
          'created_at': '2026-06-08T09:00:00+00:00',
        });

    test('既知の category / store_type 文字列は対応する enum に復元される', () {
      final item = parse(category: 'snack_food', storeType: 'online');
      expect(item.category, ItemCategory.snackFood);
      expect(item.storeType, StoreType.online);
    });

    test('未知の category は throw せず otherDaily に fallback する', () {
      // ENUM 追加等の schema drift 1 行でリスト全体の fetch を
      // AsyncError に倒さない (F0 fromDbValue の方針)。
      final item = parse(category: 'mystery_meat', storeType: 'supermarket');
      expect(item.category, ItemCategory.otherDaily);
    });

    test('未知の store_type は throw せず other に fallback する', () {
      final item = parse(category: 'vegetable', storeType: 'space_station');
      expect(item.storeType, StoreType.other);
    });

    test('category / store_type が null・非文字列でも fallback する', () {
      expect(
        parse(category: null, storeType: null).category,
        ItemCategory.otherDaily,
      );
      expect(parse(category: null, storeType: null).storeType, StoreType.other);
      expect(
        parse(category: 123, storeType: 456).category,
        ItemCategory.otherDaily,
      );
      expect(parse(category: 123, storeType: 456).storeType, StoreType.other);
    });
  });
}
