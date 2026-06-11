import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/item_category.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:irori/features/meals/domain/meal_template.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

/// Next.js 版 page.tsx の週 select と一字一句同一であるべき文字列
/// (リポジトリ実装と独立にテスト側でも正を持ち、改変を検出する)。
const _kExpectedWeekColumns =
    'id, date, meal_type, title, is_eating_out, template_id, '
    'meal_reactions(user_id, reaction), '
    'meal_ingredients(name, quantity, category)';

/// meals / meal_ingredients / meal_reactions / meal_templates の
/// 4 テーブル fake 一式。
({
  MealsRepository repo,
  FakeSupabaseClient client,
  FakeQueryBuilder meals,
  FakeFilterBuilder mealsRead,
  FakeFilterBuilder mealsMutation,
  FakeQueryBuilder ingredients,
  FakeFilterBuilder ingredientsRead,
  FakeFilterBuilder ingredientsMutation,
  FakeQueryBuilder reactions,
  FakeFilterBuilder reactionsRead,
  FakeFilterBuilder reactionsMutation,
  FakeQueryBuilder templates,
  FakeFilterBuilder templatesRead,
  FakeFilterBuilder templatesMutation,
})
_repo({
  PostgrestList mealsRows = const [],
  PostgrestMap? mealsReadSingleValue,
  Object? mealsReadSingleError,
  PostgrestMap? mealsSingleValue,
  Object? mealsSingleError,
  Object? mealsMutationError,
  PostgrestList ingredientsRows = const [],
  Object? ingredientsReadError,
  PostgrestMap? reactionMaybeSingleValue,
  Object? reactionMaybeSingleError,
  PostgrestMap? reactionSingleValue,
  PostgrestList templatesRows = const [],
  Object? templatesReadError,
  PostgrestMap? templatesReadSingleValue,
  Object? templatesReadSingleError,
  PostgrestMap? templatesSingleValue,
  Object? templatesSingleError,
}) {
  final mealsRead = FakeFilterBuilder(
    cannedValue: mealsRows,
    // saveAsTemplate の title lookup (household スコープ + single) 用。
    singleValue: mealsReadSingleValue,
    singleError: mealsReadSingleError,
  );
  final mealsMutation = FakeFilterBuilder(
    cannedValue: const [],
    // deleteTemplate の unlink update (single 無し await) の失敗注入用。
    cannedError: mealsMutationError,
    singleValue: mealsSingleValue,
    singleError: mealsSingleError,
  );
  final meals = FakeQueryBuilder(mealsRead, mutationFilter: mealsMutation);

  final ingredientsRead = FakeFilterBuilder(
    cannedValue: ingredientsRows,
    cannedError: ingredientsReadError,
  );
  final ingredientsMutation = FakeFilterBuilder(cannedValue: const []);
  final ingredients = FakeQueryBuilder(
    ingredientsRead,
    mutationFilter: ingredientsMutation,
  );

  final reactionsRead = FakeFilterBuilder(
    cannedValue: const [],
    maybeSingleValue: reactionMaybeSingleValue,
    maybeSingleError: reactionMaybeSingleError,
  );
  final reactionsMutation = FakeFilterBuilder(
    cannedValue: const [],
    singleValue: reactionSingleValue,
  );
  final reactions = FakeQueryBuilder(
    reactionsRead,
    mutationFilter: reactionsMutation,
  );

  final templatesRead = FakeFilterBuilder(
    cannedValue: templatesRows,
    cannedError: templatesReadError,
    // loadTemplate の single 取得用。
    singleValue: templatesReadSingleValue,
    singleError: templatesReadSingleError,
  );
  final templatesMutation = FakeFilterBuilder(
    cannedValue: const [],
    // saveAsTemplate の insert .select('id').single() と
    // deleteTemplate の delete .select('id').single() の両方が使う。
    singleValue: templatesSingleValue,
    singleError: templatesSingleError,
  );
  final templates = FakeQueryBuilder(
    templatesRead,
    mutationFilter: templatesMutation,
  );

  final client = FakeSupabaseClient(
    fromBuilders: {
      'meals': meals,
      'meal_ingredients': ingredients,
      'meal_reactions': reactions,
      'meal_templates': templates,
    },
  );
  return (
    repo: MealsRepository(client),
    client: client,
    meals: meals,
    mealsRead: mealsRead,
    mealsMutation: mealsMutation,
    ingredients: ingredients,
    ingredientsRead: ingredientsRead,
    ingredientsMutation: ingredientsMutation,
    reactions: reactions,
    reactionsRead: reactionsRead,
    reactionsMutation: reactionsMutation,
    templates: templates,
    templatesRead: templatesRead,
    templatesMutation: templatesMutation,
  );
}

const _ingredients = [
  MealIngredient(
    name: 'にんじん',
    quantity: '2本',
    category: ItemCategory.vegetable,
  ),
  // 空文字 quantity は web (`ing.quantity || null`) と同じく null へ正規化される。
  MealIngredient(name: '豚肉', quantity: '', category: ItemCategory.meat),
];

void main() {
  group('MealsRepository.fetchWeekMeals', () {
    test('select 文字列が web 版 page.tsx と一字一句同一である', () async {
      final r = _repo();

      await r.repo.fetchWeekMeals('hh-1', '2026-06-08');

      expect(r.meals.lastSelectColumns, _kExpectedWeekColumns);
    });

    test('household eq + 週境界 gte/lte + date 昇順 order で絞る', () async {
      final r = _repo();

      await r.repo.fetchWeekMeals('hh-1', '2026-06-08');

      expect(r.mealsRead.eqFilters, [
        (column: 'household_id', value: 'hh-1'),
      ]);
      expect(r.mealsRead.gteFilters, [(column: 'date', value: '2026-06-08')]);
      // weekEnd = shiftYmd(weekStart, 6) = 日曜。
      expect(r.mealsRead.lteFilters, [(column: 'date', value: '2026-06-14')]);
      // web の .order("date") は ascending — Dart 既定 (descending) のままだと
      // 週ビューの並びが逆転するため、明示 ascending を検証する。
      expect(r.mealsRead.orderCalls, [(column: 'date', ascending: true)]);
    });

    test('月跨ぎの週でも weekEnd が正しく +6 日になる', () async {
      final r = _repo();

      await r.repo.fetchWeekMeals('hh-1', '2026-06-29');

      expect(r.mealsRead.gteFilters, [(column: 'date', value: '2026-06-29')]);
      expect(r.mealsRead.lteFilters, [(column: 'date', value: '2026-07-05')]);
    });

    test('nested 込みの行を Meal に復元して返す', () async {
      final r = _repo(
        mealsRows: [
          {
            'id': 'meal-1',
            'date': '2026-06-08',
            'meal_type': 'dinner',
            'title': 'カレーライス',
            'is_eating_out': false,
            'template_id': null,
            'meal_reactions': [
              {'user_id': 'user-1', 'reaction': 'good'},
            ],
            'meal_ingredients': [
              {'name': 'にんじん', 'quantity': '2本', 'category': 'vegetable'},
            ],
          },
        ],
      );

      final meals = await r.repo.fetchWeekMeals('hh-1', '2026-06-08');

      expect(meals, hasLength(1));
      expect(meals.single.id, 'meal-1');
      expect(meals.single.reactions.single.reaction, MealReaction.good);
      expect(
        meals.single.ingredients.single.category,
        ItemCategory.vegetable,
      );
    });
  });

  group('MealsRepository.createMeal', () {
    test('meals insert → id 取得 → ingredients 一括 insert の順 (web 同順)', () async {
      final r = _repo(mealsSingleValue: {'id': 'meal-1'});

      final mealId = await r.repo.createMeal(
        householdId: 'hh-1',
        userId: 'user-1',
        date: '2026-06-08',
        mealType: MealType.dinner,
        title: 'カレーライス',
        isEatingOut: false,
        ingredients: _ingredients,
      );

      expect(mealId, 'meal-1');
      expect(r.client.fromTables, ['meals', 'meal_ingredients']);
      expect(r.meals.lastInsertValues, {
        'household_id': 'hh-1',
        'date': '2026-06-08',
        'meal_type': 'dinner',
        'title': 'カレーライス',
        'is_eating_out': false,
        'created_by': 'user-1',
      });
      // 返却行は id のみ取得する (web の .select("id").single())。
      expect(r.mealsMutation.selectedColumns, 'id');
      expect(r.ingredients.lastInsertValues, [
        {
          'meal_id': 'meal-1',
          'name': 'にんじん',
          'quantity': '2本',
          'category': 'vegetable',
        },
        {
          'meal_id': 'meal-1',
          'name': '豚肉',
          // 空文字は null に正規化 (web: `ing.quantity || null`)。
          'quantity': null,
          'category': 'meat',
        },
      ]);
    });

    test('ingredients が空なら meal_ingredients への insert を行わない', () async {
      final r = _repo(mealsSingleValue: {'id': 'meal-1'});

      await r.repo.createMeal(
        householdId: 'hh-1',
        userId: 'user-1',
        date: '2026-06-08',
        mealType: MealType.lunch,
        title: 'うどん',
        isEatingOut: false,
      );

      expect(r.client.fromTables, ['meals']);
      expect(r.ingredients.lastInsertValues, isNull);
    });

    test('23505 (スロット重複) は DuplicateMealException に変換される', () async {
      final r = _repo(
        mealsSingleError: const PostgrestException(
          message: 'duplicate key value violates unique constraint',
          code: '23505',
        ),
      );

      await expectLater(
        r.repo.createMeal(
          householdId: 'hh-1',
          userId: 'user-1',
          date: '2026-06-08',
          mealType: MealType.dinner,
          title: 'カレーライス',
          isEatingOut: false,
          ingredients: _ingredients,
        ),
        throwsA(isA<DuplicateMealException>()),
      );
      // 失敗後に ingredients insert へ進まない。
      expect(r.ingredients.lastInsertValues, isNull);
      // web actions.ts と同一文言。
      expect(DuplicateMealException.message, 'この日時のメニューは既に登録されています。');
    });

    test('23505 以外の PostgrestException はそのまま rethrow される', () async {
      final r = _repo(
        mealsSingleError: const PostgrestException(
          message: 'boom',
          code: '500',
        ),
      );

      await expectLater(
        r.repo.createMeal(
          householdId: 'hh-1',
          userId: 'user-1',
          date: '2026-06-08',
          mealType: MealType.dinner,
          title: 'カレーライス',
          isEatingOut: false,
        ),
        throwsA(
          isA<PostgrestException>().having((e) => e.code, 'code', '500'),
        ),
      );
    });
  });

  group('MealsRepository.updateMeal', () {
    test(
      'household スコープ + 行数検証つき update → ingredients delete → reinsert',
      () async {
        final r = _repo(mealsSingleValue: {'id': 'meal-1'});

        await r.repo.updateMeal(
          householdId: 'hh-1',
          mealId: 'meal-1',
          date: '2026-06-09',
          mealType: MealType.breakfast,
          title: 'トースト',
          isEatingOut: true,
          ingredients: _ingredients,
        );

        // web の順序: meals update → ingredients delete → reinsert。
        expect(r.client.fromTables, [
          'meals',
          'meal_ingredients',
          'meal_ingredients',
        ]);
        expect(r.meals.lastUpdateValues, {
          'date': '2026-06-09',
          'meal_type': 'breakfast',
          'title': 'トースト',
          'is_eating_out': true,
        });
        // household スコープ + .select('id').single() の行数検証
        // (CLAUDE.md「.update() は 0 行更新でも error: null」)。
        expect(r.mealsMutation.eqFilters, [
          (column: 'id', value: 'meal-1'),
          (column: 'household_id', value: 'hh-1'),
        ]);
        expect(r.mealsMutation.selectedColumns, 'id');
        expect(r.ingredients.deleteCallCount, 1);
        expect(r.ingredientsMutation.eqFilters, [
          (column: 'meal_id', value: 'meal-1'),
        ]);
        expect(r.ingredients.lastInsertValues, hasLength(2));
      },
    );

    test('23505 は DuplicateMealException に変換され ingredients は触らない', () async {
      final r = _repo(
        mealsSingleError: const PostgrestException(
          message: 'duplicate key value violates unique constraint',
          code: '23505',
        ),
      );

      await expectLater(
        r.repo.updateMeal(
          householdId: 'hh-1',
          mealId: 'meal-1',
          date: '2026-06-09',
          mealType: MealType.breakfast,
          title: 'トースト',
          isEatingOut: false,
          ingredients: _ingredients,
        ),
        throwsA(isA<DuplicateMealException>()),
      );
      expect(r.ingredients.deleteCallCount, 0);
      expect(r.ingredients.lastInsertValues, isNull);
    });

    test(
      '対象 0 行 (他世帯/既削除) の PGRST116 は rethrow され ingredients は触らない',
      () async {
        // web の ownership check (「この献立を編集する権限がありません。」) 相当。
        final r = _repo(
          mealsSingleError: const PostgrestException(
            message: 'JSON object requested, multiple (or no) rows returned',
            code: 'PGRST116',
          ),
        );

        await expectLater(
          r.repo.updateMeal(
            householdId: 'hh-other',
            mealId: 'meal-1',
            date: '2026-06-09',
            mealType: MealType.breakfast,
            title: 'トースト',
            isEatingOut: false,
          ),
          throwsA(
            isA<PostgrestException>().having((e) => e.code, 'code', 'PGRST116'),
          ),
        );
        expect(r.ingredients.deleteCallCount, 0);
      },
    );
  });

  group('MealsRepository.deleteMeal', () {
    test('web と同じ削除順: meal_ingredients → meal_reactions → meals', () async {
      final r = _repo(mealsSingleValue: {'id': 'meal-1'});

      await r.repo.deleteMeal(householdId: 'hh-1', mealId: 'meal-1');

      // eating_out_logs は明示削除しない (FK ON DELETE CASCADE — web 同様)。
      expect(r.client.fromTables, [
        'meal_ingredients',
        'meal_reactions',
        'meals',
      ]);
      expect(r.ingredients.deleteCallCount, 1);
      expect(r.ingredientsMutation.eqFilters, [
        (column: 'meal_id', value: 'meal-1'),
      ]);
      expect(r.reactions.deleteCallCount, 1);
      expect(r.reactionsMutation.eqFilters, [
        (column: 'meal_id', value: 'meal-1'),
      ]);
      expect(r.meals.deleteCallCount, 1);
      // meals 本体は household スコープ + 行数検証 (0 行 silent success 防止)。
      expect(r.mealsMutation.eqFilters, [
        (column: 'id', value: 'meal-1'),
        (column: 'household_id', value: 'hh-1'),
      ]);
      expect(r.mealsMutation.selectedColumns, 'id');
    });
  });

  group('MealsRepository.upsertReaction', () {
    test('既存なし → insert し removed=false を返す', () async {
      final r = _repo(reactionMaybeSingleValue: null);

      final removed = await r.repo.upsertReaction(
        mealId: 'meal-1',
        userId: 'user-1',
        reaction: MealReaction.good,
      );

      expect(removed, isFalse);
      // lookup は meal_id + user_id で絞り 'id, reaction' を取得 (web 同形)。
      expect(r.reactions.lastSelectColumns, 'id, reaction');
      expect(r.reactionsRead.eqFilters, [
        (column: 'meal_id', value: 'meal-1'),
        (column: 'user_id', value: 'user-1'),
      ]);
      expect(r.reactions.lastInsertValues, {
        'meal_id': 'meal-1',
        'user_id': 'user-1',
        'reaction': 'good',
      });
      expect(r.reactions.deleteCallCount, 0);
      expect(r.reactions.lastUpdateValues, isNull);
    });

    test('同一 reaction → delete (トグルオフ) し removed=true を返す', () async {
      final r = _repo(
        reactionMaybeSingleValue: {'id': 'react-1', 'reaction': 'good'},
      );

      final removed = await r.repo.upsertReaction(
        mealId: 'meal-1',
        userId: 'user-1',
        reaction: MealReaction.good,
      );

      expect(removed, isTrue);
      expect(r.reactions.deleteCallCount, 1);
      expect(r.reactionsMutation.eqFilters, [
        (column: 'id', value: 'react-1'),
      ]);
      expect(r.reactions.lastInsertValues, isNull);
      expect(r.reactions.lastUpdateValues, isNull);
    });

    test('異なる reaction → update (行数検証つき) し removed=false を返す', () async {
      final r = _repo(
        reactionMaybeSingleValue: {'id': 'react-1', 'reaction': 'ok'},
        reactionSingleValue: {'id': 'react-1'},
      );

      final removed = await r.repo.upsertReaction(
        mealId: 'meal-1',
        userId: 'user-1',
        reaction: MealReaction.bad,
      );

      expect(removed, isFalse);
      expect(r.reactions.lastUpdateValues, {'reaction': 'bad'});
      expect(r.reactionsMutation.eqFilters, [
        (column: 'id', value: 'react-1'),
      ]);
      // maybeSingle 後に行が消えるレースの 0 行更新を silent success に
      // しないための行数検証 (CLAUDE.md)。
      expect(r.reactionsMutation.selectedColumns, 'id');
      expect(r.reactions.deleteCallCount, 0);
      expect(r.reactions.lastInsertValues, isNull);
    });

    test('lookup の PostgrestException は握り潰されず rethrow され、書き込みに進まない', () async {
      final r = _repo(
        reactionMaybeSingleError: const PostgrestException(
          message: 'boom',
          code: '500',
        ),
      );

      await expectLater(
        r.repo.upsertReaction(
          mealId: 'meal-1',
          userId: 'user-1',
          reaction: MealReaction.good,
        ),
        throwsA(isA<PostgrestException>()),
      );
      expect(r.reactions.lastInsertValues, isNull);
      expect(r.reactions.lastUpdateValues, isNull);
      expect(r.reactions.deleteCallCount, 0);
    });
  });

  group('MealsRepository.saveAsTemplate', () {
    const ingredientRows = [
      {'name': 'にんじん', 'quantity': '2本', 'category': 'vegetable'},
      {'name': '豚肉', 'quantity': null, 'category': 'meat'},
    ];

    test(
      'web と同じ流れ: meals title 取得 → ingredients 取得 → templates insert → リンク update',
      () async {
        final r = _repo(
          mealsReadSingleValue: {'title': 'カレーライス'},
          ingredientsRows: ingredientRows,
          templatesSingleValue: {'id': 'tpl-1'},
          mealsSingleValue: {'id': 'meal-1'},
        );

        final templateId = await r.repo.saveAsTemplate(
          householdId: 'hh-1',
          userId: 'user-1',
          mealId: 'meal-1',
        );

        expect(templateId, 'tpl-1');
        // from() 呼び出し順 (web actions.ts saveAsTemplate と同順)。
        expect(r.client.fromTables, [
          'meals',
          'meal_ingredients',
          'meal_templates',
          'meals',
        ]);
        // title lookup は household スコープ + single
        // (web の app 層 ownership check を query 化)。
        expect(r.meals.lastSelectColumns, 'title');
        expect(r.mealsRead.eqFilters, [
          (column: 'id', value: 'meal-1'),
          (column: 'household_id', value: 'hh-1'),
        ]);
        // ingredients select は web と同一列。
        expect(r.ingredients.lastSelectColumns, 'name, quantity, category');
        expect(r.ingredientsRead.eqFilters, [
          (column: 'meal_id', value: 'meal-1'),
        ]);
        // insert payload: 取得した食材行をそのまま JSONB として渡す
        // (web の `ingredients || []` passthrough と同形)。
        expect(r.templates.lastInsertValues, {
          'household_id': 'hh-1',
          'title': 'カレーライス',
          'ingredients': ingredientRows,
          'created_by': 'user-1',
        });
        expect(r.templatesMutation.selectedColumns, 'id');
        // リンク update (meals.template_id)。
        expect(r.meals.lastUpdateValues, {'template_id': 'tpl-1'});
        expect(r.mealsMutation.eqFilters, [
          (column: 'id', value: 'meal-1'),
          (column: 'household_id', value: 'hh-1'),
        ]);
        expect(r.mealsMutation.selectedColumns, 'id');
      },
    );

    test('食材 0 件でも空配列 JSONB で保存される (web `ingredients || []`)', () async {
      final r = _repo(
        mealsReadSingleValue: {'title': 'うどん'},
        templatesSingleValue: {'id': 'tpl-2'},
        mealsSingleValue: {'id': 'meal-2'},
      );

      await r.repo.saveAsTemplate(
        householdId: 'hh-1',
        userId: 'user-1',
        mealId: 'meal-2',
      );

      expect(r.templates.lastInsertValues, {
        'household_id': 'hh-1',
        'title': 'うどん',
        'ingredients': <Map<String, dynamic>>[],
        'created_by': 'user-1',
      });
    });

    test('リンク update の失敗は throw されず templateId が返る (web parity)', () async {
      // web は `.error` を検証しない (actions.ts:295-298)。テンプレート自体は
      // 作成済みのため、リンク失敗で全体を失敗にしない。
      final r = _repo(
        mealsReadSingleValue: {'title': 'カレーライス'},
        ingredientsRows: ingredientRows,
        templatesSingleValue: {'id': 'tpl-1'},
        mealsSingleError: const PostgrestException(
          message: 'link update failed',
          code: '500',
        ),
      );

      final templateId = await r.repo.saveAsTemplate(
        householdId: 'hh-1',
        userId: 'user-1',
        mealId: 'meal-1',
      );

      expect(templateId, 'tpl-1');
      // リンク update 自体は試行されている。
      expect(r.meals.lastUpdateValues, {'template_id': 'tpl-1'});
    });

    test('対象献立 0 行 (他世帯/既削除) の PGRST116 は rethrow され insert に進まない', () async {
      // web の「この献立をテンプレートとして保存する権限がありません。」分岐に相当。
      final r = _repo(
        mealsReadSingleError: const PostgrestException(
          message: 'JSON object requested, multiple (or no) rows returned',
          code: 'PGRST116',
        ),
      );

      await expectLater(
        r.repo.saveAsTemplate(
          householdId: 'hh-other',
          userId: 'user-1',
          mealId: 'meal-1',
        ),
        throwsA(
          isA<PostgrestException>().having((e) => e.code, 'code', 'PGRST116'),
        ),
      );
      expect(r.templates.lastInsertValues, isNull);
    });

    test('食材取得の失敗は rethrow され、食材欠落テンプレートを作らない (意図的差異)', () async {
      // web は ingredientsError を log して空配列で保存を続行するが、
      // Dart は「食材が静かに欠落したテンプレート」を作らないため rethrow する。
      final r = _repo(
        mealsReadSingleValue: {'title': 'カレーライス'},
        ingredientsReadError: const PostgrestException(
          message: 'boom',
          code: '500',
        ),
      );

      await expectLater(
        r.repo.saveAsTemplate(
          householdId: 'hh-1',
          userId: 'user-1',
          mealId: 'meal-1',
        ),
        throwsA(isA<PostgrestException>()),
      );
      expect(r.templates.lastInsertValues, isNull);
    });
  });

  group('MealsRepository.getTemplates', () {
    test('household eq + created_at 降順で取得し MealTemplate に復元する', () async {
      final r = _repo(
        templatesRows: [
          {
            'id': 'tpl-1',
            'title': 'カレーライス',
            'ingredients': [
              {'name': 'にんじん', 'quantity': '2本', 'category': 'vegetable'},
            ],
            'created_at': '2026-06-10T12:00:00+00:00',
          },
          {
            'id': 'tpl-2',
            'title': '壊れテンプレ',
            // 破損 JSONB (非配列) の 1 行が一覧全体を AsyncError に
            // 倒さないこと (p25plan risks の防御線)。
            'ingredients': '非配列',
            'created_at': '2026-06-09T12:00:00+00:00',
          },
        ],
      );

      final templates = await r.repo.getTemplates('hh-1');

      // web getTemplates と同一 select 列。
      expect(
        r.templates.lastSelectColumns,
        'id, title, ingredients, created_at',
      );
      expect(r.templatesRead.eqFilters, [
        (column: 'household_id', value: 'hh-1'),
      ]);
      // web の .order("created_at", { ascending: false })。
      expect(r.templatesRead.orderCalls, [
        (column: 'created_at', ascending: false),
      ]);
      expect(templates, isA<List<MealTemplate>>());
      expect(templates, hasLength(2));
      expect(templates[0].id, 'tpl-1');
      expect(templates[0].ingredients.single.category, ItemCategory.vegetable);
      expect(templates[1].id, 'tpl-2');
      expect(templates[1].ingredients, isEmpty);
    });

    test('エラーは rethrow される (web の log+空配列に合わせない意図的差異)', () async {
      // web はエラーと 0 件を区別できないが、Flutter は既存 fetch 系規約
      // (fetchWeekMeals) どおり rethrow し、UI が error 表示 + 再試行を出す。
      final r = _repo(
        templatesReadError: const PostgrestException(
          message: 'boom',
          code: '500',
        ),
      );

      await expectLater(
        r.repo.getTemplates('hh-1'),
        throwsA(
          isA<PostgrestException>().having((e) => e.code, 'code', '500'),
        ),
      );
    });
  });

  group('MealsRepository.loadTemplate', () {
    test('household eq を query 化して single 取得し prefill を返す', () async {
      final r = _repo(
        templatesReadSingleValue: {
          'title': '肉じゃが',
          'ingredients': [
            {'name': 'じゃがいも', 'quantity': '3個', 'category': 'vegetable'},
          ],
        },
      );

      final prefill = await r.repo.loadTemplate(
        householdId: 'hh-1',
        templateId: 'tpl-1',
      );

      // web は select に household_id を足して app 層で照合するが、
      // Flutter は query 条件に畳む (RLS と二重の防御)。
      expect(r.templates.lastSelectColumns, 'title, ingredients');
      expect(r.templatesRead.eqFilters, [
        (column: 'id', value: 'tpl-1'),
        (column: 'household_id', value: 'hh-1'),
      ]);
      expect(prefill.title, '肉じゃが');
      expect(prefill.ingredients, hasLength(1));
      expect(prefill.ingredients.single.name, 'じゃがいも');
      expect(prefill.ingredients.single.category, ItemCategory.vegetable);
    });

    test('非配列 ingredients は空リストに防御される', () async {
      final r = _repo(
        templatesReadSingleValue: {'title': '壊れテンプレ', 'ingredients': 42},
      );

      final prefill = await r.repo.loadTemplate(
        householdId: 'hh-1',
        templateId: 'tpl-broken',
      );

      expect(prefill.title, '壊れテンプレ');
      expect(prefill.ingredients, isEmpty);
    });

    test('対象 0 行 (他世帯/既削除) の PGRST116 は rethrow される', () async {
      // web の「テンプレートが見つかりません。」分岐に相当。
      final r = _repo(
        templatesReadSingleError: const PostgrestException(
          message: 'JSON object requested, multiple (or no) rows returned',
          code: 'PGRST116',
        ),
      );

      await expectLater(
        r.repo.loadTemplate(householdId: 'hh-other', templateId: 'tpl-1'),
        throwsA(
          isA<PostgrestException>().having((e) => e.code, 'code', 'PGRST116'),
        ),
      );
    });
  });

  group('MealsRepository.deleteTemplate', () {
    test('web と同じ順: meals unlink update → meal_templates delete', () async {
      final r = _repo(templatesSingleValue: {'id': 'tpl-1'});

      await r.repo.deleteTemplate(householdId: 'hh-1', templateId: 'tpl-1');

      expect(r.client.fromTables, ['meals', 'meal_templates']);
      // unlink は web と同じく template_id のみで絞る
      // (他世帯の行は RLS で不可視)。
      expect(r.meals.lastUpdateValues, {'template_id': null});
      expect(r.mealsMutation.eqFilters, [
        (column: 'template_id', value: 'tpl-1'),
      ]);
      // delete は household スコープ + 行数検証 (deleteMeal と同形 —
      // web の ownership 事前 select を query 化)。
      expect(r.templates.deleteCallCount, 1);
      expect(r.templatesMutation.eqFilters, [
        (column: 'id', value: 'tpl-1'),
        (column: 'household_id', value: 'hh-1'),
      ]);
      expect(r.templatesMutation.selectedColumns, 'id');
    });

    test('unlink 失敗は log のみで delete に進む (web parity)', () async {
      // web は unlink update の `.error` を検証しない (actions.ts:356-359)。
      // meals.template_id は FK ON DELETE SET NULL のため、unlink が失敗しても
      // delete 成功時に DB 側で null 化され孤児リンクは残らない。
      final r = _repo(
        mealsMutationError: const PostgrestException(
          message: 'unlink failed',
          code: '500',
        ),
        templatesSingleValue: {'id': 'tpl-1'},
      );

      await r.repo.deleteTemplate(householdId: 'hh-1', templateId: 'tpl-1');

      expect(r.templates.deleteCallCount, 1);
    });

    test('対象 0 行 (他世帯/既削除) の PGRST116 は rethrow される', () async {
      // web の「このテンプレートを削除する権限がありません。」分岐に相当。
      final r = _repo(
        templatesSingleError: const PostgrestException(
          message: 'JSON object requested, multiple (or no) rows returned',
          code: 'PGRST116',
        ),
      );

      await expectLater(
        r.repo.deleteTemplate(householdId: 'hh-other', templateId: 'tpl-1'),
        throwsA(
          isA<PostgrestException>().having((e) => e.code, 'code', 'PGRST116'),
        ),
      );
    });
  });
}
