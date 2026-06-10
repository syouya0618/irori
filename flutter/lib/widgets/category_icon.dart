import 'package:flutter/widgets.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/domain/item_category.dart';

/// カテゴリに対応する Lucide アイコンを返す。
///
/// Next.js 原典 `shopping-list.tsx` / `stock-list.tsx` の `categoryIcons`
/// (両者は同一マップ) を `lucide_icons_flutter` で再現。全 15 アイコンが
/// 同名で存在するため 1:1 対応 (近似置換なし):
///
/// | web (lucide-react)  | Flutter (LucideIcons)  |
/// |---------------------|------------------------|
/// | Carrot              | carrot                 |
/// | Apple               | apple                  |
/// | Beef                | beef                   |
/// | Fish                | fish                   |
/// | Milk                | milk                   |
/// | Egg                 | egg                    |
/// | Wheat               | wheat                  |
/// | Flame               | flame                  |
/// | Snowflake           | snowflake              |
/// | Cookie              | cookie                 |
/// | UtensilsCrossed     | utensilsCrossed        |
/// | Baby                | baby                   |
/// | SprayCan            | sprayCan               |
/// | Heart               | heart                  |
/// | Package             | package                |
IconData categoryIcon(ItemCategory category) {
  switch (category) {
    case ItemCategory.vegetable:
      return LucideIcons.carrot;
    case ItemCategory.fruit:
      return LucideIcons.apple;
    case ItemCategory.meat:
      return LucideIcons.beef;
    case ItemCategory.fish:
      return LucideIcons.fish;
    case ItemCategory.dairy:
      return LucideIcons.milk;
    case ItemCategory.egg:
      return LucideIcons.egg;
    case ItemCategory.grain:
      return LucideIcons.wheat;
    case ItemCategory.seasoning:
      return LucideIcons.flame;
    case ItemCategory.frozen:
      return LucideIcons.snowflake;
    case ItemCategory.snackFood:
      return LucideIcons.cookie;
    case ItemCategory.otherFood:
      return LucideIcons.utensilsCrossed;
    case ItemCategory.baby:
      return LucideIcons.baby;
    case ItemCategory.cleaning:
      return LucideIcons.sprayCan;
    case ItemCategory.hygiene:
      return LucideIcons.heart;
    case ItemCategory.otherDaily:
      return LucideIcons.package;
  }
}
