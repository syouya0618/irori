// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'shopping_item.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$ShoppingItem {

 String get id;@JsonKey(name: 'household_id') String get householdId; String get name; String? get quantity;@JsonKey(fromJson: _itemCategoryFromJson) ItemCategory get category;@JsonKey(name: 'store_type', fromJson: _storeTypeFromJson) StoreType get storeType;@JsonKey(name: 'is_checked') bool get isChecked;@JsonKey(name: 'checked_by') String? get checkedBy;@JsonKey(name: 'checked_at') DateTime? get checkedAt;@JsonKey(name: 'meal_id') String? get mealId;@JsonKey(name: 'sort_order') int get sortOrder;@JsonKey(name: 'created_by') String get createdBy;@JsonKey(name: 'created_at') DateTime get createdAt;
/// Create a copy of ShoppingItem
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$ShoppingItemCopyWith<ShoppingItem> get copyWith => _$ShoppingItemCopyWithImpl<ShoppingItem>(this as ShoppingItem, _$identity);

  /// Serializes this ShoppingItem to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is ShoppingItem&&(identical(other.id, id) || other.id == id)&&(identical(other.householdId, householdId) || other.householdId == householdId)&&(identical(other.name, name) || other.name == name)&&(identical(other.quantity, quantity) || other.quantity == quantity)&&(identical(other.category, category) || other.category == category)&&(identical(other.storeType, storeType) || other.storeType == storeType)&&(identical(other.isChecked, isChecked) || other.isChecked == isChecked)&&(identical(other.checkedBy, checkedBy) || other.checkedBy == checkedBy)&&(identical(other.checkedAt, checkedAt) || other.checkedAt == checkedAt)&&(identical(other.mealId, mealId) || other.mealId == mealId)&&(identical(other.sortOrder, sortOrder) || other.sortOrder == sortOrder)&&(identical(other.createdBy, createdBy) || other.createdBy == createdBy)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,householdId,name,quantity,category,storeType,isChecked,checkedBy,checkedAt,mealId,sortOrder,createdBy,createdAt);

@override
String toString() {
  return 'ShoppingItem(id: $id, householdId: $householdId, name: $name, quantity: $quantity, category: $category, storeType: $storeType, isChecked: $isChecked, checkedBy: $checkedBy, checkedAt: $checkedAt, mealId: $mealId, sortOrder: $sortOrder, createdBy: $createdBy, createdAt: $createdAt)';
}


}

/// @nodoc
abstract mixin class $ShoppingItemCopyWith<$Res>  {
  factory $ShoppingItemCopyWith(ShoppingItem value, $Res Function(ShoppingItem) _then) = _$ShoppingItemCopyWithImpl;
@useResult
$Res call({
 String id,@JsonKey(name: 'household_id') String householdId, String name, String? quantity,@JsonKey(fromJson: _itemCategoryFromJson) ItemCategory category,@JsonKey(name: 'store_type', fromJson: _storeTypeFromJson) StoreType storeType,@JsonKey(name: 'is_checked') bool isChecked,@JsonKey(name: 'checked_by') String? checkedBy,@JsonKey(name: 'checked_at') DateTime? checkedAt,@JsonKey(name: 'meal_id') String? mealId,@JsonKey(name: 'sort_order') int sortOrder,@JsonKey(name: 'created_by') String createdBy,@JsonKey(name: 'created_at') DateTime createdAt
});




}
/// @nodoc
class _$ShoppingItemCopyWithImpl<$Res>
    implements $ShoppingItemCopyWith<$Res> {
  _$ShoppingItemCopyWithImpl(this._self, this._then);

  final ShoppingItem _self;
  final $Res Function(ShoppingItem) _then;

/// Create a copy of ShoppingItem
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? householdId = null,Object? name = null,Object? quantity = freezed,Object? category = null,Object? storeType = null,Object? isChecked = null,Object? checkedBy = freezed,Object? checkedAt = freezed,Object? mealId = freezed,Object? sortOrder = null,Object? createdBy = null,Object? createdAt = null,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,householdId: null == householdId ? _self.householdId : householdId // ignore: cast_nullable_to_non_nullable
as String,name: null == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String,quantity: freezed == quantity ? _self.quantity : quantity // ignore: cast_nullable_to_non_nullable
as String?,category: null == category ? _self.category : category // ignore: cast_nullable_to_non_nullable
as ItemCategory,storeType: null == storeType ? _self.storeType : storeType // ignore: cast_nullable_to_non_nullable
as StoreType,isChecked: null == isChecked ? _self.isChecked : isChecked // ignore: cast_nullable_to_non_nullable
as bool,checkedBy: freezed == checkedBy ? _self.checkedBy : checkedBy // ignore: cast_nullable_to_non_nullable
as String?,checkedAt: freezed == checkedAt ? _self.checkedAt : checkedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,mealId: freezed == mealId ? _self.mealId : mealId // ignore: cast_nullable_to_non_nullable
as String?,sortOrder: null == sortOrder ? _self.sortOrder : sortOrder // ignore: cast_nullable_to_non_nullable
as int,createdBy: null == createdBy ? _self.createdBy : createdBy // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,
  ));
}

}


/// Adds pattern-matching-related methods to [ShoppingItem].
extension ShoppingItemPatterns on ShoppingItem {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _ShoppingItem value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _ShoppingItem() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _ShoppingItem value)  $default,){
final _that = this;
switch (_that) {
case _ShoppingItem():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _ShoppingItem value)?  $default,){
final _that = this;
switch (_that) {
case _ShoppingItem() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id, @JsonKey(name: 'household_id')  String householdId,  String name,  String? quantity, @JsonKey(fromJson: _itemCategoryFromJson)  ItemCategory category, @JsonKey(name: 'store_type', fromJson: _storeTypeFromJson)  StoreType storeType, @JsonKey(name: 'is_checked')  bool isChecked, @JsonKey(name: 'checked_by')  String? checkedBy, @JsonKey(name: 'checked_at')  DateTime? checkedAt, @JsonKey(name: 'meal_id')  String? mealId, @JsonKey(name: 'sort_order')  int sortOrder, @JsonKey(name: 'created_by')  String createdBy, @JsonKey(name: 'created_at')  DateTime createdAt)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _ShoppingItem() when $default != null:
return $default(_that.id,_that.householdId,_that.name,_that.quantity,_that.category,_that.storeType,_that.isChecked,_that.checkedBy,_that.checkedAt,_that.mealId,_that.sortOrder,_that.createdBy,_that.createdAt);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id, @JsonKey(name: 'household_id')  String householdId,  String name,  String? quantity, @JsonKey(fromJson: _itemCategoryFromJson)  ItemCategory category, @JsonKey(name: 'store_type', fromJson: _storeTypeFromJson)  StoreType storeType, @JsonKey(name: 'is_checked')  bool isChecked, @JsonKey(name: 'checked_by')  String? checkedBy, @JsonKey(name: 'checked_at')  DateTime? checkedAt, @JsonKey(name: 'meal_id')  String? mealId, @JsonKey(name: 'sort_order')  int sortOrder, @JsonKey(name: 'created_by')  String createdBy, @JsonKey(name: 'created_at')  DateTime createdAt)  $default,) {final _that = this;
switch (_that) {
case _ShoppingItem():
return $default(_that.id,_that.householdId,_that.name,_that.quantity,_that.category,_that.storeType,_that.isChecked,_that.checkedBy,_that.checkedAt,_that.mealId,_that.sortOrder,_that.createdBy,_that.createdAt);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id, @JsonKey(name: 'household_id')  String householdId,  String name,  String? quantity, @JsonKey(fromJson: _itemCategoryFromJson)  ItemCategory category, @JsonKey(name: 'store_type', fromJson: _storeTypeFromJson)  StoreType storeType, @JsonKey(name: 'is_checked')  bool isChecked, @JsonKey(name: 'checked_by')  String? checkedBy, @JsonKey(name: 'checked_at')  DateTime? checkedAt, @JsonKey(name: 'meal_id')  String? mealId, @JsonKey(name: 'sort_order')  int sortOrder, @JsonKey(name: 'created_by')  String createdBy, @JsonKey(name: 'created_at')  DateTime createdAt)?  $default,) {final _that = this;
switch (_that) {
case _ShoppingItem() when $default != null:
return $default(_that.id,_that.householdId,_that.name,_that.quantity,_that.category,_that.storeType,_that.isChecked,_that.checkedBy,_that.checkedAt,_that.mealId,_that.sortOrder,_that.createdBy,_that.createdAt);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _ShoppingItem implements ShoppingItem {
  const _ShoppingItem({required this.id, @JsonKey(name: 'household_id') required this.householdId, required this.name, this.quantity, @JsonKey(fromJson: _itemCategoryFromJson) required this.category, @JsonKey(name: 'store_type', fromJson: _storeTypeFromJson) required this.storeType, @JsonKey(name: 'is_checked') required this.isChecked, @JsonKey(name: 'checked_by') this.checkedBy, @JsonKey(name: 'checked_at') this.checkedAt, @JsonKey(name: 'meal_id') this.mealId, @JsonKey(name: 'sort_order') required this.sortOrder, @JsonKey(name: 'created_by') required this.createdBy, @JsonKey(name: 'created_at') required this.createdAt});
  factory _ShoppingItem.fromJson(Map<String, dynamic> json) => _$ShoppingItemFromJson(json);

@override final  String id;
@override@JsonKey(name: 'household_id') final  String householdId;
@override final  String name;
@override final  String? quantity;
@override@JsonKey(fromJson: _itemCategoryFromJson) final  ItemCategory category;
@override@JsonKey(name: 'store_type', fromJson: _storeTypeFromJson) final  StoreType storeType;
@override@JsonKey(name: 'is_checked') final  bool isChecked;
@override@JsonKey(name: 'checked_by') final  String? checkedBy;
@override@JsonKey(name: 'checked_at') final  DateTime? checkedAt;
@override@JsonKey(name: 'meal_id') final  String? mealId;
@override@JsonKey(name: 'sort_order') final  int sortOrder;
@override@JsonKey(name: 'created_by') final  String createdBy;
@override@JsonKey(name: 'created_at') final  DateTime createdAt;

/// Create a copy of ShoppingItem
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$ShoppingItemCopyWith<_ShoppingItem> get copyWith => __$ShoppingItemCopyWithImpl<_ShoppingItem>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$ShoppingItemToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _ShoppingItem&&(identical(other.id, id) || other.id == id)&&(identical(other.householdId, householdId) || other.householdId == householdId)&&(identical(other.name, name) || other.name == name)&&(identical(other.quantity, quantity) || other.quantity == quantity)&&(identical(other.category, category) || other.category == category)&&(identical(other.storeType, storeType) || other.storeType == storeType)&&(identical(other.isChecked, isChecked) || other.isChecked == isChecked)&&(identical(other.checkedBy, checkedBy) || other.checkedBy == checkedBy)&&(identical(other.checkedAt, checkedAt) || other.checkedAt == checkedAt)&&(identical(other.mealId, mealId) || other.mealId == mealId)&&(identical(other.sortOrder, sortOrder) || other.sortOrder == sortOrder)&&(identical(other.createdBy, createdBy) || other.createdBy == createdBy)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,householdId,name,quantity,category,storeType,isChecked,checkedBy,checkedAt,mealId,sortOrder,createdBy,createdAt);

@override
String toString() {
  return 'ShoppingItem(id: $id, householdId: $householdId, name: $name, quantity: $quantity, category: $category, storeType: $storeType, isChecked: $isChecked, checkedBy: $checkedBy, checkedAt: $checkedAt, mealId: $mealId, sortOrder: $sortOrder, createdBy: $createdBy, createdAt: $createdAt)';
}


}

/// @nodoc
abstract mixin class _$ShoppingItemCopyWith<$Res> implements $ShoppingItemCopyWith<$Res> {
  factory _$ShoppingItemCopyWith(_ShoppingItem value, $Res Function(_ShoppingItem) _then) = __$ShoppingItemCopyWithImpl;
@override @useResult
$Res call({
 String id,@JsonKey(name: 'household_id') String householdId, String name, String? quantity,@JsonKey(fromJson: _itemCategoryFromJson) ItemCategory category,@JsonKey(name: 'store_type', fromJson: _storeTypeFromJson) StoreType storeType,@JsonKey(name: 'is_checked') bool isChecked,@JsonKey(name: 'checked_by') String? checkedBy,@JsonKey(name: 'checked_at') DateTime? checkedAt,@JsonKey(name: 'meal_id') String? mealId,@JsonKey(name: 'sort_order') int sortOrder,@JsonKey(name: 'created_by') String createdBy,@JsonKey(name: 'created_at') DateTime createdAt
});




}
/// @nodoc
class __$ShoppingItemCopyWithImpl<$Res>
    implements _$ShoppingItemCopyWith<$Res> {
  __$ShoppingItemCopyWithImpl(this._self, this._then);

  final _ShoppingItem _self;
  final $Res Function(_ShoppingItem) _then;

/// Create a copy of ShoppingItem
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? householdId = null,Object? name = null,Object? quantity = freezed,Object? category = null,Object? storeType = null,Object? isChecked = null,Object? checkedBy = freezed,Object? checkedAt = freezed,Object? mealId = freezed,Object? sortOrder = null,Object? createdBy = null,Object? createdAt = null,}) {
  return _then(_ShoppingItem(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,householdId: null == householdId ? _self.householdId : householdId // ignore: cast_nullable_to_non_nullable
as String,name: null == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String,quantity: freezed == quantity ? _self.quantity : quantity // ignore: cast_nullable_to_non_nullable
as String?,category: null == category ? _self.category : category // ignore: cast_nullable_to_non_nullable
as ItemCategory,storeType: null == storeType ? _self.storeType : storeType // ignore: cast_nullable_to_non_nullable
as StoreType,isChecked: null == isChecked ? _self.isChecked : isChecked // ignore: cast_nullable_to_non_nullable
as bool,checkedBy: freezed == checkedBy ? _self.checkedBy : checkedBy // ignore: cast_nullable_to_non_nullable
as String?,checkedAt: freezed == checkedAt ? _self.checkedAt : checkedAt // ignore: cast_nullable_to_non_nullable
as DateTime?,mealId: freezed == mealId ? _self.mealId : mealId // ignore: cast_nullable_to_non_nullable
as String?,sortOrder: null == sortOrder ? _self.sortOrder : sortOrder // ignore: cast_nullable_to_non_nullable
as int,createdBy: null == createdBy ? _self.createdBy : createdBy // ignore: cast_nullable_to_non_nullable
as String,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,
  ));
}


}

// dart format on
