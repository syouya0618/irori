/// Next.js 原典 `src/lib/domain/__tests__/consumption-rate.test.ts` の移植
/// + defaultRateConfig 定数 assert / 0 と null の区別 / num (小数) 在庫の
/// 追加ケース (Phase 2.5 PR-A 計画)。
///
/// `calculateMilkDailyMl` とそのテスト 4 件は移植しない: web 側に UI 消費者が
/// 存在しない死にコード (grep 検証済み — Phase 2.5 計画の deferred 参照)。
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/domain/consumption_rate.dart';
import 'package:irori/features/baby/domain/baby_log.dart' show BabyLogType;

/// 原典 `const TODAY = new Date("2026-04-11T03:00:00Z")` (= JST 12:00)。
final kToday = DateTime.parse('2026-04-11T03:00:00Z');

/// テスト用ログファクトリ。原典 `mkLog` 相当。
///
/// 原典は `setUTCDate(getUTCDate() - daysAgo)` で日付を戻すが、対象期間
/// (4月内・最大 8 日前) では 24h × N の減算と同一 instant になる。
ConsumptionLogInput mkLog(BabyLogType logType, int daysAgo) {
  return ConsumptionLogInput(
    logType: logType,
    loggedAt: kToday.subtract(Duration(days: daysAgo)),
  );
}

void main() {
  group('defaultRateConfig', () {
    // web DEFAULT_RATE_CONFIG (consumption-rate.ts) との値乖離を機械検出する。
    test('web DEFAULT_RATE_CONFIG と一致する (windowDays: 7)', () {
      expect(defaultRateConfig.windowDays, 7);
    });
  });

  group('calculateDailyRate', () {
    test('7日間毎日3回のおむつ → 3.0/日', () {
      final logs = <ConsumptionLogInput>[
        for (var day = 0; day < 7; day++)
          for (var i = 0; i < 3; i++) mkLog(BabyLogType.diaper, day),
      ];
      expect(calculateDailyRate(logs, BabyLogType.diaper, today: kToday), 3);
    });

    test('3日間だけデータがある場合、3日で割る', () {
      final logs = [
        mkLog(BabyLogType.diaper, 1),
        mkLog(BabyLogType.diaper, 1),
        mkLog(BabyLogType.diaper, 3),
        mkLog(BabyLogType.diaper, 3),
        mkLog(BabyLogType.diaper, 5),
      ];
      // 5件 / 3日 ≈ 1.666...
      final rate = calculateDailyRate(logs, BabyLogType.diaper, today: kToday);
      expect(rate, closeTo(5 / 3, 1e-9));
    });

    test('ログ0件 → null', () {
      expect(calculateDailyRate([], BabyLogType.diaper, today: kToday), isNull);
    });

    test('7日より古いログは除外される', () {
      final logs = [
        mkLog(BabyLogType.diaper, 8), // 8日前 → ウィンドウ外
        mkLog(BabyLogType.diaper, 1), // 1日前 → ウィンドウ内
      ];
      expect(calculateDailyRate(logs, BabyLogType.diaper, today: kToday), 1);
    });

    test('異なるlog_typeはフィルタされる', () {
      final logs = [
        mkLog(BabyLogType.diaper, 1),
        mkLog(BabyLogType.feeding, 1), // feedingはカウントしない
        mkLog(BabyLogType.sleep, 1),
      ];
      expect(calculateDailyRate(logs, BabyLogType.diaper, today: kToday), 1);
    });

    test('カスタムウィンドウ日数を使用できる', () {
      final logs = [
        mkLog(BabyLogType.diaper, 1),
        mkLog(BabyLogType.diaper, 2),
        mkLog(BabyLogType.diaper, 4), // 3日ウィンドウ外
      ];
      final rate = calculateDailyRate(
        logs,
        BabyLogType.diaper,
        today: kToday,
        config: const ConsumptionRateConfig(windowDays: 3),
      );
      expect(rate, 1); // 2件 / 2日
    });
  });

  group('estimateRemainingDays', () {
    test('在庫15、日次5 → 3日', () {
      expect(estimateRemainingDays(15, 5), 3);
    });

    test('在庫7、日次3 → 2日（小数切り捨て）', () {
      expect(estimateRemainingDays(7, 3), 2);
    });

    test('日次レート0 → null', () {
      expect(estimateRemainingDays(10, 0), isNull);
    });

    test('日次レートnull → null', () {
      expect(estimateRemainingDays(10, null), isNull);
    });

    test('日次レート負 → null', () {
      expect(estimateRemainingDays(10, -1), isNull);
    });

    test('在庫0 → 0日', () {
      expect(estimateRemainingDays(0, 5), 0);
    });

    test('在庫が負 → 0日', () {
      expect(estimateRemainingDays(-3, 5), 0);
    });

    // ─── 追加ケース ───

    test('戻り値 0（今日切れ）は null（レート算出不能）と区別される', () {
      // 0 は「今日切れ」の有効値。`if (remaining != null)` で判定すべきで、
      // falsy 風判定 (`remaining == 0` を「無し」扱い) を書くとバッジ・
      // 低在庫自動追加から漏れる (Phase 2.5 計画の risks 参照)。
      final zero = estimateRemainingDays(0, 5);
      expect(zero, isNotNull);
      expect(zero, 0);

      final none = estimateRemainingDays(10, 0);
      expect(none, isNull);
    });

    test('在庫が小数 (num) でも floor 計算される', () {
      // StockItem.quantity は num (値保存 tolerant パーサ) のため
      // 小数在庫がそのまま渡りうる。JS Math.floor(1.5 / 1) と同一挙動。
      expect(estimateRemainingDays(1.5, 1), 1);
      expect(estimateRemainingDays(2.5, 1), 2);
    });
  });
}
