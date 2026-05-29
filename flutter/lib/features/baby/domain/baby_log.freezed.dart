// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'baby_log.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$BabyLog {

 String get id;@JsonKey(name: 'household_id') String get householdId;@JsonKey(name: 'log_type') BabyLogType get logType;@JsonKey(name: 'logged_at') DateTime get loggedAt;@JsonKey(name: 'logged_by') String get loggedBy;@JsonKey(name: 'feeding_type') FeedingType? get feedingType;@JsonKey(name: 'amount_ml') int? get amountMl;@JsonKey(name: 'diaper_type') DiaperType? get diaperType;@JsonKey(name: 'ended_at') DateTime? get endedAt;@JsonKey(fromJson: _numericFromJson) double? get temperature;@JsonKey(name: 'weight_g') int? get weightG;@JsonKey(name: 'height_cm', fromJson: _numericFromJson) double? get heightCm;@JsonKey(name: 'duration_min') int? get durationMin; String? get memo;@JsonKey(name: 'created_at') DateTime get createdAt;// updated_at は NOT NULL だが、page.tsx の SELECT では取得していない列。
// Realtime payload (`payload.new`) には含まれるため nullable で受ける
// (初期取得時の select でも含めるが、欠落しても壊れないように防御)。
@JsonKey(name: 'updated_at') DateTime? get updatedAt;
/// Create a copy of BabyLog
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$BabyLogCopyWith<BabyLog> get copyWith => _$BabyLogCopyWithImpl<BabyLog>(this as BabyLog, _$identity);

  /// Serializes this BabyLog to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is BabyLog&&(identical(other.id, id) || other.id == id)&&(identical(other.householdId, householdId) || other.householdId == householdId)&&(identical(other.logType, logType) || other.logType == logType)&&(identical(other.loggedAt, loggedAt) || other.loggedAt == loggedAt)&&(identical(other.loggedBy, loggedBy) || other.loggedBy == loggedBy)&&(identical(other.feedingType, feedingType) || other.feedingType == feedingType)&&(identical(other.amountMl, amountMl) || other.amountMl == amountMl)&&(identical(other.diaperType, diaperType) || other.diaperType == diaperType)&&(identical(other.endedAt, endedAt) || other.endedAt == endedAt)&&(identical(other.temperature, temperature) || other.temperature == temperature)&&(identical(other.weightG, weightG) || other.weightG == weightG)&&(identical(other.heightCm, heightCm) || other.heightCm == heightCm)&&(identical(other.durationMin, durationMin) || other.durationMin == durationMin)&&(identical(other.memo, memo) || other.memo == memo)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.updatedAt, updatedAt) || other.updatedAt == updatedAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,householdId,logType,loggedAt,loggedBy,feedingType,amountMl,diaperType,endedAt,temperature,weightG,heightCm,durationMin,memo,createdAt,updatedAt);

@override
String toString() {
  return 'BabyLog(id: $id, householdId: $householdId, logType: $logType, loggedAt: $loggedAt, loggedBy: $loggedBy, feedingType: $feedingType, amountMl: $amountMl, diaperType: $diaperType, endedAt: $endedAt, temperature: $temperature, weightG: $weightG, heightCm: $heightCm, durationMin: $durationMin, memo: $memo, createdAt: $createdAt, updatedAt: $updatedAt)';
}


}

/// @nodoc
abstract mixin class $BabyLogCopyWith<$Res>  {
  factory $BabyLogCopyWith(BabyLog value, $Res Function(BabyLog) _then) = _$BabyLogCopyWithImpl;
@useResult
$Res call({
 String id,@JsonKey(name: 'household_id') String householdId,@JsonKey(name: 'log_type') BabyLogType logType,@JsonKey(name: 'logged_at') DateTime loggedAt,@JsonKey(name: 'logged_by') String loggedBy,@JsonKey(name: 'feeding_type') FeedingType? feedingType,@JsonKey(name: 'amount_ml') int? amountMl,@JsonKey(name: 'diaper_type') DiaperType? diaperType,@JsonKey(name: 'ended_at') DateTime? endedAt,@JsonKey(fromJson: _numericFromJson) double? temperature,@JsonKey(name: 'weight_g') int? weightG,@JsonKey(name: 'height_cm', fromJson: _numericFromJson) double? heightCm,@JsonKey(name: 'duration_min') int? durationMin, String? memo,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'updated_at') DateTime? updatedAt
});




}
/// @nodoc
class _$BabyLogCopyWithImpl<$Res>
    implements $BabyLogCopyWith<$Res> {
  _$BabyLogCopyWithImpl(this._self, this._then);

  final BabyLog _self;
  final $Res Function(BabyLog) _then;

/// Create a copy of BabyLog
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? householdId = null,Object? logType = null,Object? loggedAt = null,Object? loggedBy = null,Object? feedingType = freezed,Object? amountMl = freezed,Object? diaperType = freezed,Object? endedAt = freezed,Object? temperature = freezed,Object? weightG = freezed,Object? heightCm = freezed,Object? durationMin = freezed,Object? memo = freezed,Object? createdAt = null,Object? updatedAt = freezed,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,householdId: null == householdId ? _self.householdId : householdId // ignore: cast_nullable_to_non_nullable
as String,logType: null == logType ? _self.logType : logType // ignore: cast_nullable_to_non_nullable
as BabyLogType,loggedAt: null == loggedAt ? _self.loggedAt : loggedAt // ignore: cast_nullable_to_non_nullable
as DateTime,loggedBy: null == loggedBy ? _self.loggedBy : loggedBy // ignore: cast_nullable_to_non_nullable
as String,feedingType: freezed == feedingType ? _self.feedingType : feedingType // ignore: cast_nullable_to_non_nullable
as FeedingType?,amountMl: freezed == amountMl ? _self.amountMl : amountMl // ignore: cast_nullable_to_non_nullable
as int?,diaperType: freezed == diaperType ? _self.diaperType : diaperType // ignore: cast_nullable_to_non_nullable
as DiaperType?,endedAt: freezed == endedAt ? _self.endedAt : endedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,temperature: freezed == temperature ? _self.temperature : temperature // ignore: cast_nullable_to_non_nullable
as double?,weightG: freezed == weightG ? _self.weightG : weightG // ignore: cast_nullable_to_non_nullable
as int?,heightCm: freezed == heightCm ? _self.heightCm : heightCm // ignore: cast_nullable_to_non_nullable
as double?,durationMin: freezed == durationMin ? _self.durationMin : durationMin // ignore: cast_nullable_to_non_nullable
as int?,memo: freezed == memo ? _self.memo : memo // ignore: cast_nullable_to_non_nullable
as String?,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,updatedAt: freezed == updatedAt ? _self.updatedAt : updatedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,
  ));
}

}


/// Adds pattern-matching-related methods to [BabyLog].
extension BabyLogPatterns on BabyLog {
/// A variant of `map` that fallback to returning `orElse`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _BabyLog value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _BabyLog() when $default != null:
return $default(_that);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// Callbacks receives the raw object, upcasted.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case final Subclass2 value:
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _BabyLog value)  $default,){
final _that = this;
switch (_that) {
case _BabyLog():
return $default(_that);}
}
/// A variant of `map` that fallback to returning `null`.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case final Subclass value:
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _BabyLog value)?  $default,){
final _that = this;
switch (_that) {
case _BabyLog() when $default != null:
return $default(_that);case _:
  return null;

}
}
/// A variant of `when` that fallback to an `orElse` callback.
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return orElse();
/// }
/// ```

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id, @JsonKey(name: 'household_id')  String householdId, @JsonKey(name: 'log_type')  BabyLogType logType, @JsonKey(name: 'logged_at')  DateTime loggedAt, @JsonKey(name: 'logged_by')  String loggedBy, @JsonKey(name: 'feeding_type')  FeedingType? feedingType, @JsonKey(name: 'amount_ml')  int? amountMl, @JsonKey(name: 'diaper_type')  DiaperType? diaperType, @JsonKey(name: 'ended_at')  DateTime? endedAt, @JsonKey(fromJson: _numericFromJson)  double? temperature, @JsonKey(name: 'weight_g')  int? weightG, @JsonKey(name: 'height_cm', fromJson: _numericFromJson)  double? heightCm, @JsonKey(name: 'duration_min')  int? durationMin,  String? memo, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'updated_at')  DateTime? updatedAt)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _BabyLog() when $default != null:
return $default(_that.id,_that.householdId,_that.logType,_that.loggedAt,_that.loggedBy,_that.feedingType,_that.amountMl,_that.diaperType,_that.endedAt,_that.temperature,_that.weightG,_that.heightCm,_that.durationMin,_that.memo,_that.createdAt,_that.updatedAt);case _:
  return orElse();

}
}
/// A `switch`-like method, using callbacks.
///
/// As opposed to `map`, this offers destructuring.
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case Subclass2(:final field2):
///     return ...;
/// }
/// ```

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id, @JsonKey(name: 'household_id')  String householdId, @JsonKey(name: 'log_type')  BabyLogType logType, @JsonKey(name: 'logged_at')  DateTime loggedAt, @JsonKey(name: 'logged_by')  String loggedBy, @JsonKey(name: 'feeding_type')  FeedingType? feedingType, @JsonKey(name: 'amount_ml')  int? amountMl, @JsonKey(name: 'diaper_type')  DiaperType? diaperType, @JsonKey(name: 'ended_at')  DateTime? endedAt, @JsonKey(fromJson: _numericFromJson)  double? temperature, @JsonKey(name: 'weight_g')  int? weightG, @JsonKey(name: 'height_cm', fromJson: _numericFromJson)  double? heightCm, @JsonKey(name: 'duration_min')  int? durationMin,  String? memo, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'updated_at')  DateTime? updatedAt)  $default,) {final _that = this;
switch (_that) {
case _BabyLog():
return $default(_that.id,_that.householdId,_that.logType,_that.loggedAt,_that.loggedBy,_that.feedingType,_that.amountMl,_that.diaperType,_that.endedAt,_that.temperature,_that.weightG,_that.heightCm,_that.durationMin,_that.memo,_that.createdAt,_that.updatedAt);}
}
/// A variant of `when` that fallback to returning `null`
///
/// It is equivalent to doing:
/// ```dart
/// switch (sealedClass) {
///   case Subclass(:final field):
///     return ...;
///   case _:
///     return null;
/// }
/// ```

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id, @JsonKey(name: 'household_id')  String householdId, @JsonKey(name: 'log_type')  BabyLogType logType, @JsonKey(name: 'logged_at')  DateTime loggedAt, @JsonKey(name: 'logged_by')  String loggedBy, @JsonKey(name: 'feeding_type')  FeedingType? feedingType, @JsonKey(name: 'amount_ml')  int? amountMl, @JsonKey(name: 'diaper_type')  DiaperType? diaperType, @JsonKey(name: 'ended_at')  DateTime? endedAt, @JsonKey(fromJson: _numericFromJson)  double? temperature, @JsonKey(name: 'weight_g')  int? weightG, @JsonKey(name: 'height_cm', fromJson: _numericFromJson)  double? heightCm, @JsonKey(name: 'duration_min')  int? durationMin,  String? memo, @JsonKey(name: 'created_at')  DateTime createdAt, @JsonKey(name: 'updated_at')  DateTime? updatedAt)?  $default,) {final _that = this;
switch (_that) {
case _BabyLog() when $default != null:
return $default(_that.id,_that.householdId,_that.logType,_that.loggedAt,_that.loggedBy,_that.feedingType,_that.amountMl,_that.diaperType,_that.endedAt,_that.temperature,_that.weightG,_that.heightCm,_that.durationMin,_that.memo,_that.createdAt,_that.updatedAt);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _BabyLog implements BabyLog {
  const _BabyLog({required this.id, @JsonKey(name: 'household_id') required this.householdId, @JsonKey(name: 'log_type') required this.logType, @JsonKey(name: 'logged_at') required this.loggedAt, @JsonKey(name: 'logged_by') required this.loggedBy, @JsonKey(name: 'feeding_type') this.feedingType, @JsonKey(name: 'amount_ml') this.amountMl, @JsonKey(name: 'diaper_type') this.diaperType, @JsonKey(name: 'ended_at') this.endedAt, @JsonKey(fromJson: _numericFromJson) this.temperature, @JsonKey(name: 'weight_g') this.weightG, @JsonKey(name: 'height_cm', fromJson: _numericFromJson) this.heightCm, @JsonKey(name: 'duration_min') this.durationMin, this.memo, @JsonKey(name: 'created_at') required this.createdAt, @JsonKey(name: 'updated_at') this.updatedAt});
  factory _BabyLog.fromJson(Map<String, dynamic> json) => _$BabyLogFromJson(json);

@override final  String id;
@override@JsonKey(name: 'household_id') final  String householdId;
@override@JsonKey(name: 'log_type') final  BabyLogType logType;
@override@JsonKey(name: 'logged_at') final  DateTime loggedAt;
@override@JsonKey(name: 'logged_by') final  String loggedBy;
@override@JsonKey(name: 'feeding_type') final  FeedingType? feedingType;
@override@JsonKey(name: 'amount_ml') final  int? amountMl;
@override@JsonKey(name: 'diaper_type') final  DiaperType? diaperType;
@override@JsonKey(name: 'ended_at') final  DateTime? endedAt;
@override@JsonKey(fromJson: _numericFromJson) final  double? temperature;
@override@JsonKey(name: 'weight_g') final  int? weightG;
@override@JsonKey(name: 'height_cm', fromJson: _numericFromJson) final  double? heightCm;
@override@JsonKey(name: 'duration_min') final  int? durationMin;
@override final  String? memo;
@override@JsonKey(name: 'created_at') final  DateTime createdAt;
// updated_at は NOT NULL だが、page.tsx の SELECT では取得していない列。
// Realtime payload (`payload.new`) には含まれるため nullable で受ける
// (初期取得時の select でも含めるが、欠落しても壊れないように防御)。
@override@JsonKey(name: 'updated_at') final  DateTime? updatedAt;

/// Create a copy of BabyLog
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$BabyLogCopyWith<_BabyLog> get copyWith => __$BabyLogCopyWithImpl<_BabyLog>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$BabyLogToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _BabyLog&&(identical(other.id, id) || other.id == id)&&(identical(other.householdId, householdId) || other.householdId == householdId)&&(identical(other.logType, logType) || other.logType == logType)&&(identical(other.loggedAt, loggedAt) || other.loggedAt == loggedAt)&&(identical(other.loggedBy, loggedBy) || other.loggedBy == loggedBy)&&(identical(other.feedingType, feedingType) || other.feedingType == feedingType)&&(identical(other.amountMl, amountMl) || other.amountMl == amountMl)&&(identical(other.diaperType, diaperType) || other.diaperType == diaperType)&&(identical(other.endedAt, endedAt) || other.endedAt == endedAt)&&(identical(other.temperature, temperature) || other.temperature == temperature)&&(identical(other.weightG, weightG) || other.weightG == weightG)&&(identical(other.heightCm, heightCm) || other.heightCm == heightCm)&&(identical(other.durationMin, durationMin) || other.durationMin == durationMin)&&(identical(other.memo, memo) || other.memo == memo)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt)&&(identical(other.updatedAt, updatedAt) || other.updatedAt == updatedAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,householdId,logType,loggedAt,loggedBy,feedingType,amountMl,diaperType,endedAt,temperature,weightG,heightCm,durationMin,memo,createdAt,updatedAt);

@override
String toString() {
  return 'BabyLog(id: $id, householdId: $householdId, logType: $logType, loggedAt: $loggedAt, loggedBy: $loggedBy, feedingType: $feedingType, amountMl: $amountMl, diaperType: $diaperType, endedAt: $endedAt, temperature: $temperature, weightG: $weightG, heightCm: $heightCm, durationMin: $durationMin, memo: $memo, createdAt: $createdAt, updatedAt: $updatedAt)';
}


}

/// @nodoc
abstract mixin class _$BabyLogCopyWith<$Res> implements $BabyLogCopyWith<$Res> {
  factory _$BabyLogCopyWith(_BabyLog value, $Res Function(_BabyLog) _then) = __$BabyLogCopyWithImpl;
@override @useResult
$Res call({
 String id,@JsonKey(name: 'household_id') String householdId,@JsonKey(name: 'log_type') BabyLogType logType,@JsonKey(name: 'logged_at') DateTime loggedAt,@JsonKey(name: 'logged_by') String loggedBy,@JsonKey(name: 'feeding_type') FeedingType? feedingType,@JsonKey(name: 'amount_ml') int? amountMl,@JsonKey(name: 'diaper_type') DiaperType? diaperType,@JsonKey(name: 'ended_at') DateTime? endedAt,@JsonKey(fromJson: _numericFromJson) double? temperature,@JsonKey(name: 'weight_g') int? weightG,@JsonKey(name: 'height_cm', fromJson: _numericFromJson) double? heightCm,@JsonKey(name: 'duration_min') int? durationMin, String? memo,@JsonKey(name: 'created_at') DateTime createdAt,@JsonKey(name: 'updated_at') DateTime? updatedAt
});




}
/// @nodoc
class __$BabyLogCopyWithImpl<$Res>
    implements _$BabyLogCopyWith<$Res> {
  __$BabyLogCopyWithImpl(this._self, this._then);

  final _BabyLog _self;
  final $Res Function(_BabyLog) _then;

/// Create a copy of BabyLog
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? householdId = null,Object? logType = null,Object? loggedAt = null,Object? loggedBy = null,Object? feedingType = freezed,Object? amountMl = freezed,Object? diaperType = freezed,Object? endedAt = freezed,Object? temperature = freezed,Object? weightG = freezed,Object? heightCm = freezed,Object? durationMin = freezed,Object? memo = freezed,Object? createdAt = null,Object? updatedAt = freezed,}) {
  return _then(_BabyLog(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,householdId: null == householdId ? _self.householdId : householdId // ignore: cast_nullable_to_non_nullable
as String,logType: null == logType ? _self.logType : logType // ignore: cast_nullable_to_non_nullable
as BabyLogType,loggedAt: null == loggedAt ? _self.loggedAt : loggedAt // ignore: cast_nullable_to_non_nullable
as DateTime,loggedBy: null == loggedBy ? _self.loggedBy : loggedBy // ignore: cast_nullable_to_non_nullable
as String,feedingType: freezed == feedingType ? _self.feedingType : feedingType // ignore: cast_nullable_to_non_nullable
as FeedingType?,amountMl: freezed == amountMl ? _self.amountMl : amountMl // ignore: cast_nullable_to_non_nullable
as int?,diaperType: freezed == diaperType ? _self.diaperType : diaperType // ignore: cast_nullable_to_non_nullable
as DiaperType?,endedAt: freezed == endedAt ? _self.endedAt : endedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,temperature: freezed == temperature ? _self.temperature : temperature // ignore: cast_nullable_to_non_nullable
as double?,weightG: freezed == weightG ? _self.weightG : weightG // ignore: cast_nullable_to_non_nullable
as int?,heightCm: freezed == heightCm ? _self.heightCm : heightCm // ignore: cast_nullable_to_non_nullable
as double?,durationMin: freezed == durationMin ? _self.durationMin : durationMin // ignore: cast_nullable_to_non_nullable
as int?,memo: freezed == memo ? _self.memo : memo // ignore: cast_nullable_to_non_nullable
as String?,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,updatedAt: freezed == updatedAt ? _self.updatedAt : updatedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,
  ));
}


}

// dart format on
