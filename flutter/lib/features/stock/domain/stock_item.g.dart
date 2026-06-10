// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'stock_item.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_StockItem _$StockItemFromJson(Map<String, dynamic> json) => _StockItem(
  id: json['id'] as String,
  householdId: json['household_id'] as String,
  name: json['name'] as String,
  category: _itemCategoryFromJson(json['category']),
  quantity: _quantityFromJson(json['quantity']),
  unit: json['unit'] as String?,
  expiresAt: json['expires_at'] as String?,
  createdBy: json['created_by'] as String,
  createdAt: DateTime.parse(json['created_at'] as String),
  updatedAt: json['updated_at'] == null
      ? null
      : DateTime.parse(json['updated_at'] as String),
);

Map<String, dynamic> _$StockItemToJson(_StockItem instance) =>
    <String, dynamic>{
      'id': instance.id,
      'household_id': instance.householdId,
      'name': instance.name,
      'category': _$ItemCategoryEnumMap[instance.category]!,
      'quantity': instance.quantity,
      'unit': instance.unit,
      'expires_at': instance.expiresAt,
      'created_by': instance.createdBy,
      'created_at': instance.createdAt.toIso8601String(),
      'updated_at': instance.updatedAt?.toIso8601String(),
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
