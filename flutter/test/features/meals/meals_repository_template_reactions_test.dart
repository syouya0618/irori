import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

/// `MealsRepository.fetchTemplateReactions` (PR P2.5-F) のテスト。
///
/// web 原典 `recipe-suggestion-queries.ts:35-39` の reaction クエリ:
/// ```ts
/// supabase.from("meals")
///   .select("template_id, meal_reactions ( reaction )")
///   .eq("household_id", householdId)
///   .not("template_id", "is", null)
/// ```
/// と同一の select / filter チェーンであること + 行整形の防御
/// (null/非配列 reactions・未知 reaction 値) を検証する。
({MealsRepository repo, FakeQueryBuilder meals, FakeFilterBuilder mealsRead})
_repo({PostgrestList rows = const [], Object? readError}) {
  final mealsRead = FakeFilterBuilder(
    cannedValue: rows,
    cannedError: readError,
  );
  final meals = FakeQueryBuilder(mealsRead);
  final client = FakeSupabaseClient(fromBuilders: {'meals': meals});
  return (
    repo: MealsRepository(client),
    meals: meals,
    mealsRead: mealsRead,
  );
}

void main() {
  group('fetchTemplateReactions のクエリ形 (web parity)', () {
    test('select 列・household eq・not(template_id is null) が web と同一', () async {
      final h = _repo(
        rows: [
          {
            'template_id': 'tpl-1',
            'meal_reactions': [
              {'reaction': 'good'},
            ],
          },
        ],
      );

      await h.repo.fetchTemplateReactions('hh-1');

      expect(
        h.meals.lastSelectColumns,
        'template_id, meal_reactions(reaction)',
      );
      expect(
        h.mealsRead.eqFilters,
        [(column: 'household_id', value: 'hh-1')],
      );
      expect(
        h.mealsRead.notFilters,
        [(column: 'template_id', operator: 'is', value: null)],
      );
    });

    test('PostgrestException は握り潰さず rethrow する', () async {
      final h = _repo(
        readError: const PostgrestException(message: 'boom', code: '500'),
      );

      await expectLater(
        h.repo.fetchTemplateReactions('hh-1'),
        throwsA(isA<PostgrestException>()),
      );
    });
  });

  group('fetchTemplateReactions の行整形 (防御的パース)', () {
    test('reaction 文字列を MealReaction へ変換し、行順を保つ', () async {
      final h = _repo(
        rows: [
          {
            'template_id': 'tpl-1',
            'meal_reactions': [
              {'reaction': 'good'},
              {'reaction': 'ok'},
              {'reaction': 'bad'},
            ],
          },
          {'template_id': 'tpl-2', 'meal_reactions': <Object?>[]},
        ],
      );

      final rows = await h.repo.fetchTemplateReactions('hh-1');

      expect(rows, hasLength(2));
      expect(rows[0].templateId, 'tpl-1');
      expect(rows[0].reactions, [
        MealReaction.good,
        MealReaction.ok,
        MealReaction.bad,
      ]);
      expect(rows[1].templateId, 'tpl-2');
      expect(rows[1].reactions, isEmpty);
    });

    test('template_id null は null のまま透過する (skip は provider 側の責務)', () async {
      // `.not(...)` で DB 側除外済みだが、web :60 の
      // `if (!meal.template_id) continue` と同じ防御を provider が持てるよう
      // nullable を保って返す。
      final h = _repo(
        rows: [
          {
            'template_id': null,
            'meal_reactions': [
              {'reaction': 'bad'},
            ],
          },
        ],
      );

      final rows = await h.repo.fetchTemplateReactions('hh-1');

      expect(rows.single.templateId, isNull);
      expect(rows.single.reactions, [MealReaction.bad]);
    });

    test(
      'meal_reactions が null / 非配列 → 空リスト (web の ?? [] 相当 + 非配列防御)',
      () async {
        final h = _repo(
          rows: [
            {'template_id': 'tpl-1', 'meal_reactions': null},
            {'template_id': 'tpl-2'},
            {'template_id': 'tpl-3', 'meal_reactions': 'broken'},
          ],
        );

        final rows = await h.repo.fetchTemplateReactions('hh-1');

        expect(rows, hasLength(3));
        for (final row in rows) {
          expect(row.reactions, isEmpty);
        }
      },
    );

    test('未知の reaction 値・非 Map 要素はその要素のみ skip する (スコア中立)', () async {
      final h = _repo(
        rows: [
          {
            'template_id': 'tpl-1',
            'meal_reactions': [
              {'reaction': 'good'},
              {'reaction': 'amazing'}, // 未知 ENUM 値 (将来の schema drift)
              {'reaction': null},
              'broken-entry', // 非 Map 要素
              {'reaction': 'bad'},
            ],
          },
        ],
      );

      final rows = await h.repo.fetchTemplateReactions('hh-1');

      expect(rows.single.reactions, [MealReaction.good, MealReaction.bad]);
    });
  });
}
