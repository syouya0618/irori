// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'shopping_item.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_ShoppingItem _$ShoppingItemFromJson(Map<String, dynamic> json) =>
    _ShoppingItem(
      id: json['id'] as String,
      householdId: json['household_id'] as String,
      name: json['name'] as String,
      quantity: json['quantity'] as String?,
      category: _itemCategoryFromJson(json['category']),
      storeType: _storeTypeFromJson(json['store_type']),
      isChecked: json['is_checked'] as bool,
      checkedBy: json['checked_by'] as String?,
      checkedAt: json['checked_at'] == null
          ? null
          : DateTime.parse(json['checked_at'] as String),
      mealId: json['meal_id'] as String?,
      sortOrder: (json['sort_order'] as num).toInt(),
      createdBy: json['created_by'] as String,
      createdAt: DateTime.parse(json['created_at'] as String),
    );

Map<String, dynamic> _$ShoppingItemToJson(_ShoppingItem instance) =>
    <String, dynamic>{
      'id': instance.id,
      'household_id': instance.householdId,
      'name': instance.name,
      'quantity': instance.quantity,
      'category': _$ItemCategoryEnumMap[instance.category]!,
      'store_type': _$StoreTypeEnumMap[instance.storeType]!,
      'is_checked': instance.isChecked,
      'checked_by': instance.checkedBy,
      'checked_at': instance.checkedAt?.toIso8601String(),
      'meal_id': instance.mealId,
      'sort_order': instance.sortOrder,
      'created_by': instance.createdBy,
      'created_at': instance.createdAt.toIso8601String(),
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

const _$StoreTypeEnumMap = {
  StoreType.supermarket: 'supermarket',
  StoreType.drugstore: 'drugstore',
  StoreType.convenience: 'convenience',
  StoreType.online: 'online',
  StoreType.other: 'other',
};
