import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/utils/jst_date.dart';

/// `core/utils/jst_date.dart` (Phase 2 共有基盤 / F0) のテスト。
///
/// `formatJstDate` / `shiftYmd` は `baby_repository.dart` からの移設のため、
/// 既存テスト (`baby_repository_jst_test.dart`) と同じケースで回帰を固定する
/// (既存テストは re-export 経由、本テストは core 直 import 経由)。
void main() {
  group('formatJstDate (移設回帰 / JST 日界の明示計算)', () {
    test('UTC 15:00 は JST 翌日 00:00 → 翌日の日付になる', () {
      // 2026-05-28T15:00:00Z = 2026-05-29T00:00:00 JST
      expect(formatJstDate(DateTime.utc(2026, 5, 28, 15)), '2026-05-29');
    });

    test('UTC 14:59 は JST 23:59 → 当日のまま', () {
      expect(formatJstDate(DateTime.utc(2026, 5, 28, 14, 59)), '2026-05-28');
    });

    test('非 UTC の DateTime も内部で toUtc() され同一 instant なら同一日付', () {
      final asUtc = DateTime.utc(2026, 5, 28, 15);
      final sameInstantLocal = asUtc.toLocal();
      expect(formatJstDate(sameInstantLocal), formatJstDate(asUtc));
    });

    test('月末 UTC 15:00 → JST 翌月 1 日 (月跨ぎ)', () {
      expect(formatJstDate(DateTime.utc(2026, 5, 31, 15)), '2026-06-01');
    });

    test('大晦日 UTC 15:00 → JST 元日 (年跨ぎ)', () {
      expect(formatJstDate(DateTime.utc(2026, 12, 31, 15)), '2027-01-01');
    });

    test('引数省略時は現在時刻で YYYY-MM-DD を返す (形式のみ固定)', () {
      expect(formatJstDate(), matches(RegExp(r'^\d{4}-\d{2}-\d{2}$')));
    });
  });

  group('shiftYmd (移設回帰 / TZ 非依存日数シフト)', () {
    test('+1 日', () {
      expect(shiftYmd('2026-05-29', 1), '2026-05-30');
    });

    test('-1 日', () {
      expect(shiftYmd('2026-05-29', -1), '2026-05-28');
    });

    test('0 日 (恒等)', () {
      expect(shiftYmd('2026-05-29', 0), '2026-05-29');
    });

    test('月跨ぎ (+1)', () {
      expect(shiftYmd('2026-05-31', 1), '2026-06-01');
    });

    test('月跨ぎ (-1)', () {
      expect(shiftYmd('2026-06-01', -1), '2026-05-31');
    });

    test('年跨ぎ (+1)', () {
      expect(shiftYmd('2026-12-31', 1), '2027-01-01');
    });

    test('年跨ぎ (-1)', () {
      expect(shiftYmd('2026-01-01', -1), '2025-12-31');
    });

    test('-6 日 (週間サマリーの from 計算)', () {
      expect(shiftYmd('2026-05-29', -6), '2026-05-23');
    });

    test('閏年: 2028-02-28 + 1 = 2028-02-29', () {
      expect(shiftYmd('2028-02-28', 1), '2028-02-29');
    });

    test('非閏年: 2026-02-28 + 1 = 2026-03-01', () {
      expect(shiftYmd('2026-02-28', 1), '2026-03-01');
    });

    test('YYYY-MM-DD 形式でなければ ArgumentError (握り潰さない)', () {
      expect(() => shiftYmd('2026/05/29', 1), throwsArgumentError);
    });
  });

  group('weekStartMonday (web getMonday と同一: 月曜開始、日曜は前週扱い)', () {
    // アンカー: 2026-06-08 (月) 〜 2026-06-14 (日) の週。
    // 各曜日は `DateTime.utc(...).weekday` で実機検証済み (1=月 .. 7=日)。
    test('月曜はその日自身を返す', () {
      expect(weekStartMonday('2026-06-08'), '2026-06-08');
    });

    test('火曜 → 同週月曜', () {
      expect(weekStartMonday('2026-06-09'), '2026-06-08');
    });

    test('水曜 → 同週月曜', () {
      expect(weekStartMonday('2026-06-10'), '2026-06-08');
    });

    test('木曜 → 同週月曜', () {
      expect(weekStartMonday('2026-06-11'), '2026-06-08');
    });

    test('金曜 → 同週月曜', () {
      expect(weekStartMonday('2026-06-12'), '2026-06-08');
    });

    test('土曜 → 同週月曜', () {
      expect(weekStartMonday('2026-06-13'), '2026-06-08');
    });

    test('日曜は前週扱い → 6 日前の月曜 (web `day === 0 ? -6` と同一)', () {
      expect(weekStartMonday('2026-06-14'), '2026-06-08');
    });

    test('月跨ぎ: 金曜 2026-05-01 → 前月の月曜 2026-04-27', () {
      expect(weekStartMonday('2026-05-01'), '2026-04-27');
    });

    test('年跨ぎ: 木曜 2026-01-01 → 前年の月曜 2025-12-29', () {
      expect(weekStartMonday('2026-01-01'), '2025-12-29');
    });

    test('年跨ぎ + 日曜: 2027-01-03 (日) → 前年の月曜 2026-12-28', () {
      expect(weekStartMonday('2027-01-03'), '2026-12-28');
    });

    test('閏日: 2028-02-29 (火) → 月曜 2028-02-28', () {
      expect(weekStartMonday('2028-02-29'), '2028-02-28');
    });

    test('YYYY-MM-DD 形式でなければ ArgumentError', () {
      expect(() => weekStartMonday('2026-6-8'), throwsArgumentError);
    });
  });

  group('daysBetweenYmd (web daysBetweenYmd と同一符号: to - from)', () {
    test('同日は 0', () {
      expect(daysBetweenYmd('2026-06-10', '2026-06-10'), 0);
    });

    test('to が未来なら正', () {
      expect(daysBetweenYmd('2026-06-01', '2026-06-10'), 9);
    });

    test('to が過去なら負', () {
      expect(daysBetweenYmd('2026-06-10', '2026-06-01'), -9);
    });

    test('翌日は +1 (期限バッジの「明日」境界)', () {
      expect(daysBetweenYmd('2026-06-10', '2026-06-11'), 1);
    });

    test('前日は -1 (期限切れ境界)', () {
      expect(daysBetweenYmd('2026-06-10', '2026-06-09'), -1);
    });

    test('月跨ぎ', () {
      expect(daysBetweenYmd('2026-05-31', '2026-06-01'), 1);
    });

    test('年跨ぎ', () {
      expect(daysBetweenYmd('2026-12-31', '2027-01-01'), 1);
    });

    test('閏年: 2028-02-28 → 2028-03-01 は 2 日 (02-29 を挟む)', () {
      expect(daysBetweenYmd('2028-02-28', '2028-03-01'), 2);
    });

    test('非閏年: 2026-02-28 → 2026-03-01 は 1 日', () {
      expect(daysBetweenYmd('2026-02-28', '2026-03-01'), 1);
    });

    test('長期間: 365 日 (2026 年は非閏年)', () {
      expect(daysBetweenYmd('2026-01-01', '2027-01-01'), 365);
    });

    test('from が不正形式なら ArgumentError', () {
      expect(
        () => daysBetweenYmd('2026/06/10', '2026-06-11'),
        throwsArgumentError,
      );
    });

    test('to が不正形式なら ArgumentError', () {
      expect(() => daysBetweenYmd('2026-06-10', 'bad'), throwsArgumentError);
    });
  });
}
