import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/domain/baby_report_aggregation.dart';

/// 原典 `src/lib/domain/__tests__/baby-log-aggregation.test.ts` の全 24 ケースを
/// 1:1 複製し、quirk を固定する Dart 追加ケースを「Dart 追加:」prefix で足す。
///
/// 基準日: 2026-04-11 JST 12:00 (UTC 03:00)。原典 `BASE`。
final DateTime _base = DateTime.utc(2026, 4, 11, 3);

/// 原典 `mkLog` — [hoursAgo] 時間前のログを生成する。
/// `DateTime.toIso8601String()` は UTC で `...T01:00:00.000Z` 形式を返し、
/// 原典 `Date#toISOString()` と同一書式になる。
AggregationLogInput _mkLog(
  BabyLogType logType,
  int hoursAgo, {
  FeedingType? feedingType,
  int? amountMl,
  DiaperType? diaperType,
  String? endedAt,
  double? temperature,
  int? weightG,
  double? heightCm,
}) {
  final date = _base.subtract(Duration(hours: hoursAgo));
  return AggregationLogInput(
    logType: logType,
    loggedAt: date.toIso8601String(),
    feedingType: feedingType,
    amountMl: amountMl,
    diaperType: diaperType,
    endedAt: endedAt,
    temperature: temperature,
    weightG: weightG,
    heightCm: heightCm,
  );
}

/// 原典 `START` / `END`。
const _start = '2026-04-04';
const _end = '2026-04-11';

void main() {
  // ─── aggregateFeedings ──────────────────────────────────

  group('aggregateFeedings', () {
    test('空ログ → 空配列', () {
      expect(aggregateFeedings(const [], _start, _end), isEmpty);
    });

    test('授乳種別を正しくカウント', () {
      final logs = [
        _mkLog(BabyLogType.feeding, 2, feedingType: FeedingType.breastLeft),
        _mkLog(BabyLogType.feeding, 3, feedingType: FeedingType.breastRight),
        _mkLog(
          BabyLogType.feeding,
          4,
          feedingType: FeedingType.bottle,
          amountMl: 100,
        ),
        _mkLog(
          BabyLogType.feeding,
          5,
          feedingType: FeedingType.bottle,
          amountMl: 120,
        ),
        _mkLog(BabyLogType.feeding, 6, feedingType: FeedingType.solid),
      ];
      final result = aggregateFeedings(logs, _start, _end);
      expect(result, hasLength(1));
      expect(result[0].totalCount, 5);
      expect(result[0].breastCount, 2);
      expect(result[0].bottleCount, 2);
      expect(result[0].solidCount, 1);
      expect(result[0].totalBottleMl, 220);
      expect(result[0].avgBottleMl, 110);
    });

    test('ミルクなし → avgBottleMl は null', () {
      final logs = [
        _mkLog(BabyLogType.feeding, 2, feedingType: FeedingType.breastLeft),
      ];
      final result = aggregateFeedings(logs, _start, _end);
      expect(result[0].avgBottleMl, isNull);
    });

    test('日付範囲外のログは除外', () {
      final logs = [
        // 10日前 → 範囲外
        _mkLog(
          BabyLogType.feeding,
          24 * 10,
          feedingType: FeedingType.bottle,
          amountMl: 50,
        ),
        _mkLog(
          BabyLogType.feeding,
          2,
          feedingType: FeedingType.bottle,
          amountMl: 100,
        ),
      ];
      final result = aggregateFeedings(logs, _start, _end);
      expect(result, hasLength(1));
      expect(result[0].totalBottleMl, 100);
    });

    test('他のlog_typeは除外', () {
      final logs = [
        _mkLog(
          BabyLogType.feeding,
          2,
          feedingType: FeedingType.bottle,
          amountMl: 100,
        ),
        _mkLog(BabyLogType.diaper, 2, diaperType: DiaperType.pee),
      ];
      final result = aggregateFeedings(logs, _start, _end);
      expect(result, hasLength(1));
      expect(result[0].totalCount, 1);
    });

    test('複数日のデータを日付昇順で返す', () {
      final logs = [
        // 4/11
        _mkLog(
          BabyLogType.feeding,
          2,
          feedingType: FeedingType.bottle,
          amountMl: 100,
        ),
        // 4/10
        _mkLog(
          BabyLogType.feeding,
          24 + 2,
          feedingType: FeedingType.breastLeft,
        ),
      ];
      final result = aggregateFeedings(logs, _start, _end);
      expect(result, hasLength(2));
      expect(result[0].date, '2026-04-10');
      expect(result[1].date, '2026-04-11');
    });

    test('Dart 追加: amount_ml 0/null のミルクは合計に入らぬが平均の分母には入る', () {
      // 原典 :105-109 — bottleCount は amount 不問で加算、totalBottleMl は
      // `amount_ml > 0` のみ。avg = Math.round(100 / 3) = 33 (:122)。
      final logs = [
        _mkLog(
          BabyLogType.feeding,
          2,
          feedingType: FeedingType.bottle,
          amountMl: 100,
        ),
        _mkLog(
          BabyLogType.feeding,
          3,
          feedingType: FeedingType.bottle,
          amountMl: 0,
        ),
        _mkLog(BabyLogType.feeding, 4, feedingType: FeedingType.bottle),
      ];
      final result = aggregateFeedings(logs, _start, _end);
      expect(result[0].bottleCount, 3);
      expect(result[0].totalBottleMl, 100);
      expect(result[0].avgBottleMl, 33);
    });

    test('Dart 追加: feeding_type null は totalCount のみに数える', () {
      // 原典 :117 — totalCount は dayLogs.length。種別 if 連鎖はどれにも該当せず。
      final logs = [_mkLog(BabyLogType.feeding, 2)];
      final result = aggregateFeedings(logs, _start, _end);
      expect(result[0].totalCount, 1);
      expect(result[0].breastCount, 0);
      expect(result[0].bottleCount, 0);
      expect(result[0].solidCount, 0);
      expect(result[0].avgBottleMl, isNull);
    });

    test('Dart 追加 (review H1): avgBottleMl の正の .5 は +∞ 方向へ繰り上がる', () {
      // bottleCount=2 / totalBottleMl=1 → 0.5 → JS `Math.round(0.5) === 1`。
      // amount 0 のミルクが「合計に入らず分母に入る」quirk を使い、丸め境界
      // そのものを集計経路経由で機械固定する。
      //
      // なお浮動小数点罠 0.49999999999999994 (`x + 0.5` 加算だと 1.0 へ
      // 繰り上がる最大の <0.5 double = (2^53-1)/2^54) は、`_jsMathRound` への
      // 入力が常に整数比 — avgBottleMl は分母 bottleCount ≤ 5000 (limit)、
      // `_minutesBetween` は整数 ms / 60000 — であり、この dyadic rational へ
      // 量子化されるには 2^27 オーダー以上の分母を要するため、**集計経路では
      // 構成不能** (floor 差分比較の実装は防御として罠を回避するが、到達経路が
      // 無いことをここに記録する / review H1。経路が生まれたら直接固定すること)。
      final logs = [
        _mkLog(
          BabyLogType.feeding,
          2,
          feedingType: FeedingType.bottle,
          amountMl: 1,
        ),
        _mkLog(
          BabyLogType.feeding,
          3,
          feedingType: FeedingType.bottle,
          amountMl: 0,
        ),
      ];
      final result = aggregateFeedings(logs, _start, _end);
      expect(result[0].bottleCount, 2);
      expect(result[0].totalBottleMl, 1);
      expect(result[0].avgBottleMl, 1); // Math.round(0.5) === 1 (+∞ 方向)
    });

    test('Dart 追加: JST 下限境界 — startDate 00:00 JST ちょうどは含み、直前は除外', () {
      const logs = [
        // 2026-04-03T15:00Z = 2026-04-04 00:00 JST → 含む
        AggregationLogInput(
          logType: BabyLogType.feeding,
          loggedAt: '2026-04-03T15:00:00.000Z',
        ),
        // 2026-04-03T14:59:59Z = 2026-04-03 23:59:59 JST → 除外
        AggregationLogInput(
          logType: BabyLogType.feeding,
          loggedAt: '2026-04-03T14:59:59.000Z',
        ),
      ];
      final result = aggregateFeedings(logs, _start, _end);
      expect(result, hasLength(1));
      expect(result[0].date, '2026-04-04');
      expect(result[0].totalCount, 1);
    });

    test('Dart 追加: JST 上限境界 — endDate 23:59 JST は含み、翌日 00:00 JST は除外', () {
      const logs = [
        // 2026-04-11T14:59Z = 2026-04-11 23:59 JST → 含む
        AggregationLogInput(
          logType: BabyLogType.feeding,
          loggedAt: '2026-04-11T14:59:00.000Z',
        ),
        // 2026-04-11T15:00Z = 2026-04-12 00:00 JST → 除外
        AggregationLogInput(
          logType: BabyLogType.feeding,
          loggedAt: '2026-04-11T15:00:00.000Z',
        ),
      ];
      final result = aggregateFeedings(logs, _start, _end);
      expect(result, hasLength(1));
      expect(result[0].date, '2026-04-11');
      expect(result[0].totalCount, 1);
    });
  });

  // ─── aggregateSleep ─────────────────────────────────────

  group('aggregateSleep', () {
    test('空ログ → 空配列', () {
      expect(aggregateSleep(const [], _start, _end), isEmpty);
    });

    test('完了した睡眠の合計時間を算出', () {
      const logs = [
        // JST 09:00 〜 10:30 → 90分
        AggregationLogInput(
          logType: BabyLogType.sleep,
          loggedAt: '2026-04-11T00:00:00.000Z',
          endedAt: '2026-04-11T01:30:00.000Z',
        ),
        // JST 14:00 〜 15:00 → 60分
        AggregationLogInput(
          logType: BabyLogType.sleep,
          loggedAt: '2026-04-11T05:00:00.000Z',
          endedAt: '2026-04-11T06:00:00.000Z',
        ),
      ];
      final result = aggregateSleep(logs, _start, _end);
      expect(result, hasLength(1));
      expect(result[0].totalMinutes, 150);
      expect(result[0].sessionCount, 2);
    });

    test('未完了の睡眠（ended_at なし）はセッション数に含まない', () {
      final logs = [
        _mkLog(BabyLogType.sleep, 2), // endedAt = null
      ];
      final result = aggregateSleep(logs, _start, _end);
      expect(result, hasLength(1));
      expect(result[0].totalMinutes, 0);
      expect(result[0].sessionCount, 0);
    });

    test('Dart 追加: 日跨ぎ睡眠は開始日 (logged_at の JST 日付) に全量帰属する', () {
      // 原典 :135-147 は logged_at でグループ化したまま分を加算する —
      // `buildBabyWeeklySummary` の日別 overlap 分割とは異なる quirk。
      const logs = [
        // 4/10 23:00 JST 〜 4/11 01:00 JST (120分)
        AggregationLogInput(
          logType: BabyLogType.sleep,
          loggedAt: '2026-04-10T14:00:00.000Z',
          endedAt: '2026-04-10T16:00:00.000Z',
        ),
      ];
      final result = aggregateSleep(logs, _start, _end);
      expect(result, hasLength(1));
      expect(result[0].date, '2026-04-10');
      expect(result[0].totalMinutes, 120);
      expect(result[0].sessionCount, 1);
    });

    test(
      'Dart 追加: ended_at < logged_at は負の分を加算する (原典ガード無し / JS Math.round)',
      () {
        // 原典 :140-145 に ended_at > logged_at のガードは無い。
        // -90 秒 = -1.5 分 → JS `Math.round(-1.5) === -1`
        // (Dart `(-1.5).round() == -2` とは異なる half toward +∞)。
        const logs = [
          AggregationLogInput(
            logType: BabyLogType.sleep,
            loggedAt: '2026-04-11T03:00:00.000Z',
            endedAt: '2026-04-11T02:58:30.000Z',
          ),
        ];
        final result = aggregateSleep(logs, _start, _end);
        expect(result, hasLength(1));
        expect(result[0].totalMinutes, -1);
        expect(result[0].sessionCount, 1);
      },
    );

    test(
      'Dart 追加 (review H1): -0.5 分は 0 へ丸める (JS Math.round(-0.5) === -0)',
      () {
        // -30 秒 = -0.5 分 → JS は half を +∞ 方向へ丸め -0 (数値としては 0)。
        // Dart naive `(-0.5).round() == -1` (half away from zero) との差を
        // 集計経路経由で機械固定する — `_jsMathRound` の負ゼロ付近境界。
        const logs = [
          AggregationLogInput(
            logType: BabyLogType.sleep,
            loggedAt: '2026-04-11T03:00:00.000Z',
            endedAt: '2026-04-11T02:59:30.000Z',
          ),
        ];
        final result = aggregateSleep(logs, _start, _end);
        expect(result, hasLength(1));
        expect(result[0].totalMinutes, 0);
        expect(result[0].sessionCount, 1);
      },
    );
  });

  // ─── aggregateDiapers ───────────────────────────────────

  group('aggregateDiapers', () {
    test('空ログ → 空配列', () {
      expect(aggregateDiapers(const [], _start, _end), isEmpty);
    });

    test('おむつ種別を正しくカウント', () {
      final logs = [
        _mkLog(BabyLogType.diaper, 1, diaperType: DiaperType.pee),
        _mkLog(BabyLogType.diaper, 2, diaperType: DiaperType.pee),
        _mkLog(BabyLogType.diaper, 3, diaperType: DiaperType.poop),
        _mkLog(BabyLogType.diaper, 4, diaperType: DiaperType.both),
      ];
      final result = aggregateDiapers(logs, _start, _end);
      expect(result, hasLength(1));
      expect(result[0].totalCount, 4);
      expect(result[0].peeCount, 2);
      expect(result[0].poopCount, 1);
      expect(result[0].bothCount, 1);
    });
  });

  // ─── extractTemperatures ────────────────────────────────

  group('extractTemperatures', () {
    test('空ログ → 空配列', () {
      expect(extractTemperatures(const [], _start, _end), isEmpty);
    });

    test('体温記録を抽出', () {
      final logs = [
        _mkLog(BabyLogType.temperature, 2, temperature: 36.5),
        _mkLog(BabyLogType.temperature, 26, temperature: 37.2), // 前日
      ];
      final result = extractTemperatures(logs, _start, _end);
      expect(result, hasLength(2));
      expect(result[0].temperature, 37.2);
      expect(result[1].temperature, 36.5);
    });

    test('temperature が null のログは除外', () {
      final logs = [_mkLog(BabyLogType.temperature, 2)];
      expect(extractTemperatures(logs, _start, _end), isEmpty);
    });

    test('Dart 追加: date は JST 日付・time は JST "HH:mm"', () {
      // hoursAgo 2 → 2026-04-11T01:00Z = JST 4/11 10:00。
      final logs = [_mkLog(BabyLogType.temperature, 2, temperature: 36.5)];
      final result = extractTemperatures(logs, _start, _end);
      expect(result, [
        (date: '2026-04-11', time: '10:00', temperature: 36.5),
      ]);
    });

    test('Dart 追加: 同一 logged_at の体温は元順序を保存する (JS stable sort parity)', () {
      // 原典 :188 `a.logged_at.localeCompare(b.logged_at)` — ES2019 以降の
      // `Array#sort` は stable。Dart `List.sort` は安定性未保証のため、
      // 実装が同値キーの相対順を明示的に保存していることを固定する。
      final logs = [
        _mkLog(BabyLogType.temperature, 2, temperature: 36.5),
        _mkLog(BabyLogType.temperature, 2, temperature: 37.0),
        _mkLog(BabyLogType.temperature, 2, temperature: 36.8),
      ];
      final result = extractTemperatures(logs, _start, _end);
      expect(result.map((r) => r.temperature).toList(), [36.5, 37.0, 36.8]);
    });
  });

  // ─── extractGrowth ──────────────────────────────────────

  group('extractGrowth', () {
    test('空ログ → 空配列', () {
      expect(extractGrowth(const [], _start, _end), isEmpty);
    });

    test('成長記録を抽出', () {
      final logs = [
        _mkLog(BabyLogType.growth, 2, weightG: 5200, heightCm: 58.5),
      ];
      final result = extractGrowth(logs, _start, _end);
      expect(result, hasLength(1));
      expect(result[0].weightG, 5200);
      expect(result[0].heightCm, 58.5);
    });

    test('体重のみでも抽出される', () {
      final logs = [_mkLog(BabyLogType.growth, 2, weightG: 5200)];
      expect(extractGrowth(logs, _start, _end), hasLength(1));
    });

    test('weight_g も height_cm も null なら除外', () {
      final logs = [_mkLog(BabyLogType.growth, 2)];
      expect(extractGrowth(logs, _start, _end), isEmpty);
    });

    test('Dart 追加: 身長のみでも抽出される (OR 条件の対称ケース)', () {
      // 原典 :202 `weight_g != null || height_cm != null`。
      final logs = [_mkLog(BabyLogType.growth, 2, heightCm: 58.5)];
      final result = extractGrowth(logs, _start, _end);
      expect(result, [
        (date: '2026-04-11', weightG: null, heightCm: 58.5),
      ]);
    });
  });

  // ─── calculateAge ───────────────────────────────────────

  group('calculateAge', () {
    test('同月 → 0ヶ月', () {
      expect(calculateAge('2026-04-01', '2026-04-11'), '0ヶ月');
    });

    test('3ヶ月', () {
      expect(calculateAge('2026-01-11', '2026-04-11'), '3ヶ月');
    });

    test('日が足りない場合は1ヶ月引く', () {
      expect(calculateAge('2026-01-15', '2026-04-11'), '2ヶ月');
    });

    test('1歳ちょうど', () {
      expect(calculateAge('2025-04-11', '2026-04-11'), '1歳');
    });

    test('1歳2ヶ月', () {
      expect(calculateAge('2025-02-11', '2026-04-11'), '1歳2ヶ月');
    });

    test('未来の生年月日 → 0ヶ月', () {
      expect(calculateAge('2026-05-01', '2026-04-11'), '0ヶ月');
    });

    test('Dart 追加: 月末生まれは日の単純比較で繰り下がる (01-31 → 02-28 は 0ヶ月)', () {
      // 原典 :220-221 は `rd < bd` の単純比較のみで月末正規化をしない quirk。
      expect(calculateAge('2026-01-31', '2026-02-28'), '0ヶ月');
    });
  });

  // ─── AggregationLogInput.fromJson (Dart 追加) ───────────

  group('AggregationLogInput.fromJson (Dart 追加)', () {
    test('route.ts:55-57 の 9 列 row を復元する', () {
      final log = AggregationLogInput.fromJson(const {
        'log_type': 'feeding',
        'logged_at': '2026-04-11T01:00:00+00:00',
        'feeding_type': 'breast_left',
        'amount_ml': 120,
        'diaper_type': null,
        'ended_at': null,
        'temperature': null,
        'weight_g': null,
        'height_cm': null,
      });
      expect(log.logType, BabyLogType.feeding);
      expect(log.loggedAt, '2026-04-11T01:00:00+00:00');
      expect(log.feedingType, FeedingType.breastLeft);
      expect(log.amountMl, 120);
      expect(log.diaperType, isNull);
      expect(log.endedAt, isNull);
      expect(log.temperature, isNull);
      expect(log.weightG, isNull);
      expect(log.heightCm, isNull);
    });

    test('numeric 列 (temperature / height_cm) の引用符付き文字列を許容する', () {
      // PostgREST が numeric を `"58.5"` 等で返す quirk (baby_log.dart:6-21)。
      final log = AggregationLogInput.fromJson(const {
        'log_type': 'growth',
        'logged_at': '2026-04-11T01:00:00+00:00',
        'feeding_type': null,
        'amount_ml': null,
        'diaper_type': null,
        'ended_at': null,
        'temperature': '36.5',
        'weight_g': 5200,
        'height_cm': '58.5',
      });
      expect(log.temperature, 36.5);
      expect(log.weightG, 5200);
      expect(log.heightCm, 58.5);
    });

    test('契約外の ENUM 値は ArgumentError (握り潰さない)', () {
      expect(
        () => AggregationLogInput.fromJson(const {
          'log_type': 'bath',
          'logged_at': '2026-04-11T01:00:00+00:00',
        }),
        throwsArgumentError,
      );
    });
  });
}
