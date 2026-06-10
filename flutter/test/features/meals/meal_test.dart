import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/meals/domain/meal.dart';

void main() {
  group('Meal.fromJson (週 select の row 形に 1:1)', () {
    test('nested reactions/ingredients 込みの行が復元される', () {
      // Next.js 版 page.tsx の週 select が返す生 JSON 形
      // (snake_case + nested 配列 + ENUM 文字列)。
      final json = <String, dynamic>{
        'id': 'meal-1',
        'date': '2026-06-08',
        'meal_type': 'dinner',
        'title': 'カレーライス',
        'is_eating_out': false,
        'template_id': 'tpl-1',
        'meal_reactions': [
          {'user_id': 'user-1', 'reaction': 'good'},
          {'user_id': 'user-2', 'reaction': 'ok'},
        ],
        'meal_ingredients': [
          {'name': 'にんじん', 'quantity': '2本', 'category': 'vegetable'},
          {'name': '豚肉', 'quantity': null, 'category': 'meat'},
        ],
      };

      final meal = Meal.fromJson(json);

      expect(meal.id, 'meal-1');
      // date は 'YYYY-MM-DD' の String のまま (UTC 罠回避)。
      expect(meal.date, '2026-06-08');
      expect(meal.mealType, MealType.dinner);
      expect(meal.title, 'カレーライス');
      expect(meal.isEatingOut, isFalse);
      expect(meal.templateId, 'tpl-1');

      expect(meal.reactions, hasLength(2));
      expect(meal.reactions[0].userId, 'user-1');
      expect(meal.reactions[0].reaction, MealReaction.good);
      expect(meal.reactions[1].reaction, MealReaction.ok);

      expect(meal.ingredients, hasLength(2));
      expect(meal.ingredients[0].name, 'にんじん');
      expect(meal.ingredients[0].quantity, '2本');
      expect(meal.ingredients[0].category, ItemCategory.vegetable);
      // quantity は nullable TEXT。
      expect(meal.ingredients[1].quantity, isNull);
      expect(meal.ingredients[1].category, ItemCategory.meat);
    });

    test('nested キーが欠落しても defaultValue の空リストになる', () {
      // realtime payload (親行のみ) 等で nested が来ないケースの防御。
      final meal = Meal.fromJson(<String, dynamic>{
        'id': 'meal-2',
        'date': '2026-06-09',
        'meal_type': 'lunch',
        'title': 'うどん',
        'is_eating_out': true,
      });

      expect(meal.reactions, isEmpty);
      expect(meal.ingredients, isEmpty);
      // template_id 欠落 → null。
      expect(meal.templateId, isNull);
      expect(meal.isEatingOut, isTrue);
    });

    test('nested キーが明示 null でも空リストになる', () {
      final meal = Meal.fromJson(<String, dynamic>{
        'id': 'meal-3',
        'date': '2026-06-10',
        'meal_type': 'breakfast',
        'title': 'トースト',
        'is_eating_out': false,
        'template_id': null,
        'meal_reactions': null,
        'meal_ingredients': null,
      });

      expect(meal.reactions, isEmpty);
      expect(meal.ingredients, isEmpty);
      expect(meal.templateId, isNull);
    });

    test('全 meal_type / meal_reaction が JsonValue でマッピングされている', () {
      Meal parse(String type) => Meal.fromJson(<String, dynamic>{
        'id': 'x',
        'date': '2026-06-08',
        'meal_type': type,
        'title': 't',
        'is_eating_out': false,
      });

      expect(parse('breakfast').mealType, MealType.breakfast);
      expect(parse('lunch').mealType, MealType.lunch);
      expect(parse('dinner').mealType, MealType.dinner);
      expect(parse('snack').mealType, MealType.snack);

      MealReactionEntry parseReaction(String reaction) =>
          MealReactionEntry.fromJson(<String, dynamic>{
            'user_id': 'u',
            'reaction': reaction,
          });

      expect(parseReaction('good').reaction, MealReaction.good);
      expect(parseReaction('ok').reaction, MealReaction.ok);
      expect(parseReaction('bad').reaction, MealReaction.bad);
    });
  });

  group('MealIngredient.fromJson の category tolerant パース', () {
    MealIngredient parse(Object? category) =>
        MealIngredient.fromJson(<String, dynamic>{
          'name': '何か',
          'quantity': null,
          'category': category,
        });

    test('既知の category 文字列は対応する enum に復元される', () {
      expect(parse('vegetable').category, ItemCategory.vegetable);
      expect(parse('snack_food').category, ItemCategory.snackFood);
      expect(parse('other_daily').category, ItemCategory.otherDaily);
    });

    test('未知の category は throw せず otherDaily に fallback する', () {
      // ENUM 追加等の schema drift 1 行で週全体の fetch を
      // AsyncError に倒さない (F0 ItemCategory.fromDbValue の方針)。
      expect(parse('mystery_meat').category, ItemCategory.otherDaily);
    });

    test('category が null / 非文字列でも otherDaily に fallback する', () {
      expect(parse(null).category, ItemCategory.otherDaily);
      expect(parse(123).category, ItemCategory.otherDaily);
    });
  });
}
