import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/presentation/baby_display_utils.dart';

BabyLog _log({
  required BabyLogType logType,
  DateTime? loggedAt,
  DateTime? endedAt,
  FeedingType? feedingType,
  int? amountMl,
  int? durationMin,
  DiaperType? diaperType,
  double? temperature,
  int? weightG,
  double? heightCm,
  String? memo,
}) {
  return BabyLog(
    id: 'id',
    householdId: 'hh-1',
    logType: logType,
    loggedAt: loggedAt ?? DateTime.utc(2026, 1, 1, 12),
    loggedBy: 'user-1',
    feedingType: feedingType,
    amountMl: amountMl,
    diaperType: diaperType,
    endedAt: endedAt,
    temperature: temperature,
    weightG: weightG,
    heightCm: heightCm,
    durationMin: durationMin,
    memo: memo,
    createdAt: DateTime.utc(2026, 1, 1, 12),
  );
}

void main() {
  group('labels (原典 baby-log-labels.ts と一致)', () {
    test('babyLogTypeLabel', () {
      expect(babyLogTypeLabel(BabyLogType.feeding), '授乳');
      expect(babyLogTypeLabel(BabyLogType.diaper), 'おむつ');
      expect(babyLogTypeLabel(BabyLogType.sleep), '睡眠');
      expect(babyLogTypeLabel(BabyLogType.temperature), '体温');
      expect(babyLogTypeLabel(BabyLogType.growth), '成長記録');
      expect(babyLogTypeLabel(BabyLogType.memo), 'メモ');
    });

    test('feedingTypeLabel', () {
      expect(feedingTypeLabel(FeedingType.breastLeft), '左');
      expect(feedingTypeLabel(FeedingType.breastRight), '右');
      expect(feedingTypeLabel(FeedingType.bottle), 'ミルク');
      expect(feedingTypeLabel(FeedingType.solid), '離乳食');
    });

    test('diaperTypeLabel', () {
      expect(diaperTypeLabel(DiaperType.pee), 'おしっこ');
      expect(diaperTypeLabel(DiaperType.poop), 'うんち');
      expect(diaperTypeLabel(DiaperType.both), '両方');
    });
  });

  group('formatElapsedMinutes (原典と一致)', () {
    test('60分未満は X分', () {
      expect(formatElapsedMinutes(0), '0分');
      expect(formatElapsedMinutes(1), '1分');
      expect(formatElapsedMinutes(59), '59分');
    });

    test('ちょうど時間は X時間', () {
      expect(formatElapsedMinutes(60), '1時間');
      expect(formatElapsedMinutes(120), '2時間');
    });

    test('端数ありは X時間Y分', () {
      expect(formatElapsedMinutes(61), '1時間1分');
      expect(formatElapsedMinutes(125), '2時間5分');
    });

    test('負値も原典同様 pass-through (特別扱いしない)', () {
      expect(formatElapsedMinutes(-5), '-5分');
    });
  });

  group('minutesBetween (原典 Math.round 相当)', () {
    test('正方向の分差', () {
      final from = DateTime.utc(2026, 1, 1, 10, 0);
      final to = DateTime.utc(2026, 1, 1, 11, 30);
      expect(minutesBetween(from, to), 90);
    });

    test('30秒は四捨五入で繰り上げ', () {
      final from = DateTime.utc(2026, 1, 1, 10, 0, 0);
      final to = DateTime.utc(2026, 1, 1, 10, 0, 30);
      expect(minutesBetween(from, to), 1);
    });

    test('29秒は四捨五入で切り捨て', () {
      final from = DateTime.utc(2026, 1, 1, 10, 0, 0);
      final to = DateTime.utc(2026, 1, 1, 10, 0, 29);
      expect(minutesBetween(from, to), 0);
    });

    test('逆順は負値', () {
      final from = DateTime.utc(2026, 1, 1, 11, 0);
      final to = DateTime.utc(2026, 1, 1, 10, 0);
      expect(minutesBetween(from, to), -60);
    });
  });

  group('formatTimeJst (JST HH:mm, 端末TZ非依存)', () {
    test('UTC 03:05 は JST 12:05', () {
      // UTC 03:05 + 9h = JST 12:05
      expect(formatTimeJst(DateTime.utc(2026, 1, 1, 3, 5)), '12:05');
    });

    test('UTC 15:00 は翌日 JST 00:00 (zero-pad)', () {
      expect(formatTimeJst(DateTime.utc(2026, 1, 1, 15, 0)), '00:00');
    });

    test('非UTC DateTime も toUtc 経由で正規化される', () {
      // 明示オフセット +02:00 の 10:00 は UTC 08:00 → JST 17:00
      final dt = DateTime.parse('2026-01-01T10:00:00+02:00');
      expect(formatTimeJst(dt), '17:00');
    });

    test(
      'BabyLog.fromJson 経由 (Supabase timestamptz) の loggedAt は UTC で扱われる',
      () {
        // advisor 指摘 #1 の machine-verify: Supabase は timestamptz を
        // zone 付き ISO (`+00:00` / `Z`) で返す → DateTime.parse は isUtc=true。
        // よって formatTimeJst は端末 TZ に依存せず JST へ正しく変換される。
        final log = BabyLog.fromJson({
          'id': 'id',
          'household_id': 'hh-1',
          'log_type': 'feeding',
          'logged_at': '2026-01-01T03:05:00+00:00', // Supabase 形式
          'logged_by': 'user-1',
          'created_at': '2026-01-01T03:05:00+00:00',
        });
        expect(log.loggedAt.isUtc, isTrue);
        // UTC 03:05 → JST 12:05 (端末 TZ 非依存)。
        expect(formatTimeJst(log.loggedAt), '12:05');
      },
    );
  });

  group('formatBabyDateLabel (原典 formatDateLabel)', () {
    test('今日は「今日」', () {
      expect(formatBabyDateLabel('2026-05-30', todayYmd: '2026-05-30'), '今日');
    });

    test('前日は「昨日」', () {
      expect(formatBabyDateLabel('2026-05-29', todayYmd: '2026-05-30'), '昨日');
    });

    test('それ以外は M/D（曜）— 曜日 mapping を検証', () {
      // 2026-05-28 は木曜日 (Dart weekday=4 → %7=4 → 配列[4]=木)。
      expect(
        formatBabyDateLabel('2026-05-28', todayYmd: '2026-05-30'),
        '5/28（木）',
      );
    });

    test('日曜日の mapping (Dart weekday=7 → %7=0 → 日)', () {
      // 2026-05-31 は日曜日。
      expect(
        formatBabyDateLabel('2026-05-31', todayYmd: '2026-06-02'),
        '5/31（日）',
      );
    });

    test('月曜日の mapping (Dart weekday=1 → %7=1 → 月)', () {
      // 2026-06-01 は月曜日。
      expect(
        formatBabyDateLabel('2026-06-01', todayYmd: '2026-06-03'),
        '6/1（月）',
      );
    });

    test('土曜日の mapping (Dart weekday=6 → %7=6 → 土)', () {
      // 2026-05-30 は土曜日。
      expect(
        formatBabyDateLabel('2026-05-30', todayYmd: '2026-06-01'),
        '5/30（土）',
      );
    });
  });

  group('getLogSummary (原典 getLogSummary を忠実に)', () {
    test('feeding: ラベルのみ (feeding_type なし)', () {
      expect(getLogSummary(_log(logType: BabyLogType.feeding)), '授乳');
    });

    test('feeding: ラベル + ml + 分', () {
      expect(
        getLogSummary(
          _log(
            logType: BabyLogType.feeding,
            feedingType: FeedingType.bottle,
            amountMl: 120,
            durationMin: 10,
          ),
        ),
        'ミルク 120ml 10分',
      );
    });

    test('feeding: ラベル + ml のみ (分なし)', () {
      expect(
        getLogSummary(
          _log(
            logType: BabyLogType.feeding,
            feedingType: FeedingType.breastLeft,
            amountMl: 80,
          ),
        ),
        '左 80ml',
      );
    });

    test('feeding: 0ml は原典の falsy 判定で表示しない', () {
      expect(
        getLogSummary(
          _log(
            logType: BabyLogType.feeding,
            feedingType: FeedingType.breastRight,
            amountMl: 0,
            durationMin: 0,
          ),
        ),
        '右',
      );
    });

    test('diaper: ラベル', () {
      expect(
        getLogSummary(
          _log(logType: BabyLogType.diaper, diaperType: DiaperType.poop),
        ),
        'うんち',
      );
    });

    test('diaper: type なしは「おむつ」', () {
      expect(getLogSummary(_log(logType: BabyLogType.diaper)), 'おむつ');
    });

    test('sleep: ended_at ありは経過時間', () {
      expect(
        getLogSummary(
          _log(
            logType: BabyLogType.sleep,
            loggedAt: DateTime.utc(2026, 1, 1, 10, 0),
            endedAt: DateTime.utc(2026, 1, 1, 11, 30),
          ),
        ),
        '1時間30分',
      );
    });

    test('sleep: ended_at なしは「睡眠中...」', () {
      expect(getLogSummary(_log(logType: BabyLogType.sleep)), '睡眠中...');
    });

    test('temperature: X℃', () {
      expect(
        getLogSummary(
          _log(logType: BabyLogType.temperature, temperature: 36.8),
        ),
        '36.8℃',
      );
    });

    test('temperature: 整数値は trailing .0 を落とす (JS number 互換)', () {
      // advisor 指摘 #4: Dart の (37.0).toString()=="37.0" だが原典 JS は "37"。
      // PostgREST numeric が "37" / 37.0 のどちらで返っても、表示は "37℃"。
      expect(
        getLogSummary(
          _log(logType: BabyLogType.temperature, temperature: 37.0),
        ),
        '37℃',
      );
    });

    test('temperature: なしは「体温」', () {
      expect(getLogSummary(_log(logType: BabyLogType.temperature)), '体温');
    });

    test('growth: Xg / Ycm', () {
      expect(
        getLogSummary(
          _log(logType: BabyLogType.growth, weightG: 5800, heightCm: 58.5),
        ),
        '5800g / 58.5cm',
      );
    });

    test('growth: 整数の身長は trailing .0 を落とす (JS number 互換)', () {
      expect(
        getLogSummary(
          _log(logType: BabyLogType.growth, weightG: 6000, heightCm: 60.0),
        ),
        '6000g / 60cm',
      );
    });

    test('growth: 体重のみ', () {
      expect(
        getLogSummary(_log(logType: BabyLogType.growth, weightG: 5800)),
        '5800g',
      );
    });

    test('growth: どちらもなしは「成長記録」', () {
      expect(getLogSummary(_log(logType: BabyLogType.growth)), '成長記録');
    });

    test('memo: 先頭20字', () {
      final long = 'あ' * 30;
      expect(
        getLogSummary(_log(logType: BabyLogType.memo, memo: long)),
        'あ' * 20,
      );
    });

    test('memo: 20字以下はそのまま', () {
      expect(
        getLogSummary(_log(logType: BabyLogType.memo, memo: 'ねんね良好')),
        'ねんね良好',
      );
    });

    test('memo: 空/null は「メモ」', () {
      expect(getLogSummary(_log(logType: BabyLogType.memo)), 'メモ');
      expect(getLogSummary(_log(logType: BabyLogType.memo, memo: '')), 'メモ');
    });
  });
}
