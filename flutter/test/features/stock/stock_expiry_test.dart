import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/stock/domain/stock_expiry.dart';

void main() {
  // web stock-item.tsx getExpiryStatus の閾値:
  // diffDays < 0 → 期限切れ / == 0 → 今日まで / <= 3 → あとN日 /
  // <= 7 → 月日(黄) / それ以外 → 月日(muted)。
  const today = '2026-06-10';

  group('classifyExpiry の閾値 (web getExpiryStatus と 1:1)', () {
    test('期限なし (null / 空文字) は none (バッジなし)', () {
      expect(classifyExpiry(today, null), StockExpiryStatus.none);
      expect(classifyExpiry(today, ''), StockExpiryStatus.none);
    });

    test('過去日 (diffDays < 0) は expired', () {
      expect(classifyExpiry(today, '2026-06-09'), StockExpiryStatus.expired);
      expect(classifyExpiry(today, '2026-01-01'), StockExpiryStatus.expired);
    });

    test('当日 (diffDays == 0) は expiresToday', () {
      expect(
        classifyExpiry(today, '2026-06-10'),
        StockExpiryStatus.expiresToday,
      );
    });

    test('1〜3 日後は within3Days (境界: 3 日)', () {
      expect(
        classifyExpiry(today, '2026-06-11'),
        StockExpiryStatus.within3Days,
      );
      expect(
        classifyExpiry(today, '2026-06-13'),
        StockExpiryStatus.within3Days,
      );
    });

    test('4〜7 日後は within7Days (境界: 4 日 / 7 日)', () {
      expect(
        classifyExpiry(today, '2026-06-14'),
        StockExpiryStatus.within7Days,
      );
      expect(
        classifyExpiry(today, '2026-06-17'),
        StockExpiryStatus.within7Days,
      );
    });

    test('8 日以上先は normal', () {
      expect(classifyExpiry(today, '2026-06-18'), StockExpiryStatus.normal);
      expect(classifyExpiry(today, '2027-01-01'), StockExpiryStatus.normal);
    });

    test('月跨ぎ・年跨ぎでも daysBetweenYmd ベースで正しく分類される', () {
      // 6/30 → 7/1 は 1 日差 (within3Days)。
      expect(
        classifyExpiry('2026-06-30', '2026-07-01'),
        StockExpiryStatus.within3Days,
      );
      // 12/31 → 翌年 1/1 は 1 日差。
      expect(
        classifyExpiry('2026-12-31', '2027-01-01'),
        StockExpiryStatus.within3Days,
      );
    });

    test('形式不正は throw せず none に倒す (web: パース失敗 → バッジなし)', () {
      // 桁構成不正 → jst_date の ArgumentError 経路。
      expect(classifyExpiry(today, '2026-6-1'), StockExpiryStatus.none);
      expect(classifyExpiry(today, '2026/06/13'), StockExpiryStatus.none);
      // 桁構成は合うが数値でない → int.parse の FormatException 経路。
      expect(classifyExpiry(today, 'abcd-ef-gh'), StockExpiryStatus.none);
      // todayYmd 側の不正も none (web daysBetweenYmd は from/to 両対応)。
      expect(classifyExpiry('garbage', '2026-06-13'), StockExpiryStatus.none);
    });

    // Issue #38: Dart の `int.parse` は前後空白・符号 prefix・0x prefix を
    // 許容するため、jst_date の桁数チェックをすり抜けて expired 等に
    // 誤分類されていた。web `parseYmd` (`date-jst.ts`) の
    // `^\d{4}-\d{2}-\d{2}$` と同一の regex 事前検証で none に倒す。
    test('int.parse が許容する lax 形式も none に倒す (Issue #38)', () {
      expect(classifyExpiry(today, '2026-04-9 '), StockExpiryStatus.none);
      expect(classifyExpiry(today, '+123-01-02'), StockExpiryStatus.none);
      expect(classifyExpiry(today, '0x10-01-02'), StockExpiryStatus.none);
      // todayYmd 側も regex で弾く (web daysBetweenYmd は from/to 両対応)。
      expect(
        classifyExpiry('+123-01-02', '2026-06-13'),
        StockExpiryStatus.none,
      );
    });
  });

  group('StockExpiryStatus.isExpiringAlert (web countExpiringItems と等価)', () {
    test('期限切れ・当日・3日以内が対象 (web: diffDays <= 3、負値含む)', () {
      expect(StockExpiryStatus.expired.isExpiringAlert, isTrue);
      expect(StockExpiryStatus.expiresToday.isExpiringAlert, isTrue);
      expect(StockExpiryStatus.within3Days.isExpiringAlert, isTrue);
    });

    test('4日以降・期限なしは対象外', () {
      expect(StockExpiryStatus.within7Days.isExpiringAlert, isFalse);
      expect(StockExpiryStatus.normal.isExpiringAlert, isFalse);
      expect(StockExpiryStatus.none.isExpiringAlert, isFalse);
    });

    test('classifyExpiry との組合せで web countExpiringItems を再現できる', () {
      final expiresAts = [
        '2026-06-09', // 期限切れ → count 対象
        '2026-06-10', // 当日 → 対象
        '2026-06-13', // 3 日後 → 対象
        '2026-06-14', // 4 日後 → 対象外
        null, // 期限なし → 対象外
      ];
      final count = expiresAts
          .where((e) => classifyExpiry(today, e).isExpiringAlert)
          .length;
      expect(count, 3);
    });
  });
}
