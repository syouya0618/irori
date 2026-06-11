/// Next.js 原典 `src/lib/domain/__tests__/ranking.test.ts` の 1:1 移植
/// + score 同点の入力順保存 (安定 sort) の追加ケース (Phase 2.5 PR-A 計画)。
///
/// 安定 sort が必須要件である理由: web は V8 の安定 sort (ES2019 保証) に
/// 依存して同点テンプレートの並びが入力順 (= DB の返却順) になる。
/// Dart の `List.sort` は安定性非保証 (短いリストでは挿入 sort で偶然安定に
/// 見えるが、要素数が増えると intro sort で並びが入れ替わる) のため、
/// 同点 50 件の大きめケースで「元 index decorate → (score desc, index asc)」
/// の安定化実装を機械防御する。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/suggestions/ranking.dart';
import 'package:irori/core/domain/suggestions/types.dart';
import 'package:irori/features/meals/domain/meal.dart' show MealReaction;

import 'helpers.dart';

/// 原典 `const TODAY = new Date("2026-04-09T00:00:00Z")` (= JST 09:00)。
final kToday = DateTime.parse('2026-04-09T00:00:00Z');

void main() {
  group('rankSuggestions', () {
    test('マッチ率0のテンプレートは結果に含まれない', () {
      final templates = [
        mkTemplate('t1', ['存在しない食材']),
      ];
      final stock = [mkStock('トマト')];

      final result = rankSuggestions(templates, stock, today: kToday);

      expect(result, isEmpty);
    });

    test('マッチ率順にソートされる', () {
      final templates = [
        mkTemplate('low', ['トマト', '玉ねぎ', 'キャベツ']), // 2/3
        mkTemplate('high', ['トマト', '玉ねぎ']), // 2/2
      ];
      final stock = [mkStock('トマト'), mkStock('玉ねぎ')];

      final result = rankSuggestions(templates, stock, today: kToday);

      expect(result, hasLength(2));
      expect(result[0].templateId, 'high');
      expect(result[1].templateId, 'low');
    });

    test('期限切れ間近のボーナスが加算される', () {
      final templates = [
        mkTemplate('noExpiry', ['トマト']),
        mkTemplate('withExpiry', ['玉ねぎ']),
      ];
      final stock = [
        mkStock('トマト'),
        mkStock('玉ねぎ', expiresAt: '2026-04-10'), // 明日期限切れ
      ];

      final result = rankSuggestions(templates, stock, today: kToday);

      expect(result[0].templateId, 'withExpiry');
      expect(result[0].hasExpiringStock, isTrue);
      expect(result[0].scoreBreakdown.expiryBonus, greaterThan(0));
    });

    test('goodリアクションで順位が上がる', () {
      final templates = [
        mkTemplate(
          'badTemplate',
          ['トマト'],
          [
            MealReaction.bad,
            MealReaction.bad,
          ],
        ),
        mkTemplate(
          'goodTemplate',
          ['トマト'],
          [
            MealReaction.good,
            MealReaction.good,
          ],
        ),
      ];
      final stock = [mkStock('トマト')];

      final result = rankSuggestions(templates, stock, today: kToday);

      expect(result[0].templateId, 'goodTemplate');
    });

    test('topN でリストが切り詰められる', () {
      final templates = [
        for (var i = 0; i < 15; i++) mkTemplate('t$i', ['トマト']),
      ];
      final stock = [mkStock('トマト')];

      final result = rankSuggestions(
        templates,
        stock,
        config: const ScoringConfig(topN: 5),
        today: kToday,
      );

      expect(result, hasLength(5));
    });

    test('空のテンプレートリストは空配列を返す', () {
      final result = rankSuggestions([], [mkStock('トマト')], today: kToday);
      expect(result, isEmpty);
    });

    test('空の在庫リストでも全テンプレートをスキップする', () {
      final templates = [
        mkTemplate('t1', ['トマト']),
      ];
      final result = rankSuggestions(templates, [], today: kToday);
      expect(result, isEmpty);
    });

    test('結果には matchedIngredients と missingIngredients が含まれる', () {
      final templates = [
        mkTemplate('t1', ['トマト', '玉ねぎ']),
      ];
      final stock = [mkStock('トマト')];

      final result = rankSuggestions(templates, stock, today: kToday);

      expect(result[0].matchedIngredients, hasLength(1));
      expect(result[0].matchedIngredients[0].name, 'トマト');
      expect(result[0].missingIngredients, hasLength(1));
      expect(result[0].missingIngredients[0].name, '玉ねぎ');
    });

    // ─── 追加ケース: score 同点の並び安定化 (web V8 安定 sort parity) ───

    test('score 同点 50 件は入力順を保つ（安定 sort）', () {
      // 全テンプレートが同一在庫に matchRate 1.0 でマッチ → 全件 score 同点。
      // 50 件は Dart List.sort が挿入 sort から intro sort に切り替わる
      // 規模で、index decorate なしでは並びが入れ替わりうる。
      final templates = [
        for (var i = 0; i < 50; i++) mkTemplate('t$i', ['トマト']),
      ];
      final stock = [mkStock('トマト')];

      final result = rankSuggestions(
        templates,
        stock,
        config: const ScoringConfig(topN: 50),
        today: kToday,
      );

      expect(
        result.map((s) => s.templateId).toList(),
        [for (var i = 0; i < 50; i++) 't$i'],
      );
    });

    test('異なる score が混在しても同点同士は入力順を保つ', () {
      // a(1.0), b(0.5), c(1.0), d(0.5), e(1.0)
      //   → score 降順 + 同点は入力順 = [a, c, e, b, d]
      final templates = [
        mkTemplate('a', ['トマト']),
        mkTemplate('b', ['トマト', '玉ねぎ']),
        mkTemplate('c', ['トマト']),
        mkTemplate('d', ['トマト', '玉ねぎ']),
        mkTemplate('e', ['トマト']),
      ];
      final stock = [mkStock('トマト')];

      final result = rankSuggestions(templates, stock, today: kToday);

      expect(
        result.map((s) => s.templateId).toList(),
        ['a', 'c', 'e', 'b', 'd'],
      );
    });
  });
}
