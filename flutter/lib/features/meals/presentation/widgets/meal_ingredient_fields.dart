import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/domain/item_category.dart';
import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../widgets/category_icon.dart';

/// 献立フォームの食材カテゴリ候補。原典 `meal-form-sheet.tsx` の
/// `FOOD_CATEGORIES` (allCategories から食品系 9 値を filter) と同一の
/// 値・表示順 (`ItemCategory.displayOrder` 順)。
const List<ItemCategory> mealIngredientCategories = [
  ItemCategory.vegetable,
  ItemCategory.meat,
  ItemCategory.fish,
  ItemCategory.dairy,
  ItemCategory.egg,
  ItemCategory.grain,
  ItemCategory.seasoning,
  ItemCategory.frozen,
  ItemCategory.otherFood,
];

/// 食材 1 行のエディタ。原典 `meal-form-sheet.tsx` の ingredients 行
/// (名前 Input + 量 Input + カテゴリ Select + 削除ボタン) を移植。
///
/// 入力値 (TextEditingController) は親フォームが所有・破棄する。
/// カテゴリは F0 の [ItemCategory] + [categoryIcon] で表示する。
class MealIngredientFields extends StatelessWidget {
  const MealIngredientFields({
    required this.nameController,
    required this.quantityController,
    required this.category,
    required this.enabled,
    required this.onCategoryChanged,
    required this.onRemove,
    super.key,
  });

  final TextEditingController nameController;
  final TextEditingController quantityController;
  final ItemCategory category;
  final bool enabled;
  final ValueChanged<ItemCategory> onCategoryChanged;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        // 原典 `bg-muted/30 rounded-lg`。
        color: IroriColors.muted.withValues(alpha: 0.3),
        borderRadius: BorderRadius.circular(IroriRadii.button),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              children: [
                TextField(
                  controller: nameController,
                  enabled: enabled,
                  decoration: const InputDecoration(
                    hintText: '食材名',
                    isDense: true,
                    border: OutlineInputBorder(),
                  ),
                  style: const TextStyle(fontSize: 14),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    SizedBox(
                      width: 80,
                      child: TextField(
                        controller: quantityController,
                        enabled: enabled,
                        decoration: const InputDecoration(
                          hintText: '量',
                          isDense: true,
                          border: OutlineInputBorder(),
                        ),
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: DropdownButtonFormField<ItemCategory>(
                        initialValue: category,
                        isDense: true,
                        isExpanded: true,
                        decoration: const InputDecoration(
                          isDense: true,
                          border: OutlineInputBorder(),
                          contentPadding: EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 8,
                          ),
                        ),
                        items: [
                          for (final c in mealIngredientCategories)
                            DropdownMenuItem(
                              value: c,
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(
                                    categoryIcon(c),
                                    size: 14,
                                    color: IroriColors.textMuted,
                                  ),
                                  const SizedBox(width: 4),
                                  Flexible(
                                    child: Text(
                                      c.label,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(fontSize: 12),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                        ],
                        onChanged: enabled
                            ? (value) {
                                if (value != null) onCategoryChanged(value);
                              }
                            : null,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 4),
          IconButton(
            icon: const Icon(LucideIcons.trash2, size: 16),
            tooltip: '食材を削除',
            onPressed: enabled ? onRemove : null,
            color: IroriColors.textMuted,
            // 44x44 の最小タッチ領域 (CLAUDE.md)。
            constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
            padding: EdgeInsets.zero,
          ),
        ],
      ),
    );
  }
}
