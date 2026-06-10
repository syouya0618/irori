// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'meal.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$MealIngredient {

 String get name; String? get quantity;@JsonKey(fromJson: _itemCategoryFromJson) ItemCategory get category;
/// Create a copy of MealIngredient
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$MealIngredientCopyWith<MealIngredient> get copyWith => _$MealIngredientCopyWithImpl<MealIngredient>(this as MealIngredient, _$identity);

  /// Serializes this MealIngredient to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is MealIngredient&&(identical(other.name, name) || other.name == name)&&(identical(other.quantity, quantity) || other.quantity == quantity)&&(identical(other.category, category) || other.category == category));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,name,quantity,category);

@override
String toString() {
  return 'MealIngredient(name: $name, quantity: $quantity, category: $category)';
}


}

/// @nodoc
abstract mixin class $MealIngredientCopyWith<$Res>  {
  factory $MealIngredientCopyWith(MealIngredient value, $Res Function(MealIngredient) _then) = _$MealIngredientCopyWithImpl;
@useResult
$Res call({
 String name, String? quantity,@JsonKey(fromJson: _itemCategoryFromJson) ItemCategory category
});




}
/// @nodoc
class _$MealIngredientCopyWithImpl<$Res>
    implements $MealIngredientCopyWith<$Res> {
  _$MealIngredientCopyWithImpl(this._self, this._then);

  final MealIngredient _self;
  final $Res Function(MealIngredient) _then;

/// Create a copy of MealIngredient
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? name = null,Object? quantity = freezed,Object? category = null,}) {
  return _then(_self.copyWith(
name: null == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String,quantity: freezed == quantity ? _self.quantity : quantity // ignore: cast_nullable_to_non_nullable
as String?,category: null == category ? _self.category : category // ignore: cast_nullable_to_non_nullable
as ItemCategory,
  ));
}

}


/// Adds pattern-matching-related methods to [MealIngredient].
extension MealIngredientPatterns on MealIngredient {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _MealIngredient value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _MealIngredient() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _MealIngredient value)  $default,){
final _that = this;
switch (_that) {
case _MealIngredient():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _MealIngredient value)?  $default,){
final _that = this;
switch (_that) {
case _MealIngredient() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String name,  String? quantity, @JsonKey(fromJson: _itemCategoryFromJson)  ItemCategory category)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _MealIngredient() when $default != null:
return $default(_that.name,_that.quantity,_that.category);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String name,  String? quantity, @JsonKey(fromJson: _itemCategoryFromJson)  ItemCategory category)  $default,) {final _that = this;
switch (_that) {
case _MealIngredient():
return $default(_that.name,_that.quantity,_that.category);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String name,  String? quantity, @JsonKey(fromJson: _itemCategoryFromJson)  ItemCategory category)?  $default,) {final _that = this;
switch (_that) {
case _MealIngredient() when $default != null:
return $default(_that.name,_that.quantity,_that.category);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _MealIngredient implements MealIngredient {
  const _MealIngredient({required this.name, this.quantity, @JsonKey(fromJson: _itemCategoryFromJson) required this.category});
  factory _MealIngredient.fromJson(Map<String, dynamic> json) => _$MealIngredientFromJson(json);

@override final  String name;
@override final  String? quantity;
@override@JsonKey(fromJson: _itemCategoryFromJson) final  ItemCategory category;

/// Create a copy of MealIngredient
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$MealIngredientCopyWith<_MealIngredient> get copyWith => __$MealIngredientCopyWithImpl<_MealIngredient>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$MealIngredientToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _MealIngredient&&(identical(other.name, name) || other.name == name)&&(identical(other.quantity, quantity) || other.quantity == quantity)&&(identical(other.category, category) || other.category == category));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,name,quantity,category);

@override
String toString() {
  return 'MealIngredient(name: $name, quantity: $quantity, category: $category)';
}


}

/// @nodoc
abstract mixin class _$MealIngredientCopyWith<$Res> implements $MealIngredientCopyWith<$Res> {
  factory _$MealIngredientCopyWith(_MealIngredient value, $Res Function(_MealIngredient) _then) = __$MealIngredientCopyWithImpl;
@override @useResult
$Res call({
 String name, String? quantity,@JsonKey(fromJson: _itemCategoryFromJson) ItemCategory category
});




}
/// @nodoc
class __$MealIngredientCopyWithImpl<$Res>
    implements _$MealIngredientCopyWith<$Res> {
  __$MealIngredientCopyWithImpl(this._self, this._then);

  final _MealIngredient _self;
  final $Res Function(_MealIngredient) _then;

/// Create a copy of MealIngredient
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? name = null,Object? quantity = freezed,Object? category = null,}) {
  return _then(_MealIngredient(
name: null == name ? _self.name : name // ignore: cast_nullable_to_non_nullable
as String,quantity: freezed == quantity ? _self.quantity : quantity // ignore: cast_nullable_to_non_nullable
as String?,category: null == category ? _self.category : category // ignore: cast_nullable_to_non_nullable
as ItemCategory,
  ));
}


}


/// @nodoc
mixin _$MealReactionEntry {

@JsonKey(name: 'user_id') String get userId; MealReaction get reaction;
/// Create a copy of MealReactionEntry
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$MealReactionEntryCopyWith<MealReactionEntry> get copyWith => _$MealReactionEntryCopyWithImpl<MealReactionEntry>(this as MealReactionEntry, _$identity);

  /// Serializes this MealReactionEntry to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is MealReactionEntry&&(identical(other.userId, userId) || other.userId == userId)&&(identical(other.reaction, reaction) || other.reaction == reaction));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,userId,reaction);

@override
String toString() {
  return 'MealReactionEntry(userId: $userId, reaction: $reaction)';
}


}

/// @nodoc
abstract mixin class $MealReactionEntryCopyWith<$Res>  {
  factory $MealReactionEntryCopyWith(MealReactionEntry value, $Res Function(MealReactionEntry) _then) = _$MealReactionEntryCopyWithImpl;
@useResult
$Res call({
@JsonKey(name: 'user_id') String userId, MealReaction reaction
});




}
/// @nodoc
class _$MealReactionEntryCopyWithImpl<$Res>
    implements $MealReactionEntryCopyWith<$Res> {
  _$MealReactionEntryCopyWithImpl(this._self, this._then);

  final MealReactionEntry _self;
  final $Res Function(MealReactionEntry) _then;

/// Create a copy of MealReactionEntry
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? userId = null,Object? reaction = null,}) {
  return _then(_self.copyWith(
userId: null == userId ? _self.userId : userId // ignore: cast_nullable_to_non_nullable
as String,reaction: null == reaction ? _self.reaction : reaction // ignore: cast_nullable_to_non_nullable
as MealReaction,
  ));
}

}


/// Adds pattern-matching-related methods to [MealReactionEntry].
extension MealReactionEntryPatterns on MealReactionEntry {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _MealReactionEntry value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _MealReactionEntry() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _MealReactionEntry value)  $default,){
final _that = this;
switch (_that) {
case _MealReactionEntry():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _MealReactionEntry value)?  $default,){
final _that = this;
switch (_that) {
case _MealReactionEntry() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function(@JsonKey(name: 'user_id')  String userId,  MealReaction reaction)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _MealReactionEntry() when $default != null:
return $default(_that.userId,_that.reaction);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function(@JsonKey(name: 'user_id')  String userId,  MealReaction reaction)  $default,) {final _that = this;
switch (_that) {
case _MealReactionEntry():
return $default(_that.userId,_that.reaction);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function(@JsonKey(name: 'user_id')  String userId,  MealReaction reaction)?  $default,) {final _that = this;
switch (_that) {
case _MealReactionEntry() when $default != null:
return $default(_that.userId,_that.reaction);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _MealReactionEntry implements MealReactionEntry {
  const _MealReactionEntry({@JsonKey(name: 'user_id') required this.userId, required this.reaction});
  factory _MealReactionEntry.fromJson(Map<String, dynamic> json) => _$MealReactionEntryFromJson(json);

@override@JsonKey(name: 'user_id') final  String userId;
@override final  MealReaction reaction;

/// Create a copy of MealReactionEntry
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$MealReactionEntryCopyWith<_MealReactionEntry> get copyWith => __$MealReactionEntryCopyWithImpl<_MealReactionEntry>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$MealReactionEntryToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _MealReactionEntry&&(identical(other.userId, userId) || other.userId == userId)&&(identical(other.reaction, reaction) || other.reaction == reaction));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,userId,reaction);

@override
String toString() {
  return 'MealReactionEntry(userId: $userId, reaction: $reaction)';
}


}

/// @nodoc
abstract mixin class _$MealReactionEntryCopyWith<$Res> implements $MealReactionEntryCopyWith<$Res> {
  factory _$MealReactionEntryCopyWith(_MealReactionEntry value, $Res Function(_MealReactionEntry) _then) = __$MealReactionEntryCopyWithImpl;
@override @useResult
$Res call({
@JsonKey(name: 'user_id') String userId, MealReaction reaction
});




}
/// @nodoc
class __$MealReactionEntryCopyWithImpl<$Res>
    implements _$MealReactionEntryCopyWith<$Res> {
  __$MealReactionEntryCopyWithImpl(this._self, this._then);

  final _MealReactionEntry _self;
  final $Res Function(_MealReactionEntry) _then;

/// Create a copy of MealReactionEntry
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? userId = null,Object? reaction = null,}) {
  return _then(_MealReactionEntry(
userId: null == userId ? _self.userId : userId // ignore: cast_nullable_to_non_nullable
as String,reaction: null == reaction ? _self.reaction : reaction // ignore: cast_nullable_to_non_nullable
as MealReaction,
  ));
}


}


/// @nodoc
mixin _$Meal {

 String get id; String get date;@JsonKey(name: 'meal_type') MealType get mealType; String get title;@JsonKey(name: 'is_eating_out') bool get isEatingOut;@JsonKey(name: 'template_id') String? get templateId;// nested 配列は埋め込み行が 0 件でも PostgREST が `[]` を返すが、
// realtime payload 等で欠落/null になっても壊れないよう既定値で防御する
// (CLAUDE.md「外部APIレスポンスの値は使用前に必ず検証」)。
@JsonKey(name: 'meal_reactions') List<MealReactionEntry> get reactions;@JsonKey(name: 'meal_ingredients') List<MealIngredient> get ingredients;
/// Create a copy of Meal
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$MealCopyWith<Meal> get copyWith => _$MealCopyWithImpl<Meal>(this as Meal, _$identity);

  /// Serializes this Meal to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is Meal&&(identical(other.id, id) || other.id == id)&&(identical(other.date, date) || other.date == date)&&(identical(other.mealType, mealType) || other.mealType == mealType)&&(identical(other.title, title) || other.title == title)&&(identical(other.isEatingOut, isEatingOut) || other.isEatingOut == isEatingOut)&&(identical(other.templateId, templateId) || other.templateId == templateId)&&const DeepCollectionEquality().equals(other.reactions, reactions)&&const DeepCollectionEquality().equals(other.ingredients, ingredients));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,date,mealType,title,isEatingOut,templateId,const DeepCollectionEquality().hash(reactions),const DeepCollectionEquality().hash(ingredients));

@override
String toString() {
  return 'Meal(id: $id, date: $date, mealType: $mealType, title: $title, isEatingOut: $isEatingOut, templateId: $templateId, reactions: $reactions, ingredients: $ingredients)';
}


}

/// @nodoc
abstract mixin class $MealCopyWith<$Res>  {
  factory $MealCopyWith(Meal value, $Res Function(Meal) _then) = _$MealCopyWithImpl;
@useResult
$Res call({
 String id, String date,@JsonKey(name: 'meal_type') MealType mealType, String title,@JsonKey(name: 'is_eating_out') bool isEatingOut,@JsonKey(name: 'template_id') String? templateId,@JsonKey(name: 'meal_reactions') List<MealReactionEntry> reactions,@JsonKey(name: 'meal_ingredients') List<MealIngredient> ingredients
});




}
/// @nodoc
class _$MealCopyWithImpl<$Res>
    implements $MealCopyWith<$Res> {
  _$MealCopyWithImpl(this._self, this._then);

  final Meal _self;
  final $Res Function(Meal) _then;

/// Create a copy of Meal
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? date = null,Object? mealType = null,Object? title = null,Object? isEatingOut = null,Object? templateId = freezed,Object? reactions = null,Object? ingredients = null,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,date: null == date ? _self.date : date // ignore: cast_nullable_to_non_nullable
as String,mealType: null == mealType ? _self.mealType : mealType // ignore: cast_nullable_to_non_nullable
as MealType,title: null == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String,isEatingOut: null == isEatingOut ? _self.isEatingOut : isEatingOut // ignore: cast_nullable_to_non_nullable
as bool,templateId: freezed == templateId ? _self.templateId : templateId // ignore: cast_nullable_to_non_nullable
as String?,reactions: null == reactions ? _self.reactions : reactions // ignore: cast_nullable_to_non_nullable
as List<MealReactionEntry>,ingredients: null == ingredients ? _self.ingredients : ingredients // ignore: cast_nullable_to_non_nullable
as List<MealIngredient>,
  ));
}

}


/// Adds pattern-matching-related methods to [Meal].
extension MealPatterns on Meal {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _Meal value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _Meal() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _Meal value)  $default,){
final _that = this;
switch (_that) {
case _Meal():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _Meal value)?  $default,){
final _that = this;
switch (_that) {
case _Meal() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String date, @JsonKey(name: 'meal_type')  MealType mealType,  String title, @JsonKey(name: 'is_eating_out')  bool isEatingOut, @JsonKey(name: 'template_id')  String? templateId, @JsonKey(name: 'meal_reactions')  List<MealReactionEntry> reactions, @JsonKey(name: 'meal_ingredients')  List<MealIngredient> ingredients)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _Meal() when $default != null:
return $default(_that.id,_that.date,_that.mealType,_that.title,_that.isEatingOut,_that.templateId,_that.reactions,_that.ingredients);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String date, @JsonKey(name: 'meal_type')  MealType mealType,  String title, @JsonKey(name: 'is_eating_out')  bool isEatingOut, @JsonKey(name: 'template_id')  String? templateId, @JsonKey(name: 'meal_reactions')  List<MealReactionEntry> reactions, @JsonKey(name: 'meal_ingredients')  List<MealIngredient> ingredients)  $default,) {final _that = this;
switch (_that) {
case _Meal():
return $default(_that.id,_that.date,_that.mealType,_that.title,_that.isEatingOut,_that.templateId,_that.reactions,_that.ingredients);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String date, @JsonKey(name: 'meal_type')  MealType mealType,  String title, @JsonKey(name: 'is_eating_out')  bool isEatingOut, @JsonKey(name: 'template_id')  String? templateId, @JsonKey(name: 'meal_reactions')  List<MealReactionEntry> reactions, @JsonKey(name: 'meal_ingredients')  List<MealIngredient> ingredients)?  $default,) {final _that = this;
switch (_that) {
case _Meal() when $default != null:
return $default(_that.id,_that.date,_that.mealType,_that.title,_that.isEatingOut,_that.templateId,_that.reactions,_that.ingredients);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _Meal implements Meal {
  const _Meal({required this.id, required this.date, @JsonKey(name: 'meal_type') required this.mealType, required this.title, @JsonKey(name: 'is_eating_out') required this.isEatingOut, @JsonKey(name: 'template_id') this.templateId, @JsonKey(name: 'meal_reactions') final  List<MealReactionEntry> reactions = const [], @JsonKey(name: 'meal_ingredients') final  List<MealIngredient> ingredients = const []}): _reactions = reactions,_ingredients = ingredients;
  factory _Meal.fromJson(Map<String, dynamic> json) => _$MealFromJson(json);

@override final  String id;
@override final  String date;
@override@JsonKey(name: 'meal_type') final  MealType mealType;
@override final  String title;
@override@JsonKey(name: 'is_eating_out') final  bool isEatingOut;
@override@JsonKey(name: 'template_id') final  String? templateId;
// nested 配列は埋め込み行が 0 件でも PostgREST が `[]` を返すが、
// realtime payload 等で欠落/null になっても壊れないよう既定値で防御する
// (CLAUDE.md「外部APIレスポンスの値は使用前に必ず検証」)。
 final  List<MealReactionEntry> _reactions;
// nested 配列は埋め込み行が 0 件でも PostgREST が `[]` を返すが、
// realtime payload 等で欠落/null になっても壊れないよう既定値で防御する
// (CLAUDE.md「外部APIレスポンスの値は使用前に必ず検証」)。
@override@JsonKey(name: 'meal_reactions') List<MealReactionEntry> get reactions {
  if (_reactions is EqualUnmodifiableListView) return _reactions;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_reactions);
}

 final  List<MealIngredient> _ingredients;
@override@JsonKey(name: 'meal_ingredients') List<MealIngredient> get ingredients {
  if (_ingredients is EqualUnmodifiableListView) return _ingredients;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_ingredients);
}


/// Create a copy of Meal
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$MealCopyWith<_Meal> get copyWith => __$MealCopyWithImpl<_Meal>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$MealToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _Meal&&(identical(other.id, id) || other.id == id)&&(identical(other.date, date) || other.date == date)&&(identical(other.mealType, mealType) || other.mealType == mealType)&&(identical(other.title, title) || other.title == title)&&(identical(other.isEatingOut, isEatingOut) || other.isEatingOut == isEatingOut)&&(identical(other.templateId, templateId) || other.templateId == templateId)&&const DeepCollectionEquality().equals(other._reactions, _reactions)&&const DeepCollectionEquality().equals(other._ingredients, _ingredients));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,date,mealType,title,isEatingOut,templateId,const DeepCollectionEquality().hash(_reactions),const DeepCollectionEquality().hash(_ingredients));

@override
String toString() {
  return 'Meal(id: $id, date: $date, mealType: $mealType, title: $title, isEatingOut: $isEatingOut, templateId: $templateId, reactions: $reactions, ingredients: $ingredients)';
}


}

/// @nodoc
abstract mixin class _$MealCopyWith<$Res> implements $MealCopyWith<$Res> {
  factory _$MealCopyWith(_Meal value, $Res Function(_Meal) _then) = __$MealCopyWithImpl;
@override @useResult
$Res call({
 String id, String date,@JsonKey(name: 'meal_type') MealType mealType, String title,@JsonKey(name: 'is_eating_out') bool isEatingOut,@JsonKey(name: 'template_id') String? templateId,@JsonKey(name: 'meal_reactions') List<MealReactionEntry> reactions,@JsonKey(name: 'meal_ingredients') List<MealIngredient> ingredients
});




}
/// @nodoc
class __$MealCopyWithImpl<$Res>
    implements _$MealCopyWith<$Res> {
  __$MealCopyWithImpl(this._self, this._then);

  final _Meal _self;
  final $Res Function(_Meal) _then;

/// Create a copy of Meal
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? date = null,Object? mealType = null,Object? title = null,Object? isEatingOut = null,Object? templateId = freezed,Object? reactions = null,Object? ingredients = null,}) {
  return _then(_Meal(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,date: null == date ? _self.date : date // ignore: cast_nullable_to_non_nullable
as String,mealType: null == mealType ? _self.mealType : mealType // ignore: cast_nullable_to_non_nullable
as MealType,title: null == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String,isEatingOut: null == isEatingOut ? _self.isEatingOut : isEatingOut // ignore: cast_nullable_to_non_nullable
as bool,templateId: freezed == templateId ? _self.templateId : templateId // ignore: cast_nullable_to_non_nullable
as String?,reactions: null == reactions ? _self._reactions : reactions // ignore: cast_nullable_to_non_nullable
as List<MealReactionEntry>,ingredients: null == ingredients ? _self._ingredients : ingredients // ignore: cast_nullable_to_non_nullable
as List<MealIngredient>,
  ));
}


}

// dart format on
