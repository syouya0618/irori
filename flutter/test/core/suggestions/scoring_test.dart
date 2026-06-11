/// Next.js 原典 `src/lib/domain/__tests__/scoring.test.ts` の 1:1 移植
/// + defaultScoringConfig 全定数値 assert / daysUntilExpiry の不正形式ケース
/// (Phase 2.5 PR-A 計画の追加ケース)。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/suggestions/scoring.dart';
import 'package:irori/core/domain/suggestions/types.dart';
import 'package:irori/features/meals/domain/meal.dart' show MealReaction;

import 'helpers.dart';

/// 原典 `const TODAY = new Date("2026-04-09T00:00:00Z")` (= JST 09:00)。
final kToday = DateTime.parse('2026-04-09T00:00:00Z');

void main() {
  group('defaultScoringConfig', () {
    // web DEFAULT_SCORING_CONFIG (types.ts) との値乖離を機械検出する。
    // 1 値でもズレるとスコア・並び・バッジ閾値が web と乖離するため全 9 値を固定。
    test('web DEFAULT_SCORING_CONFIG と全 9 値が一致する', () {
      expect(defaultScoringConfig.expiryBonusThresholdDays, 3);
      expect(defaultScoringConfig.expiryBonusPerItem, 0.1);
      expect(defaultScoringConfig.expiryBonusMax, 0.3);
      expect(defaultScoringConfig.goodReactionBonus, 0.05);
      expect(defaultScoringConfig.badReactionPenalty, 0.05);
      expect(defaultScoringConfig.reactionScoreMax, 0.2);
      expect(defaultScoringConfig.reactionScoreMin, -0.1);
      expect(defaultScoringConfig.topN, 10);
      expect(defaultScoringConfig.minMatchLength, 2);
    });
  });

  group('daysUntilExpiry', () {
    test('期限切れは負の値', () {
      expect(daysUntilExpiry('2026-04-08', kToday), -1);
    });

    test('当日は0', () {
      expect(daysUntilExpiry('2026-04-09', kToday), 0);
    });

    test('未来は正の値', () {
      expect(daysUntilExpiry('2026-04-12', kToday), 3);
    });

    test('nullはnullを返す', () {
      expect(daysUntilExpiry(null, kToday), isNull);
    });

    // 追加ケース: web は `!expiresAt` (空文字含む) と `daysBetweenYmd` の
    // パース失敗で null を返す。Dart は jst_date の ArgumentError /
    // FormatException を catch して null に倒す (stock_expiry.dart と同流儀)。
    test('空文字・不正な形式は null を返す (web parity)', () {
      expect(daysUntilExpiry('', kToday), isNull);
      expect(daysUntilExpiry('not-a-date', kToday), isNull);
      expect(daysUntilExpiry('2026-4-09', kToday), isNull);
      expect(daysUntilExpiry('abcd-ef-gh', kToday), isNull);
    });
  });

  group('calculateExpiryBonus', () {
    test('マッチなしは0', () {
      expect(calculateExpiryBonus([], defaultScoringConfig, kToday), 0);
    });

    test('期限なしの食材はボーナスなし', () {
      final matched = mkMatched([mkStock('トマト')]);
      expect(calculateExpiryBonus(matched, defaultScoringConfig, kToday), 0);
    });

    test('期限3日以内の食材にボーナス付与', () {
      final matched = mkMatched([
        mkStock('トマト', expiresAt: '2026-04-11'), // 2日後
      ]);
      final bonus = calculateExpiryBonus(matched, defaultScoringConfig, kToday);
      expect(bonus, greaterThan(0));
    });

    test('期限7日後の食材はボーナスなし', () {
      final matched = mkMatched([
        mkStock('トマト', expiresAt: '2026-04-16'), // 7日後
      ]);
      expect(calculateExpiryBonus(matched, defaultScoringConfig, kToday), 0);
    });

    test('期限切れ食材もボーナス対象（使い切りたい）', () {
      final matched = mkMatched([
        mkStock('トマト', expiresAt: '2026-04-07'), // 2日前
      ]);
      final bonus = calculateExpiryBonus(matched, defaultScoringConfig, kToday);
      expect(bonus, greaterThan(0));
    });

    test('ボーナスは上限を超えない', () {
      final matched = mkMatched([
        mkStock('A', expiresAt: '2026-04-10'),
        mkStock('B', expiresAt: '2026-04-10'),
        mkStock('C', expiresAt: '2026-04-10'),
        mkStock('D', expiresAt: '2026-04-10'),
        mkStock('E', expiresAt: '2026-04-10'),
      ]);
      final bonus = calculateExpiryBonus(matched, defaultScoringConfig, kToday);
      expect(bonus, lessThanOrEqualTo(defaultScoringConfig.expiryBonusMax));
    });
  });

  group('calculateReactionScore', () {
    test('リアクションなしは0', () {
      expect(calculateReactionScore([], defaultScoringConfig), 0);
    });

    test('good のみは正の値', () {
      final score = calculateReactionScore(
        [MealReaction.good, MealReaction.good],
        defaultScoringConfig,
      );
      expect(score, greaterThan(0));
    });

    test('bad のみは負の値', () {
      final score = calculateReactionScore(
        [MealReaction.bad],
        defaultScoringConfig,
      );
      expect(score, lessThan(0));
    });

    test('ok のみは0', () {
      expect(
        calculateReactionScore(
          [MealReaction.ok, MealReaction.ok],
          defaultScoringConfig,
        ),
        0,
      );
    });

    test('スコアは上限下限でクランプされる', () {
      final manyGood = List.filled(100, MealReaction.good);
      final score = calculateReactionScore(manyGood, defaultScoringConfig);
      expect(score, lessThanOrEqualTo(defaultScoringConfig.reactionScoreMax));

      final manyBad = List.filled(100, MealReaction.bad);
      final badScore = calculateReactionScore(manyBad, defaultScoringConfig);
      expect(
        badScore,
        greaterThanOrEqualTo(defaultScoringConfig.reactionScoreMin),
      );
    });
  });
}
