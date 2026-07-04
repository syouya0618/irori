import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/stock/domain/stock_item.dart';
import 'package:irori/features/stock/presentation/stock_display_utils.dart';

// name 昇順のみを検証するため category は既定で固定 (単一グループに集約)。
StockItem _item(String name, {ItemCategory category = ItemCategory.vegetable}) {
  return StockItem(
    id: 'stock-$name',
    householdId: 'hh-1',
    name: name,
    category: category,
    quantity: 1,
    createdBy: 'user-1',
    createdAt: DateTime.utc(2026, 6, 8),
  );
}

/// 単一カテゴリ前提で、そのグループ内の name 並び順を取り出す。
List<String> _sortedNames(List<StockItem> items) =>
    groupStockItems(items).single.$2.map((e) => e.name).toList();

void main() {
  group('groupStockItems の name 照合 (web localeCompare(_, "ja") 近似)', () {
    test('ひらがな/カタカナ混在でも五十音順に並ぶ (素の compareTo との差)', () {
      // 素の `String.compareTo` (UTF-16 コードユニット順) は全ひらがな <
      // 全カタカナ ゆえ たまねぎ・にんじん → キャベツ・ピーマン と割れる。
      // カタカナ→ひらがな畳み込みで キャ(き) < た < に < ピ(ぴ) と交互に並ぶ。
      final items = [
        _item('ピーマン'),
        _item('にんじん'),
        _item('キャベツ'),
        _item('たまねぎ'),
      ];
      expect(_sortedNames(items), [
        'キャベツ',
        'たまねぎ',
        'にんじん',
        'ピーマン',
      ]);
    });

    test('五十音順は入力順に依らず決定的 (sort が実際に並べ替える)', () {
      // 逆順・別順で投入しても同一結果になること (`..sort` が効いている証左)。
      final reversed = [
        _item('たまねぎ'),
        _item('キャベツ'),
        _item('にんじん'),
        _item('ピーマン'),
      ];
      expect(_sortedNames(reversed), [
        'キャベツ',
        'たまねぎ',
        'にんじん',
        'ピーマン',
      ]);
    });

    group('長音符 (ー) の ゜化け回帰防御 (畳み込みスコープ)', () {
      // 直接検証: カタカナブロック全体を一律 -0x60 する実装だと ー (U+30FC) が
      // ゜ (U+309C) へ化ける。写像範囲を U+30A1–U+30F6 に限定していれば ー は
      // 素通しされ、照合キーに ゜ は現れない。
      test('hiraganaSortKey は ー を畳まず素通しする (゜化けしない)', () {
        expect(hiraganaSortKey('バター'), 'ばたー');
        expect(hiraganaSortKey('ヨーグルト'), 'よーぐると');
        expect(hiraganaSortKey('ソーセージ'), 'そーせーじ');
        // ゜ (U+309C) が混入していないこと (ブロック一律畳み込みなら 'ばた゜')。
        expect(hiraganaSortKey('バター').contains('゜'), isFalse);
      });

      test('ー を含むカナ語も五十音順に並ぶ', () {
        final items = [
          _item('ヨーグルト'),
          _item('バター'),
          _item('ソーセージ'),
        ];
        // 先頭 そ(3053) < ば(3070) < よ(3088)。
        expect(_sortedNames(items), [
          'ソーセージ',
          'バター',
          'ヨーグルト',
        ]);
      });
    });

    test('あ / ア のタイは決定的 (ひらがな < カタカナ、入力順不問)', () {
      // 畳み込みで あ と ア のキーは同値。タイ時は元文字列 compareTo に
      // フォールバックするため あ (U+3042) < ア (U+30A2) で常に あ が先。
      // フォールバック無し (comparator が 0 を返す) だと List.sort は非安定で
      // 入力順を保つため、[ア, あ] 投入時に順序が壊れる。
      expect(_sortedNames([_item('ア'), _item('あ')]), ['あ', 'ア']);
      expect(_sortedNames([_item('あ'), _item('ア')]), ['あ', 'ア']);
    });
  });
}
