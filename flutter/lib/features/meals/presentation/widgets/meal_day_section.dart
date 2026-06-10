import 'package:flutter/material.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../core/theme/shadows.dart';
import '../../domain/meal.dart';
import '../meal_display_utils.dart';
import 'meal_card.dart';

/// 1 日分のセクション。Next.js 原典 `meal-week-view.tsx` の "Day rows" を移植。
///
/// - 日付見出し「6/8（月）」+ 今日のみ「今日」バッジ。
/// - 今日は glass 風ハイライト (`glass` + `ring-primary/20` 相当)、
///   それ以外は `bg-muted/30` 相当の控えめ背景。
/// - 朝・昼・夕の 3 スロット (snack は Phase 2.5 — `weekViewMealTypes`)。
///   Meal があれば [MealCard]、なければ [EmptyMealSlot]。
class MealDaySection extends StatelessWidget {
  const MealDaySection({
    required this.date,
    required this.isToday,
    required this.mealsByType,
    required this.currentUserId,
    required this.onCreateSlot,
    required this.onEditMeal,
    super.key,
  });

  /// この日の "YYYY-MM-DD"。
  final String date;

  final bool isToday;

  /// この日の食事タイプ → Meal (UNIQUE(household, date, meal_type) ゆえ最大1件)。
  final Map<MealType, Meal> mealsByType;

  /// リアクション行へ伝播する自分の user id。
  final String? currentUserId;

  /// 空スロットタップ (追加 sheet を開く)。
  final void Function(String date, MealType mealType) onCreateSlot;

  /// 献立カードタップ (編集 sheet を開く)。
  final void Function(Meal meal) onEditMeal;

  @override
  Widget build(BuildContext context) {
    // 原典: 今日 = `glass shadow-lg ring-1 ring-primary/20`、
    // それ以外 = `bg-muted/30`。blur は重ねない (meal_card.dart の注記参照)。
    final decoration = isToday
        ? BoxDecoration(
            color: IroriColors.surfaceGlass,
            borderRadius: BorderRadius.circular(IroriRadii.card),
            border: Border.all(
              color: IroriColors.primary.withValues(alpha: 0.2),
            ),
            boxShadow: IroriShadows.card,
          )
        : BoxDecoration(
            color: IroriColors.muted.withValues(alpha: 0.3),
            borderRadius: BorderRadius.circular(IroriRadii.card),
          );

    return DecoratedBox(
      decoration: decoration,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  formatMealDayHeader(date),
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: isToday
                        ? IroriColors.primary
                        : IroriColors.textPrimary,
                  ),
                ),
                if (isToday) ...[
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: IroriColors.primary,
                      borderRadius: BorderRadius.circular(IroriRadii.pill),
                    ),
                    child: const Text(
                      '今日',
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w500,
                        // 原典 `text-primary-foreground` (白)。
                        color: IroriColors.surface,
                      ),
                    ),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var i = 0; i < weekViewMealTypes.length; i++) ...[
                  if (i > 0) const SizedBox(width: 8),
                  Expanded(child: _buildSlot(weekViewMealTypes[i])),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSlot(MealType type) {
    final meal = mealsByType[type];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          mealTypeShortLabel(type),
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w500,
            color: IroriColors.textMuted,
          ),
        ),
        const SizedBox(height: 4),
        if (meal != null)
          MealCard(
            meal: meal,
            currentUserId: currentUserId,
            onTap: () => onEditMeal(meal),
          )
        else
          EmptyMealSlot(
            mealType: type,
            onTap: () => onCreateSlot(date, type),
          ),
      ],
    );
  }
}
