// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'meal.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_MealIngredient _$MealIngredientFromJson(Map<String, dynamic> json) =>
    _MealIngredient(
      name: json['name'] as String,
      quantity: json['quantity'] as String?,
      category: _itemCategoryFromJson(json['category']),
    );

Map<String, dynamic> _$MealIngredientToJson(_MealIngredient instance) =>
    <String, dynamic>{
      'name': instance.name,
      'quantity': instance.quantity,
      'category': _$ItemCategoryEnumMap[instance.category]!,
    };

const _$ItemCategoryEnumMap = {
  ItemCategory.vegetable: 'vegetable',
  ItemCategory.fruit: 'fruit',
  ItemCategory.meat: 'meat',
  ItemCategory.fish: 'fish',
  ItemCategory.dairy: 'dairy',
  ItemCategory.egg: 'egg',
  ItemCategory.grain: 'grain',
  ItemCategory.seasoning: 'seasoning',
  ItemCategory.frozen: 'frozen',
  ItemCategory.snackFood: 'snack_food',
  ItemCategory.otherFood: 'other_food',
  ItemCategory.baby: 'baby',
  ItemCategory.cleaning: 'cleaning',
  ItemCategory.hygiene: 'hygiene',
  ItemCategory.otherDaily: 'other_daily',
};

_MealReactionEntry _$MealReactionEntryFromJson(Map<String, dynamic> json) =>
    _MealReactionEntry(
      userId: json['user_id'] as String,
      reaction: $enumDecode(_$MealReactionEnumMap, json['reaction']),
    );

Map<String, dynamic> _$MealReactionEntryToJson(_MealReactionEntry instance) =>
    <String, dynamic>{
      'user_id': instance.userId,
      'reaction': _$MealReactionEnumMap[instance.reaction]!,
    };

const _$MealReactionEnumMap = {
  MealReaction.good: 'good',
  MealReaction.ok: 'ok',
  MealReaction.bad: 'bad',
};

_Meal _$MealFromJson(Map<String, dynamic> json) => _Meal(
  id: json['id'] as String,
  date: json['date'] as String,
  mealType: $enumDecode(_$MealTypeEnumMap, json['meal_type']),
  title: json['title'] as String,
  isEatingOut: json['is_eating_out'] as bool,
  templateId: json['template_id'] as String?,
  reactions:
      (json['meal_reactions'] as List<dynamic>?)
          ?.map((e) => MealReactionEntry.fromJson(e as Map<String, dynamic>))
          .toList() ??
      const [],
  ingredients:
      (json['meal_ingredients'] as List<dynamic>?)
          ?.map((e) => MealIngredient.fromJson(e as Map<String, dynamic>))
          .toList() ??
      const [],
);

Map<String, dynamic> _$MealToJson(_Meal instance) => <String, dynamic>{
  'id': instance.id,
  'date': instance.date,
  'meal_type': _$MealTypeEnumMap[instance.mealType]!,
  'title': instance.title,
  'is_eating_out': instance.isEatingOut,
  'template_id': instance.templateId,
  'meal_reactions': instance.reactions,
  'meal_ingredients': instance.ingredients,
};

const _$MealTypeEnumMap = {
  MealType.breakfast: 'breakfast',
  MealType.lunch: 'lunch',
  MealType.dinner: 'dinner',
  MealType.snack: 'snack',
};
