// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'meal_template.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_MealTemplate _$MealTemplateFromJson(Map<String, dynamic> json) =>
    _MealTemplate(
      id: json['id'] as String,
      title: json['title'] as String,
      ingredients: mealTemplateIngredientsFromJson(json['ingredients']),
      createdAt: DateTime.parse(json['created_at'] as String),
    );

Map<String, dynamic> _$MealTemplateToJson(_MealTemplate instance) =>
    <String, dynamic>{
      'id': instance.id,
      'title': instance.title,
      'ingredients': instance.ingredients,
      'created_at': instance.createdAt.toIso8601String(),
    };
