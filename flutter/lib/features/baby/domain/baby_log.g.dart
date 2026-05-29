// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'baby_log.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_BabyLog _$BabyLogFromJson(Map<String, dynamic> json) => _BabyLog(
  id: json['id'] as String,
  householdId: json['household_id'] as String,
  logType: $enumDecode(_$BabyLogTypeEnumMap, json['log_type']),
  loggedAt: DateTime.parse(json['logged_at'] as String),
  loggedBy: json['logged_by'] as String,
  feedingType: $enumDecodeNullable(_$FeedingTypeEnumMap, json['feeding_type']),
  amountMl: (json['amount_ml'] as num?)?.toInt(),
  diaperType: $enumDecodeNullable(_$DiaperTypeEnumMap, json['diaper_type']),
  endedAt: json['ended_at'] == null
      ? null
      : DateTime.parse(json['ended_at'] as String),
  temperature: _numericFromJson(json['temperature']),
  weightG: (json['weight_g'] as num?)?.toInt(),
  heightCm: _numericFromJson(json['height_cm']),
  durationMin: (json['duration_min'] as num?)?.toInt(),
  memo: json['memo'] as String?,
  createdAt: DateTime.parse(json['created_at'] as String),
  updatedAt: json['updated_at'] == null
      ? null
      : DateTime.parse(json['updated_at'] as String),
);

Map<String, dynamic> _$BabyLogToJson(_BabyLog instance) => <String, dynamic>{
  'id': instance.id,
  'household_id': instance.householdId,
  'log_type': _$BabyLogTypeEnumMap[instance.logType]!,
  'logged_at': instance.loggedAt.toIso8601String(),
  'logged_by': instance.loggedBy,
  'feeding_type': _$FeedingTypeEnumMap[instance.feedingType],
  'amount_ml': instance.amountMl,
  'diaper_type': _$DiaperTypeEnumMap[instance.diaperType],
  'ended_at': instance.endedAt?.toIso8601String(),
  'temperature': instance.temperature,
  'weight_g': instance.weightG,
  'height_cm': instance.heightCm,
  'duration_min': instance.durationMin,
  'memo': instance.memo,
  'created_at': instance.createdAt.toIso8601String(),
  'updated_at': instance.updatedAt?.toIso8601String(),
};

const _$BabyLogTypeEnumMap = {
  BabyLogType.feeding: 'feeding',
  BabyLogType.diaper: 'diaper',
  BabyLogType.sleep: 'sleep',
  BabyLogType.temperature: 'temperature',
  BabyLogType.growth: 'growth',
  BabyLogType.memo: 'memo',
};

const _$FeedingTypeEnumMap = {
  FeedingType.breastLeft: 'breast_left',
  FeedingType.breastRight: 'breast_right',
  FeedingType.bottle: 'bottle',
  FeedingType.solid: 'solid',
};

const _$DiaperTypeEnumMap = {
  DiaperType.pee: 'pee',
  DiaperType.poop: 'poop',
  DiaperType.both: 'both',
};
