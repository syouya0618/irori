import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../core/theme/shadows.dart';
import '../../domain/meal.dart';
import '../meal_display_utils.dart';
import 'meal_reactions_row.dart';

/// 献立カード。Next.js 原典 `meal-card.tsx` の `MealCard` を移植。
///
/// タイトル + (外食なら) `UtensilsCrossed` アイコン + 食材数 +
/// リアクション行。カード全体のタップで編集 sheet を開く。
///
/// glass 表現について: 原典は day セクション内に `.glass` カードを重ねるが、
/// Flutter 版は `GlassCard` (BackdropFilter) を週 7 日 × 3 スロットで重ねると
/// frame budget を圧迫するため (glass_card.dart の注意書き)、blur 無しの
/// `surfaceGlass` 色 + border + shadow で同等の見た目を作る。
class MealCard extends StatelessWidget {
  const MealCard({
    required this.meal,
    required this.currentUserId,
    required this.onTap,
    super.key,
  });

  final Meal meal;

  /// リアクションの自分判定に使う (null = mutation context 未解決)。
  final String? currentUserId;

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: IroriColors.surfaceGlass,
        borderRadius: BorderRadius.circular(IroriRadii.card),
        border: Border.all(color: IroriColors.border),
        boxShadow: IroriShadows.card,
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(IroriRadii.card),
        child: ConstrainedBox(
          // 44px タッチターゲット (CLAUDE.md / 原典 `min-h-11`)。
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        meal.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                          color: IroriColors.textPrimary,
                        ),
                      ),
                    ),
                    if (meal.isEatingOut) ...[
                      const SizedBox(width: 4),
                      // 原典 aria-label="外食" の UtensilsCrossed (size-3.5)。
                      const Icon(
                        LucideIcons.utensilsCrossed,
                        size: 14,
                        color: IroriColors.primary,
                      ),
                    ],
                  ],
                ),
                if (meal.ingredients.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    '食材${meal.ingredients.length}品',
                    style: const TextStyle(
                      fontSize: 10,
                      color: IroriColors.textMuted,
                    ),
                  ),
                ],
                const SizedBox(height: 4),
                // 狭幅端末 (320dp 級) では 3 ボタンがスロット幅を超えるため
                // 縮小描画で守る (web は flexbox の shrink に相当)。
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: MealReactionsRow(
                    mealId: meal.id,
                    reactions: meal.reactions,
                    currentUserId: currentUserId,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 空スロット。原典 `meal-card.tsx` の `EmptyMealSlot` を移植
/// (`+` + 食事タイプラベル、タップで追加 sheet)。
///
/// 原典の `border-dashed` は Flutter 標準 Border に dashed が無く、自前
/// painter は本スコープ過剰のため、淡い実線 border (`border/60` 相当) で
/// 近似する (意図的差異)。
class EmptyMealSlot extends StatelessWidget {
  const EmptyMealSlot({
    required this.mealType,
    required this.onTap,
    super.key,
  });

  final MealType mealType;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final mutedLabel = IroriColors.textMuted.withValues(alpha: 0.6);

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(IroriRadii.card),
        border: Border.all(
          color: IroriColors.border.withValues(alpha: 0.6),
        ),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(IroriRadii.card),
        child: ConstrainedBox(
          // 44px タッチターゲット (CLAUDE.md / 原典 `min-h-11`)。
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  '+',
                  style: TextStyle(
                    fontSize: 18,
                    height: 1,
                    color: mutedLabel,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  mealTypeLabel(mealType),
                  style: TextStyle(fontSize: 10, color: mutedLabel),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
