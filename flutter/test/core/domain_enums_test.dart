import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/core/domain/store_type.dart';
import 'package:irori/widgets/category_icon.dart';

/// Phase 2 共有 enum (F0) のテスト。
///
/// DB 文字列・日本語ラベル・表示順は Next.js 原典
/// (`src/lib/types/database.ts` / `src/lib/utils/categories.ts`) との
/// 1:1 一致を期待値ベタ書きで固定する (web 側との drift 検出が目的のため、
/// 実装と同じ導出ロジックを共有しない)。
void main() {
  group('ItemCategory (item_category ENUM 15 値)', () {
    // 原典: src/lib/types/database.ts の ItemCategory union (15 値) と
    // src/lib/utils/categories.ts の categoryLabels。
    const expected = <ItemCategory, ({String db, String label})>{
      ItemCategory.vegetable: (db: 'vegetable', label: '野菜'),
      ItemCategory.fruit: (db: 'fruit', label: '果物'),
      ItemCategory.meat: (db: 'meat', label: '肉'),
      ItemCategory.fish: (db: 'fish', label: '魚介'),
      ItemCategory.dairy: (db: 'dairy', label: '乳製品'),
      ItemCategory.egg: (db: 'egg', label: '卵'),
      ItemCategory.grain: (db: 'grain', label: '穀物'),
      ItemCategory.seasoning: (db: 'seasoning', label: '調味料'),
      ItemCategory.frozen: (db: 'frozen', label: '冷凍'),
      ItemCategory.snackFood: (db: 'snack_food', label: 'お菓子'),
      ItemCategory.otherFood: (db: 'other_food', label: 'その他食品'),
      ItemCategory.baby: (db: 'baby', label: 'ベビー'),
      ItemCategory.cleaning: (db: 'cleaning', label: '洗剤'),
      ItemCategory.hygiene: (db: 'hygiene', label: '衛生用品'),
      ItemCategory.otherDaily: (db: 'other_daily', label: 'その他'),
    };

    test('値は 15 個 (web ItemCategory union と同数)', () {
      expect(ItemCategory.values, hasLength(15));
      expect(expected.keys.toSet(), ItemCategory.values.toSet());
    });

    test('dbValue が web の DB 文字列と全件一致する', () {
      for (final entry in expected.entries) {
        expect(
          entry.key.dbValue,
          entry.value.db,
          reason: '${entry.key} の dbValue が原典と不一致',
        );
      }
    });

    test('label が web categoryLabels と全件一致する (非空も兼ねる)', () {
      for (final entry in expected.entries) {
        expect(
          entry.key.label,
          entry.value.label,
          reason: '${entry.key} の label が原典と不一致',
        );
        expect(entry.key.label, isNotEmpty);
      }
    });

    test('dbValue → fromDbValue の往復が全値で成立する', () {
      for (final category in ItemCategory.values) {
        expect(ItemCategory.fromDbValue(category.dbValue), category);
      }
    });

    test('fromDbValue は未知値を otherDaily に fallback する (tolerant)', () {
      // 原典 getCategoryLabel の `?? "その他"` と同方針。
      expect(
        ItemCategory.fromDbValue('unknown_value'),
        ItemCategory.otherDaily,
      );
      expect(ItemCategory.fromDbValue(''), ItemCategory.otherDaily);
    });

    test('displayOrder が web categoryDisplayOrder と同順・全値網羅・重複なし', () {
      const webOrder = [
        ItemCategory.vegetable,
        ItemCategory.fruit,
        ItemCategory.meat,
        ItemCategory.fish,
        ItemCategory.dairy,
        ItemCategory.egg,
        ItemCategory.grain,
        ItemCategory.seasoning,
        ItemCategory.frozen,
        ItemCategory.snackFood,
        ItemCategory.otherFood,
        ItemCategory.baby,
        ItemCategory.cleaning,
        ItemCategory.hygiene,
        ItemCategory.otherDaily,
      ];
      expect(ItemCategory.displayOrder, webOrder);
      expect(ItemCategory.displayOrder.toSet(), ItemCategory.values.toSet());
      expect(
        ItemCategory.displayOrder.toSet(),
        hasLength(ItemCategory.displayOrder.length),
      );
    });
  });

  group('StoreType (store_type ENUM 5 値)', () {
    // 原典: src/lib/types/database.ts の StoreType union (5 値) と
    // src/lib/utils/categories.ts の storeLabels / allStores。
    const expected = <StoreType, ({String db, String label})>{
      StoreType.supermarket: (db: 'supermarket', label: 'スーパー'),
      StoreType.drugstore: (db: 'drugstore', label: 'ドラッグストア'),
      StoreType.convenience: (db: 'convenience', label: 'コンビニ'),
      StoreType.online: (db: 'online', label: 'ネット'),
      StoreType.other: (db: 'other', label: 'その他'),
    };

    test('値は 5 個 (web StoreType union と同数)', () {
      expect(StoreType.values, hasLength(5));
      expect(expected.keys.toSet(), StoreType.values.toSet());
    });

    test('dbValue / label が web と全件一致する', () {
      for (final entry in expected.entries) {
        expect(entry.key.dbValue, entry.value.db);
        expect(entry.key.label, entry.value.label);
        expect(entry.key.label, isNotEmpty);
      }
    });

    test('dbValue → fromDbValue の往復が全値で成立する', () {
      for (final store in StoreType.values) {
        expect(StoreType.fromDbValue(store.dbValue), store);
      }
    });

    test('fromDbValue は未知値を other に fallback する (tolerant)', () {
      expect(StoreType.fromDbValue('department_store'), StoreType.other);
      expect(StoreType.fromDbValue(''), StoreType.other);
    });

    test('displayOrder が web allStores と同順・全値網羅', () {
      expect(StoreType.displayOrder, const [
        StoreType.supermarket,
        StoreType.drugstore,
        StoreType.convenience,
        StoreType.online,
        StoreType.other,
      ]);
      expect(StoreType.displayOrder.toSet(), StoreType.values.toSet());
    });
  });

  group('categoryIcon (web categoryIcons の Lucide 再現)', () {
    test('全 15 カテゴリで IconData を返す', () {
      for (final category in ItemCategory.values) {
        expect(categoryIcon(category), isA<IconData>());
      }
    });

    test('アイコンは全カテゴリで相異なる (コピペ重複の検出)', () {
      // 原典 shopping-list.tsx / stock-list.tsx の categoryIcons は
      // 15 カテゴリすべてに別アイコンを割り当てている。
      final icons = ItemCategory.values.map(categoryIcon).toSet();
      expect(icons, hasLength(ItemCategory.values.length));
    });
  });
}
