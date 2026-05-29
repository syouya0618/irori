import 'package:freezed_annotation/freezed_annotation.dart';

part 'baby_log.freezed.dart';
part 'baby_log.g.dart';

/// Postgres `numeric` 列は PostgREST が JSON 数値ではなく **引用符付き文字列**
/// (`"58.5"` 等) で返す場合がある。生成コードの `(json[x] as num?)?.toDouble()`
/// は String を渡されると `TypeError` で throw し、`fetchTodayLogs` の
/// `rows.map(fromJson)` がダッシュボード全体を AsyncError に倒してしまう
/// (CLAUDE.md「外部APIレスポンスの値は使用前に必ず検証」)。
///
/// そのため `numeric` 列 (`temperature` / `height_cm`) のみ、num/String 双方を
/// 許容する tolerant パーサを `@JsonKey(fromJson:)` で挟む。
/// int 列 (`weight_g` / `amount_ml` / `duration_min`) は PostgREST が確実に
/// JSON 数値で返すため対象外。
double? _numericFromJson(Object? value) {
  if (value == null) return null;
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value);
  return null;
}

/// 育児ログのタイプ discriminator。
///
/// `baby_logs.log_type` (Postgres ENUM `baby_log_type`) に 1:1 対応。
/// 実スキーマ確認済み (2026-05-29 `information_schema` / `pg_enum`):
/// feeding / diaper / sleep / temperature / growth / memo。
enum BabyLogType {
  @JsonValue('feeding')
  feeding,
  @JsonValue('diaper')
  diaper,
  @JsonValue('sleep')
  sleep,
  @JsonValue('temperature')
  temperature,
  @JsonValue('growth')
  growth,
  @JsonValue('memo')
  memo,
}

/// 授乳タイプ (`feeding_type` ENUM)。`log_type == feeding` 以外では null。
enum FeedingType {
  @JsonValue('breast_left')
  breastLeft,
  @JsonValue('breast_right')
  breastRight,
  @JsonValue('bottle')
  bottle,
  @JsonValue('solid')
  solid,
}

/// おむつタイプ (`diaper_type` ENUM)。`log_type == diaper` 以外では null。
enum DiaperType {
  @JsonValue('pee')
  pee,
  @JsonValue('poop')
  poop,
  @JsonValue('both')
  both,
}

/// 育児ログの単一エンティティ。
///
/// 設計: 単一テーブル + 型付き NULLable カラム + CHECK 制約 (DB 側で整合性保証)。
/// `baby_logs` 実スキーマ (16 列) に 1:1 対応する。Dart 型対応:
/// - `temperature` / `height_cm` : Postgres `numeric` → `double?`
/// - `weight_g` : `integer` → `int?`
/// - `amount_ml` / `duration_min` : `smallint` → `int?`
/// - timestamptz 列 : ISO 8601 文字列 → `DateTime` (UTC, supabase は UTC で返す)
///
/// `@JsonKey(name: ...)` で snake_case の DB 列名 ↔ camelCase Dart の対応を明示。
@freezed
sealed class BabyLog with _$BabyLog {
  const factory BabyLog({
    required String id,
    @JsonKey(name: 'household_id') required String householdId,
    @JsonKey(name: 'log_type') required BabyLogType logType,
    @JsonKey(name: 'logged_at') required DateTime loggedAt,
    @JsonKey(name: 'logged_by') required String loggedBy,
    @JsonKey(name: 'feeding_type') FeedingType? feedingType,
    @JsonKey(name: 'amount_ml') int? amountMl,
    @JsonKey(name: 'diaper_type') DiaperType? diaperType,
    @JsonKey(name: 'ended_at') DateTime? endedAt,
    @JsonKey(fromJson: _numericFromJson) double? temperature,
    @JsonKey(name: 'weight_g') int? weightG,
    @JsonKey(name: 'height_cm', fromJson: _numericFromJson) double? heightCm,
    @JsonKey(name: 'duration_min') int? durationMin,
    String? memo,
    @JsonKey(name: 'created_at') required DateTime createdAt,
    // updated_at は NOT NULL だが、page.tsx の SELECT では取得していない列。
    // Realtime payload (`payload.new`) には含まれるため nullable で受ける
    // (初期取得時の select でも含めるが、欠落しても壊れないように防御)。
    @JsonKey(name: 'updated_at') DateTime? updatedAt,
  }) = _BabyLog;

  factory BabyLog.fromJson(Map<String, dynamic> json) =>
      _$BabyLogFromJson(json);
}
