import 'package:flutter/material.dart';

import '../../../../core/domain/item_category.dart';
import '../../../../core/theme/colors.dart';
import '../../../../widgets/category_icon.dart';
import '../../../../widgets/glass_card.dart';
import '../../domain/shopping_item.dart';
import 'shopping_item_tile.dart';

/// カテゴリ 1 グループ (ヘッダー + glass カードのアイテム一覧)。
/// web `shopping-list.tsx` の `groupedUnchecked.map(...)` ブロックを移植:
/// カテゴリーヘッダー (アイコン 14px + ラベル) と
/// `glass rounded-2xl divide-y` のアイテムコンテナ。
class ShoppingCategoryGroup extends StatelessWidget {
  const ShoppingCategoryGroup({
    required this.category,
    required this.items,
    required this.memberNames,
    super.key,
  });

  final ItemCategory category;

  /// このカテゴリの未チェックアイテム (呼び出し側で `sort_order` 昇順済み)。
  final List<ShoppingItem> items;

  /// メンバー id → 表示名 (web の `memberMap`)。
  final Map<String, String> memberNames;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // カテゴリーヘッダー (原典 `px-1 pt-3 pb-1` + muted アイコン/ラベル)。
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 12, 4, 4),
          child: Row(
            children: [
              Icon(
                categoryIcon(category),
                size: 14,
                color: IroriColors.textMuted,
              ),
              const SizedBox(width: 8),
              Text(
                category.label,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: IroriColors.textMuted,
                ),
              ),
            ],
          ),
        ),
        GlassCard(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: ShoppingTileList(items: items, memberNames: memberNames),
        ),
      ],
    );
  }
}

/// divider 区切りのタイル列 (原典 `divide-y divide-border/30`)。
/// カテゴリグループとチェック済みセクションで共用する。
class ShoppingTileList extends StatelessWidget {
  const ShoppingTileList({
    required this.items,
    required this.memberNames,
    super.key,
  });

  final List<ShoppingItem> items;
  final Map<String, String> memberNames;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (var i = 0; i < items.length; i++) ...[
          if (i > 0)
            Divider(
              height: 1,
              thickness: 1,
              color: IroriColors.border.withValues(alpha: 0.3),
            ),
          ShoppingItemTile(
            // 並べ替え/グループ移動時にもタイルの楽観 state が item id に
            // 追従するよう id で key を振る。
            key: ValueKey(items[i].id),
            item: items[i],
            checkedByName: items[i].checkedBy == null
                ? null
                : memberNames[items[i].checkedBy],
          ),
        ],
      ],
    );
  }
}
