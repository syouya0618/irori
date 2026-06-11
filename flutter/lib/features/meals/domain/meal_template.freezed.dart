// GENERATED CODE - DO NOT MODIFY BY HAND
// coverage:ignore-file
// ignore_for_file: type=lint
// ignore_for_file: unused_element, deprecated_member_use, deprecated_member_use_from_same_package, use_function_type_syntax_for_parameters, unnecessary_const, avoid_init_to_null, invalid_override_different_default_values_named, prefer_expression_function_bodies, annotate_overrides, invalid_annotation_target, unnecessary_question_mark

part of 'meal_template.dart';

// **************************************************************************
// FreezedGenerator
// **************************************************************************

// dart format off
T _$identity<T>(T value) => value;

/// @nodoc
mixin _$MealTemplate {

 String get id; String get title;@JsonKey(fromJson: mealTemplateIngredientsFromJson) List<MealIngredient> get ingredients;@JsonKey(name: 'created_at') DateTime get createdAt;
/// Create a copy of MealTemplate
/// with the given fields replaced by the non-null parameter values.
@JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
$MealTemplateCopyWith<MealTemplate> get copyWith => _$MealTemplateCopyWithImpl<MealTemplate>(this as MealTemplate, _$identity);

  /// Serializes this MealTemplate to a JSON map.
  Map<String, dynamic> toJson();


@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is MealTemplate&&(identical(other.id, id) || other.id == id)&&(identical(other.title, title) || other.title == title)&&const DeepCollectionEquality().equals(other.ingredients, ingredients)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,title,const DeepCollectionEquality().hash(ingredients),createdAt);

@override
String toString() {
  return 'MealTemplate(id: $id, title: $title, ingredients: $ingredients, createdAt: $createdAt)';
}


}

/// @nodoc
abstract mixin class $MealTemplateCopyWith<$Res>  {
  factory $MealTemplateCopyWith(MealTemplate value, $Res Function(MealTemplate) _then) = _$MealTemplateCopyWithImpl;
@useResult
$Res call({
 String id, String title,@JsonKey(fromJson: mealTemplateIngredientsFromJson) List<MealIngredient> ingredients,@JsonKey(name: 'created_at') DateTime createdAt
});




}
/// @nodoc
class _$MealTemplateCopyWithImpl<$Res>
    implements $MealTemplateCopyWith<$Res> {
  _$MealTemplateCopyWithImpl(this._self, this._then);

  final MealTemplate _self;
  final $Res Function(MealTemplate) _then;

/// Create a copy of MealTemplate
/// with the given fields replaced by the non-null parameter values.
@pragma('vm:prefer-inline') @override $Res call({Object? id = null,Object? title = null,Object? ingredients = null,Object? createdAt = null,}) {
  return _then(_self.copyWith(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,title: null == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String,ingredients: null == ingredients ? _self.ingredients : ingredients // ignore: cast_nullable_to_non_nullable
as List<MealIngredient>,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,
  ));
}

}


/// Adds pattern-matching-related methods to [MealTemplate].
extension MealTemplatePatterns on MealTemplate {
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

@optionalTypeArgs TResult maybeMap<TResult extends Object?>(TResult Function( _MealTemplate value)?  $default,{required TResult orElse(),}){
final _that = this;
switch (_that) {
case _MealTemplate() when $default != null:
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

@optionalTypeArgs TResult map<TResult extends Object?>(TResult Function( _MealTemplate value)  $default,){
final _that = this;
switch (_that) {
case _MealTemplate():
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

@optionalTypeArgs TResult? mapOrNull<TResult extends Object?>(TResult? Function( _MealTemplate value)?  $default,){
final _that = this;
switch (_that) {
case _MealTemplate() when $default != null:
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

@optionalTypeArgs TResult maybeWhen<TResult extends Object?>(TResult Function( String id,  String title, @JsonKey(fromJson: mealTemplateIngredientsFromJson)  List<MealIngredient> ingredients, @JsonKey(name: 'created_at')  DateTime createdAt)?  $default,{required TResult orElse(),}) {final _that = this;
switch (_that) {
case _MealTemplate() when $default != null:
return $default(_that.id,_that.title,_that.ingredients,_that.createdAt);case _:
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

@optionalTypeArgs TResult when<TResult extends Object?>(TResult Function( String id,  String title, @JsonKey(fromJson: mealTemplateIngredientsFromJson)  List<MealIngredient> ingredients, @JsonKey(name: 'created_at')  DateTime createdAt)  $default,) {final _that = this;
switch (_that) {
case _MealTemplate():
return $default(_that.id,_that.title,_that.ingredients,_that.createdAt);}
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

@optionalTypeArgs TResult? whenOrNull<TResult extends Object?>(TResult? Function( String id,  String title, @JsonKey(fromJson: mealTemplateIngredientsFromJson)  List<MealIngredient> ingredients, @JsonKey(name: 'created_at')  DateTime createdAt)?  $default,) {final _that = this;
switch (_that) {
case _MealTemplate() when $default != null:
return $default(_that.id,_that.title,_that.ingredients,_that.createdAt);case _:
  return null;

}
}

}

/// @nodoc
@JsonSerializable()

class _MealTemplate implements MealTemplate {
  const _MealTemplate({required this.id, required this.title, @JsonKey(fromJson: mealTemplateIngredientsFromJson) required final  List<MealIngredient> ingredients, @JsonKey(name: 'created_at') required this.createdAt}): _ingredients = ingredients;
  factory _MealTemplate.fromJson(Map<String, dynamic> json) => _$MealTemplateFromJson(json);

@override final  String id;
@override final  String title;
 final  List<MealIngredient> _ingredients;
@override@JsonKey(fromJson: mealTemplateIngredientsFromJson) List<MealIngredient> get ingredients {
  if (_ingredients is EqualUnmodifiableListView) return _ingredients;
  // ignore: implicit_dynamic_type
  return EqualUnmodifiableListView(_ingredients);
}

@override@JsonKey(name: 'created_at') final  DateTime createdAt;

/// Create a copy of MealTemplate
/// with the given fields replaced by the non-null parameter values.
@override @JsonKey(includeFromJson: false, includeToJson: false)
@pragma('vm:prefer-inline')
_$MealTemplateCopyWith<_MealTemplate> get copyWith => __$MealTemplateCopyWithImpl<_MealTemplate>(this, _$identity);

@override
Map<String, dynamic> toJson() {
  return _$MealTemplateToJson(this, );
}

@override
bool operator ==(Object other) {
  return identical(this, other) || (other.runtimeType == runtimeType&&other is _MealTemplate&&(identical(other.id, id) || other.id == id)&&(identical(other.title, title) || other.title == title)&&const DeepCollectionEquality().equals(other._ingredients, _ingredients)&&(identical(other.createdAt, createdAt) || other.createdAt == createdAt));
}

@JsonKey(includeFromJson: false, includeToJson: false)
@override
int get hashCode => Object.hash(runtimeType,id,title,const DeepCollectionEquality().hash(_ingredients),createdAt);

@override
String toString() {
  return 'MealTemplate(id: $id, title: $title, ingredients: $ingredients, createdAt: $createdAt)';
}


}

/// @nodoc
abstract mixin class _$MealTemplateCopyWith<$Res> implements $MealTemplateCopyWith<$Res> {
  factory _$MealTemplateCopyWith(_MealTemplate value, $Res Function(_MealTemplate) _then) = __$MealTemplateCopyWithImpl;
@override @useResult
$Res call({
 String id, String title,@JsonKey(fromJson: mealTemplateIngredientsFromJson) List<MealIngredient> ingredients,@JsonKey(name: 'created_at') DateTime createdAt
});




}
/// @nodoc
class __$MealTemplateCopyWithImpl<$Res>
    implements _$MealTemplateCopyWith<$Res> {
  __$MealTemplateCopyWithImpl(this._self, this._then);

  final _MealTemplate _self;
  final $Res Function(_MealTemplate) _then;

/// Create a copy of MealTemplate
/// with the given fields replaced by the non-null parameter values.
@override @pragma('vm:prefer-inline') $Res call({Object? id = null,Object? title = null,Object? ingredients = null,Object? createdAt = null,}) {
  return _then(_MealTemplate(
id: null == id ? _self.id : id // ignore: cast_nullable_to_non_nullable
as String,title: null == title ? _self.title : title // ignore: cast_nullable_to_non_nullable
as String,ingredients: null == ingredients ? _self._ingredients : ingredients // ignore: cast_nullable_to_non_nullable
as List<MealIngredient>,createdAt: null == createdAt ? _self.createdAt : createdAt // ignore: cast_nullable_to_non_nullable
as DateTime,
  ));
}


}

// dart format on
