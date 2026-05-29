import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/domain/baby_log.dart';

void main() {
  group('BabyLog.fromJson (実 baby_logs スキーマ対応)', () {
    test('feeding ログ: snake_case 列名と enum/数値が正しく復元される', () {
      // Supabase が返す生 JSON 形 (snake_case + ISO 文字列 + ENUM 文字列)。
      final json = <String, dynamic>{
        'id': 'log-1',
        'household_id': 'hh-1',
        'log_type': 'feeding',
        'logged_at': '2026-05-29T03:00:00+00:00',
        'logged_by': 'user-1',
        'feeding_type': 'bottle',
        'amount_ml': 120,
        'diaper_type': null,
        'ended_at': null,
        'temperature': null,
        'weight_g': null,
        'height_cm': null,
        'duration_min': 15,
        'memo': 'ミルク',
        'created_at': '2026-05-29T03:00:01+00:00',
        'updated_at': '2026-05-29T03:00:01+00:00',
      };

      final log = BabyLog.fromJson(json);

      expect(log.id, 'log-1');
      expect(log.householdId, 'hh-1');
      expect(log.logType, BabyLogType.feeding);
      expect(log.feedingType, FeedingType.bottle);
      expect(log.amountMl, 120);
      expect(log.durationMin, 15);
      expect(log.memo, 'ミルク');
      expect(log.diaperType, isNull);
      expect(log.endedAt, isNull);
      expect(log.loggedAt, DateTime.utc(2026, 5, 29, 3));
    });

    test('growth ログ: numeric (height_cm) が double に復元される', () {
      // Postgres numeric は JSON で 50.5 / 文字列どちらでも来うる。
      // ここでは数値 JSON を検証 (PostgREST は numeric を文字列で返す場合があり、
      // その挙動差は実 Supabase 接続テストで担保する旨を報告に記載)。
      final json = <String, dynamic>{
        'id': 'log-2',
        'household_id': 'hh-1',
        'log_type': 'growth',
        'logged_at': '2026-05-29T03:00:00+00:00',
        'logged_by': 'user-1',
        'feeding_type': null,
        'amount_ml': null,
        'diaper_type': null,
        'ended_at': null,
        'temperature': null,
        'weight_g': 5200,
        'height_cm': 58.5,
        'duration_min': null,
        'memo': null,
        'created_at': '2026-05-29T03:00:01+00:00',
        'updated_at': '2026-05-29T03:00:01+00:00',
      };

      final log = BabyLog.fromJson(json);
      expect(log.logType, BabyLogType.growth);
      expect(log.weightG, 5200);
      expect(log.heightCm, 58.5);
    });

    test('numeric 列 (temperature/height_cm) が文字列で来ても double に復元される', () {
      // PostgREST は numeric を引用符付き文字列で返す場合がある。
      // tolerant パーサ (_numericFromJson) でダッシュボード全体が
      // AsyncError に倒れるのを防ぐ (regression)。
      final json = <String, dynamic>{
        'id': 'log-num',
        'household_id': 'hh-1',
        'log_type': 'temperature',
        'logged_at': '2026-05-29T03:00:00+00:00',
        'logged_by': 'user-1',
        'temperature': '37.2', // 文字列
        'height_cm': '58.5', // 文字列
        'weight_g': 5200, // int 列は数値のまま
        'created_at': '2026-05-29T03:00:01+00:00',
      };

      final log = BabyLog.fromJson(json);
      expect(log.temperature, 37.2);
      expect(log.heightCm, 58.5);
      expect(log.weightG, 5200);
    });

    test('diaper ログ: diaper_type enum が復元される', () {
      final json = <String, dynamic>{
        'id': 'log-3',
        'household_id': 'hh-1',
        'log_type': 'diaper',
        'logged_at': '2026-05-29T03:00:00+00:00',
        'logged_by': 'user-1',
        'diaper_type': 'both',
        'created_at': '2026-05-29T03:00:01+00:00',
      };

      final log = BabyLog.fromJson(json);
      expect(log.logType, BabyLogType.diaper);
      expect(log.diaperType, DiaperType.both);
      // updated_at 欠落でも壊れない (nullable)。
      expect(log.updatedAt, isNull);
    });

    test('全 log_type enum が JsonValue でマッピングされている', () {
      BabyLog parse(String type) => BabyLog.fromJson(<String, dynamic>{
        'id': 'x',
        'household_id': 'hh',
        'log_type': type,
        'logged_at': '2026-05-29T03:00:00+00:00',
        'logged_by': 'u',
        'created_at': '2026-05-29T03:00:00+00:00',
      });

      expect(parse('feeding').logType, BabyLogType.feeding);
      expect(parse('diaper').logType, BabyLogType.diaper);
      expect(parse('sleep').logType, BabyLogType.sleep);
      expect(parse('temperature').logType, BabyLogType.temperature);
      expect(parse('growth').logType, BabyLogType.growth);
      expect(parse('memo').logType, BabyLogType.memo);
    });
  });
}
