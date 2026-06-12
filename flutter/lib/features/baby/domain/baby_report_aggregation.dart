/// 育児記録レポートの集計ドメイン (純関数)。
///
/// Next.js 原典 `src/lib/domain/baby-log-aggregation.ts` の 1:1 移植
/// (Phase 2.6-1)。JST 日付境界・丸め・ソート順・null 扱いの quirk を原典の
/// 行単位で保存し、各宣言の doc に原典 file:line を付す
/// (`core/domain/suggestions/scoring.dart` の流儀)。
///
/// 正しさは `baby_report_aggregation_test.dart`
/// (原典 `__tests__/baby-log-aggregation.test.ts` 全 24 ケース複製 +
/// quirk 固定の Dart 追加ケース) で機械検証する (CLAUDE.md「検証可能性を担保」)。
library;

import 'package:intl/intl.dart';

import '../../../core/utils/jst_date.dart';
import 'baby_log.dart';

/// 集計に必要な最小ログ型。原典 `AggregationLogInput`
/// (`baby-log-aggregation.ts:5-16`)。
///
/// `loggedAt` / `endedAt` は原典どおり **ISO 8601 文字列のまま** 保持する。
/// 原典は `logged_at.localeCompare` の文字列ソート
/// (`baby-log-aggregation.ts:188,203`) を行うため、`DateTime` へ正規化すると
/// offset 表記差でソート quirk が変わりうる (web parity 優先)。
class AggregationLogInput {
  const AggregationLogInput({
    required this.logType,
    required this.loggedAt,
    this.feedingType,
    this.amountMl,
    this.diaperType,
    this.endedAt,
    this.temperature,
    this.weightG,
    this.heightCm,
  });

  /// `baby_logs` の 9 列 row (`src/app/api/baby-report/route.ts:55-57` の
  /// SELECT) から復元する。
  ///
  /// - ENUM 列は DB 値文字列を厳密 decode する。契約外の値は `ArgumentError`
  ///   (既存 `BabyLog.fromJson` の `$enumDecode` と同じ硬さ — 握り潰さない)。
  /// - `temperature` / `height_cm` は Postgres `numeric` 列で、PostgREST が
  ///   引用符付き文字列を返す場合がある (`baby_log.dart:6-21` と同 quirk)
  ///   ため num / String 双方を許容する。
  factory AggregationLogInput.fromJson(Map<String, dynamic> json) {
    return AggregationLogInput(
      logType: _decodeEnum(_logTypeFromDb, json['log_type'], 'log_type'),
      loggedAt: json['logged_at'] as String,
      feedingType: json['feeding_type'] == null
          ? null
          : _decodeEnum(
              _feedingTypeFromDb,
              json['feeding_type'],
              'feeding_type',
            ),
      amountMl: json['amount_ml'] as int?,
      diaperType: json['diaper_type'] == null
          ? null
          : _decodeEnum(_diaperTypeFromDb, json['diaper_type'], 'diaper_type'),
      endedAt: json['ended_at'] as String?,
      temperature: _numericFromJson(json['temperature']),
      weightG: json['weight_g'] as int?,
      heightCm: _numericFromJson(json['height_cm']),
    );
  }

  /// `log_type` (原典 `BabyLogType`)。
  final BabyLogType logType;

  /// `logged_at` の ISO 8601 文字列 (原典 `logged_at: string`)。
  final String loggedAt;

  /// `feeding_type` (原典 `FeedingType | null`)。
  final FeedingType? feedingType;

  /// `amount_ml` (原典 `number | null` / DB `smallint`)。
  final int? amountMl;

  /// `diaper_type` (原典 `DiaperType | null`)。
  final DiaperType? diaperType;

  /// `ended_at` の ISO 8601 文字列 (原典 `string | null`)。
  final String? endedAt;

  /// `temperature` (原典 `number | null` / DB `numeric`)。
  final double? temperature;

  /// `weight_g` (原典 `number | null` / DB `integer`)。
  final int? weightG;

  /// `height_cm` (原典 `number | null` / DB `numeric`)。
  final double? heightCm;
}

/// 日別授乳サマリー。原典 `DailyFeedingSummary` (`baby-log-aggregation.ts:18-26`)。
///
/// record 型で構造的等価性を得る (`baby_weekly_summary.dart` の流儀)。
typedef DailyFeedingSummary = ({
  String date,
  int totalCount,
  int breastCount,
  int bottleCount,
  int solidCount,
  int totalBottleMl,
  int? avgBottleMl,
});

/// 日別睡眠サマリー。原典 `DailySleepSummary` (`baby-log-aggregation.ts:28-32`)。
typedef DailySleepSummary = ({String date, int totalMinutes, int sessionCount});

/// 日別おむつサマリー。原典 `DailyDiaperSummary` (`baby-log-aggregation.ts:34-40`)。
typedef DailyDiaperSummary = ({
  String date,
  int totalCount,
  int peeCount,
  int poopCount,
  int bothCount,
});

/// 体温記録。原典 `TemperatureRecord` (`baby-log-aggregation.ts:42-46`)。
typedef TemperatureRecord = ({String date, String time, double temperature});

/// 成長記録。原典 `GrowthRecord` (`baby-log-aggregation.ts:48-52`)。
typedef GrowthRecord = ({String date, int? weightG, double? heightCm});

/// 日別授乳サマリー (JST 日付昇順)。原典 `aggregateFeedings`
/// (`baby-log-aggregation.ts:87-125`)。
///
/// quirk 保存:
/// - `totalCount` は **日の feeding ログ全件** (`dayLogs.length` `:117`)。
///   `feeding_type` が null の行も数える。
/// - `totalBottleMl` は `amount_ml != null && > 0` のみ加算 (`:107-109`) だが、
///   `bottleCount` は amount 不問で数える → 平均の分母に入る (`:122`)。
List<DailyFeedingSummary> aggregateFeedings(
  List<AggregationLogInput> logs,
  String startDate,
  String endDate,
) {
  final grouped = _groupByDate(
    _filterLogs(logs, BabyLogType.feeding, startDate, endDate),
  );

  return [
    for (final date in _sortedDates(grouped)) _feedingDay(date, grouped[date]!),
  ];
}

DailyFeedingSummary _feedingDay(
  String date,
  List<AggregationLogInput> dayLogs,
) {
  var breastCount = 0;
  var bottleCount = 0;
  var solidCount = 0;
  var totalBottleMl = 0;

  for (final log in dayLogs) {
    final type = log.feedingType;
    if (type == FeedingType.breastLeft || type == FeedingType.breastRight) {
      breastCount++;
    } else if (type == FeedingType.bottle) {
      bottleCount++;
      final amountMl = log.amountMl;
      if (amountMl != null && amountMl > 0) {
        totalBottleMl += amountMl;
      }
    } else if (type == FeedingType.solid) {
      solidCount++;
    }
  }

  return (
    date: date,
    totalCount: dayLogs.length,
    breastCount: breastCount,
    bottleCount: bottleCount,
    solidCount: solidCount,
    totalBottleMl: totalBottleMl,
    avgBottleMl: bottleCount > 0
        ? _jsMathRound(totalBottleMl / bottleCount)
        : null,
  );
}

/// 日別睡眠サマリー (JST 日付昇順)。原典 `aggregateSleep`
/// (`baby-log-aggregation.ts:127-149`)。
///
/// quirk 保存:
/// - グループ化は `logged_at` の JST 日付 — **日跨ぎ睡眠は開始日に全量帰属**
///   する (`baby_weekly_summary.dart` の日別 overlap 分割とは異なる)。
/// - `ended_at > logged_at` のガードは無く、異常データでは負の分を加算する
///   (`:140-145`)。丸めは [_jsMathRound] (JS `Math.round` parity)。
/// - 原典 `if (log.ended_at)` は JS truthy — null と空文字の両方を弾く。
List<DailySleepSummary> aggregateSleep(
  List<AggregationLogInput> logs,
  String startDate,
  String endDate,
) {
  final grouped = _groupByDate(
    _filterLogs(logs, BabyLogType.sleep, startDate, endDate),
  );

  return [
    for (final date in _sortedDates(grouped)) _sleepDay(date, grouped[date]!),
  ];
}

DailySleepSummary _sleepDay(String date, List<AggregationLogInput> dayLogs) {
  var totalMinutes = 0;
  var sessionCount = 0;

  for (final log in dayLogs) {
    final endedAt = log.endedAt;
    // 原典 `if (log.ended_at)` の JS truthy — null / 空文字の両方を弾く。
    if (endedAt != null && endedAt.isNotEmpty) {
      totalMinutes += _minutesBetween(log.loggedAt, endedAt);
      sessionCount++;
    }
  }

  return (date: date, totalMinutes: totalMinutes, sessionCount: sessionCount);
}

/// 日別おむつサマリー (JST 日付昇順)。原典 `aggregateDiapers`
/// (`baby-log-aggregation.ts:151-179`)。
///
/// quirk 保存: `totalCount` は日の diaper ログ全件 (`:173`) —
/// `diaper_type` が null の行も数える。
List<DailyDiaperSummary> aggregateDiapers(
  List<AggregationLogInput> logs,
  String startDate,
  String endDate,
) {
  final grouped = _groupByDate(
    _filterLogs(logs, BabyLogType.diaper, startDate, endDate),
  );

  return [
    for (final date in _sortedDates(grouped)) _diaperDay(date, grouped[date]!),
  ];
}

DailyDiaperSummary _diaperDay(String date, List<AggregationLogInput> dayLogs) {
  var peeCount = 0;
  var poopCount = 0;
  var bothCount = 0;

  for (final log in dayLogs) {
    if (log.diaperType == DiaperType.pee) {
      peeCount++;
    } else if (log.diaperType == DiaperType.poop) {
      poopCount++;
    } else if (log.diaperType == DiaperType.both) {
      bothCount++;
    }
  }

  return (
    date: date,
    totalCount: dayLogs.length,
    peeCount: peeCount,
    poopCount: poopCount,
    bothCount: bothCount,
  );
}

/// 体温記録の抽出 (logged_at 昇順)。原典 `extractTemperatures`
/// (`baby-log-aggregation.ts:181-194`)。
List<TemperatureRecord> extractTemperatures(
  List<AggregationLogInput> logs,
  String startDate,
  String endDate,
) {
  final filtered = _filterLogs(
    logs,
    BabyLogType.temperature,
    startDate,
    endDate,
  ).where((log) => log.temperature != null).toList();

  return [
    for (final log in _sortedByLoggedAt(filtered))
      (
        date: _toJstDateString(log.loggedAt),
        time: _formatTimeJst(log.loggedAt),
        temperature: log.temperature!,
      ),
  ];
}

/// 成長記録の抽出 (logged_at 昇順)。原典 `extractGrowth`
/// (`baby-log-aggregation.ts:196-209`)。
///
/// `weight_g` / `height_cm` のどちらかがあれば抽出する (`:202` の OR 条件)。
List<GrowthRecord> extractGrowth(
  List<AggregationLogInput> logs,
  String startDate,
  String endDate,
) {
  final filtered = _filterLogs(
    logs,
    BabyLogType.growth,
    startDate,
    endDate,
  ).where((log) => log.weightG != null || log.heightCm != null).toList();

  return [
    for (final log in _sortedByLoggedAt(filtered))
      (
        date: _toJstDateString(log.loggedAt),
        weightG: log.weightG,
        heightCm: log.heightCm,
      ),
  ];
}

/// 生年月日から月齢文字列を算出。原典 `calculateAge`
/// (`baby-log-aggregation.ts:211-230`)。
///
/// [birthDate] / [referenceDate] は "YYYY-MM-DD"。日の単純比較
/// (`rd < bd` で 1 ヶ月引く `:221`) のみで月末正規化はしない quirk を保存
/// (例: 01-31 生まれは 02-28 時点で「0ヶ月」)。
/// 不正入力は原典では NaN が文字列へ伝播するが、Dart は `int.parse` の
/// `FormatException` に倒す (正規入力 — DB `date` 列 / `formatJstDate` 出力 —
/// では到達しない。`jst_date.dart` の throw 規約と同じ扱い)。
String calculateAge(String birthDate, String referenceDate) {
  final birth = birthDate.split('-').map(int.parse).toList();
  final ref = referenceDate.split('-').map(int.parse).toList();

  var months = (ref[0] - birth[0]) * 12 + (ref[1] - birth[1]);
  if (ref[2] < birth[2]) months--;
  if (months < 0) return '0ヶ月';

  final years = months ~/ 12;
  final remainMonths = months % 12;

  if (years == 0) return '$remainMonthsヶ月';
  if (remainMonths == 0) return '$years歳';
  return '$years歳$remainMonthsヶ月';
}

// ---------------------------------------------------------------------------
// 内部ヘルパー (原典 private 関数の対応物 + Dart 側の quirk 保存装置)。
// ---------------------------------------------------------------------------

/// log_type + JST 日付範囲でフィルタ。原典 `filterLogs`
/// (`baby-log-aggregation.ts:54-66`)。
///
/// 範囲は **JST 日付文字列の閉区間** `[startDate, endDate]`
/// (原典 `d >= startDate && d <= endDate` の辞書順比較)。
List<AggregationLogInput> _filterLogs(
  List<AggregationLogInput> logs,
  BabyLogType logType,
  String startDate,
  String endDate,
) {
  return logs.where((log) {
    if (log.logType != logType) return false;
    final d = _toJstDateString(log.loggedAt);
    return d.compareTo(startDate) >= 0 && d.compareTo(endDate) <= 0;
  }).toList();
}

/// ログを JST 日付でグループ化。原典 `groupByDate`
/// (`baby-log-aggregation.ts:68-80`)。Dart の Map リテラルは挿入順を保持し
/// JS `Map` と同じ (順序はどのみち [_sortedDates] で確定する)。
Map<String, List<AggregationLogInput>> _groupByDate(
  List<AggregationLogInput> logs,
) {
  final map = <String, List<AggregationLogInput>>{};
  for (final log in logs) {
    map.putIfAbsent(_toJstDateString(log.loggedAt), () => []).add(log);
  }
  return map;
}

/// Map のキーを昇順ソートして返す。原典 `sortedDates`
/// (`baby-log-aggregation.ts:82-85`)。"YYYY-MM-DD" の辞書順 = 時系列順。
/// キーは一意のためソート安定性は不問。
List<String> _sortedDates(Map<String, Object?> map) =>
    map.keys.toList()..sort();

/// `logged_at` の **文字列** 昇順ソート。原典の
/// `a.logged_at.localeCompare(b.logged_at)` (`baby-log-aggregation.ts:188,203`)。
///
/// - 文字列比較 quirk を保存する (PostgREST は同一書式の ISO を返すため
///   時系列順と一致するが、`DateTime` 比較へは正規化しない)。
/// - JS `Array#sort` は ES2019 以降 stable、Dart `List.sort` は安定性未保証の
///   ため、index decorate で同値キーの元順序を明示的に保存する。
List<AggregationLogInput> _sortedByLoggedAt(List<AggregationLogInput> logs) {
  final indexed = logs.asMap().entries.toList()
    ..sort((a, b) {
      final byLoggedAt = a.value.loggedAt.compareTo(b.value.loggedAt);
      return byLoggedAt != 0 ? byLoggedAt : a.key.compareTo(b.key);
    });
  return [for (final entry in indexed) entry.value];
}

/// 原典 `toJstDateString` (`src/lib/utils/date-jst.ts:134-136`)。
///
/// `formatJstDate` (core/utils) は `Intl.DateTimeFormat("en-CA", Asia/Tokyo)`
/// と同値の JST 壁時計日付を返す (端末 TZ 非依存)。
String _toJstDateString(String iso) => formatJstDate(DateTime.parse(iso));

/// JST (Asia/Tokyo, UTC+9) 固定オフセット。`baby_weekly_summary.dart` と同流儀。
const Duration _kJstOffset = Duration(hours: 9);

/// 原典 `formatTimeJst` (`src/lib/utils/date-jst.ts:126-128`) — JST "HH:mm"。
///
/// presentation 層 `baby_display_utils.dart` の同名関数 (DateTime 引数) と
/// 重複するが、domain → presentation の逆依存を避ける duplication
/// (`baby_weekly_summary.dart` の既存パターン)。
String _formatTimeJst(String iso) {
  final jst = DateTime.parse(iso).toUtc().add(_kJstOffset);
  return DateFormat('HH:mm').format(jst);
}

/// 原典 `minutesBetween` (`src/lib/utils/baby-log-labels.ts:44-48`) —
/// 2 つの ISO 文字列の分差 (to - from)。
///
/// presentation 層 `baby_display_utils.dart` 版は `num.round()` だが、
/// `aggregateSleep` は負分が到達しうる (上記 quirk) ため、負の half で
/// 1 ずれない [_jsMathRound] を使い JS `Math.round` を厳密再現する。
/// sub-ms 精度の扱い (JS は ms 切り捨て後に差、Dart は µs 差を ms へ切り捨て)
/// は DB が µs 粒度のため分丸め結果に実質影響しない。
int _minutesBetween(String from, String to) {
  final diffMs = DateTime.parse(
    to,
  ).difference(DateTime.parse(from)).inMilliseconds;
  return _jsMathRound(diffMs / 60000);
}

/// JS `Math.round` の厳密再現 (half は +∞ 方向)。
///
/// Dart `num.round()` は half away from zero のため負の .5 で 1 ずれる
/// (JS: `Math.round(-1.5) === -1` / Dart: `(-1.5).round() == -2`)。
/// `floor(x + 0.5)` 形は `0.49999999999999994 + 0.5 == 1.0` の浮動小数点
/// 繰り上がりで JS とずれるため、floor との差分比較で実装する
/// (|x| < 2^52 で `x - floor(x)` は正確)。
int _jsMathRound(double x) {
  final floor = x.floorToDouble();
  return x - floor >= 0.5 ? floor.toInt() + 1 : floor.toInt();
}

/// Postgres `numeric` 列の tolerant パーサ。
/// `baby_log.dart` の `_numericFromJson` (`:6-21` に quirk 解説) と同実装 —
/// 同ファイル private のためここに再掲する。
double? _numericFromJson(Object? value) {
  if (value == null) return null;
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value);
  return null;
}

/// DB ENUM 文字列 → Dart enum の厳密 decode。
T _decodeEnum<T>(Map<String, T> table, Object? value, String column) {
  final decoded = table[value];
  if (decoded == null) {
    throw ArgumentError.value(value, column, '契約外の ENUM 値');
  }
  return decoded;
}

/// `baby_logs.log_type` の DB 値 → enum 対応 (`baby_log.dart` `@JsonValue` と同一)。
const Map<String, BabyLogType> _logTypeFromDb = {
  'feeding': BabyLogType.feeding,
  'diaper': BabyLogType.diaper,
  'sleep': BabyLogType.sleep,
  'temperature': BabyLogType.temperature,
  'growth': BabyLogType.growth,
  'memo': BabyLogType.memo,
};

/// `feeding_type` の DB 値 → enum 対応。
const Map<String, FeedingType> _feedingTypeFromDb = {
  'breast_left': FeedingType.breastLeft,
  'breast_right': FeedingType.breastRight,
  'bottle': FeedingType.bottle,
  'solid': FeedingType.solid,
};

/// `diaper_type` の DB 値 → enum 対応。
const Map<String, DiaperType> _diaperTypeFromDb = {
  'pee': DiaperType.pee,
  'poop': DiaperType.poop,
  'both': DiaperType.both,
};
