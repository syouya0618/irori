import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/data/baby_repository.dart';

void main() {
  group('formatJstDate (JST 日界の明示計算 / UTC 罠回避)', () {
    test('UTC 15:00 は JST 翌日 00:00 → 翌日の日付になる', () {
      // 2026-05-28T15:00:00Z = 2026-05-29T00:00:00 JST
      final utc = DateTime.utc(2026, 5, 28, 15);
      expect(formatJstDate(utc), '2026-05-29');
    });

    test('UTC 14:59 は JST 同日 23:59 → 当日の日付のまま', () {
      // 2026-05-28T14:59:00Z = 2026-05-28T23:59:00 JST
      final utc = DateTime.utc(2026, 5, 28, 14, 59);
      expect(formatJstDate(utc), '2026-05-28');
    });

    test('同一瞬間なら UTC 入力でも JST(=+9h) 入力でも同じ日付を返す', () {
      // formatJstDate は内部で toUtc() してから +9h するため、
      // 表現方法 (UTC / +09:00 offset) が違っても同一瞬間なら結果が一致する。
      // = 端末 TZ や入力の isUtc フラグに依存しないことの確認。
      final asUtc = DateTime.utc(2026, 5, 28, 15); // 2026-05-29 00:00 JST
      final sameInstantWithOffset = DateTime.parse(
        '2026-05-29T00:00:00+09:00',
      ); // 同一瞬間を +09:00 表記で
      expect(formatJstDate(asUtc), '2026-05-29');
      expect(formatJstDate(sameInstantWithOffset), '2026-05-29');
    });

    test('月跨ぎ: UTC 月末 15:00 は JST 翌月 1 日', () {
      // 2026-05-31T15:00:00Z = 2026-06-01T00:00:00 JST
      final utc = DateTime.utc(2026, 5, 31, 15);
      expect(formatJstDate(utc), '2026-06-01');
    });
  });

  group('jstDayBounds (JST 日界の [start, nextStart) 文字列 / PR #49)', () {
    test('通常日: +09:00 付き ISO で当日 00:00 〜 翌日 00:00', () {
      final b = BabyRepository.jstDayBounds('2026-05-29');
      expect(b.start, '2026-05-29T00:00:00+09:00');
      expect(b.nextStart, '2026-05-30T00:00:00+09:00');
    });

    test('月末 rollover: 5/31 の nextStart は 6/01', () {
      final b = BabyRepository.jstDayBounds('2026-05-31');
      expect(b.start, '2026-05-31T00:00:00+09:00');
      expect(b.nextStart, '2026-06-01T00:00:00+09:00');
    });

    test('年末 rollover: 12/31 の nextStart は翌年 1/01', () {
      final b = BabyRepository.jstDayBounds('2026-12-31');
      expect(b.start, '2026-12-31T00:00:00+09:00');
      expect(b.nextStart, '2027-01-01T00:00:00+09:00');
    });

    test('不正形式 (スラッシュ区切り) は ArgumentError', () {
      expect(
        () => BabyRepository.jstDayBounds('2026/05/29'),
        throwsArgumentError,
      );
    });
  });

  group('weeklyOrFilter (PostgREST OR 文字列 / PR #49)', () {
    test('from を gte と sleep ended_at の OR に展開する', () {
      final f = BabyRepository.weeklyOrFilter('2026-05-22T00:00:00+09:00');
      expect(
        f,
        'logged_at.gte.2026-05-22T00:00:00+09:00,'
        'and(log_type.eq.sleep,ended_at.gte.2026-05-22T00:00:00+09:00)',
      );
    });
  });
}
