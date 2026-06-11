import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/meals/domain/meal_template.dart';

void main() {
  group('MealTemplate.fromJson (getTemplates select の row 形に 1:1)', () {
    test('正常 row が復元される', () {
      final tpl = MealTemplate.fromJson(<String, dynamic>{
        'id': 'tpl-1',
        'title': 'カレーライス',
        'ingredients': [
          {'name': 'にんじん', 'quantity': '2本', 'category': 'vegetable'},
          {'name': '豚肉', 'quantity': null, 'category': 'meat'},
        ],
        'created_at': '2026-06-10T12:34:56+00:00',
      });

      expect(tpl.id, 'tpl-1');
      expect(tpl.title, 'カレーライス');
      expect(tpl.ingredients, hasLength(2));
      expect(tpl.ingredients[0].name, 'にんじん');
      expect(tpl.ingredients[0].quantity, '2本');
      expect(tpl.ingredients[0].category, ItemCategory.vegetable);
      expect(tpl.ingredients[1].quantity, isNull);
      expect(tpl.ingredients[1].category, ItemCategory.meat);
      expect(tpl.createdAt, DateTime.parse('2026-06-10T12:34:56+00:00'));
    });
  });

  group('ingredients JSONB の防御的パース (web 無検証 cast の Dart 置換)', () {
    // web actions.ts:329 は `as unknown as MealIngredientInput[]` の無検証
    // cast。Dart では 1 行の破損 JSONB がダイアログ全体を AsyncError に
    // 倒すため (p25plan risks)、壊れた shape は空リスト / 要素 skip に倒す。
    MealTemplate parse(Object? ingredients) =>
        MealTemplate.fromJson(<String, dynamic>{
          'id': 'tpl-x',
          'title': '壊れ検証',
          'ingredients': ingredients,
          'created_at': '2026-06-10T00:00:00+00:00',
        });

    test('非配列 (文字列) は空リストに倒れる', () {
      expect(parse('["name":"壊"]').ingredients, isEmpty);
    });

    test('非配列 (オブジェクト) は空リストに倒れる', () {
      expect(
        parse(<String, dynamic>{'name': 'にんじん'}).ingredients,
        isEmpty,
      );
    });

    test('null は空リストに倒れる', () {
      expect(parse(null).ingredients, isEmpty);
    });

    test('キー欠落でも空リストに倒れる', () {
      final tpl = MealTemplate.fromJson(<String, dynamic>{
        'id': 'tpl-x',
        'title': 'キー欠落',
        'created_at': '2026-06-10T00:00:00+00:00',
      });
      expect(tpl.ingredients, isEmpty);
    });

    test('要素の category 欠落/未知/非文字列は otherDaily に fallback する', () {
      final tpl = parse([
        {'name': 'にんじん', 'quantity': '2本'}, // category 欠落
        {'name': '豚肉', 'quantity': null, 'category': 'mystery_meat'}, // 未知
        {'name': '卵', 'quantity': null, 'category': 123}, // 非文字列
      ]);

      expect(tpl.ingredients, hasLength(3));
      expect(tpl.ingredients[0].category, ItemCategory.otherDaily);
      expect(tpl.ingredients[1].category, ItemCategory.otherDaily);
      expect(tpl.ingredients[2].category, ItemCategory.otherDaily);
    });

    test('Map でない要素は skip され正常要素は生きる', () {
      final tpl = parse([
        'ただの文字列',
        42,
        null,
        {'name': 'にんじん', 'quantity': '2本', 'category': 'vegetable'},
      ]);

      expect(tpl.ingredients, hasLength(1));
      expect(tpl.ingredients.single.name, 'にんじん');
    });

    test('name が壊れた要素 (欠落/非文字列) は skip され正常要素は生きる', () {
      final tpl = parse([
        {'quantity': '2本', 'category': 'vegetable'}, // name 欠落
        {'name': 999, 'category': 'meat'}, // name 非文字列
        {'name': '豚肉', 'quantity': null, 'category': 'meat'},
      ]);

      expect(tpl.ingredients, hasLength(1));
      expect(tpl.ingredients.single.name, '豚肉');
    });
  });
}
