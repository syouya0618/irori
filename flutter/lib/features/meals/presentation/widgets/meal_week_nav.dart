import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../../../widgets/glass_card.dart';
import '../../data/selected_week_start_provider.dart';
import '../meal_display_utils.dart';

/// 週ナビゲーション。Next.js 原典 `meal-week-view.tsx` の
/// "Week navigation header" (glass カード) を移植。
///
/// - 前週/次週ボタン (`ChevronLeft` / `ChevronRight`、aria-label と同じ
///   tooltip 「前の週」「次の週」)。
/// - 中央に週範囲「6月8日〜6月14日」(`formatWeekRange`)。
/// - 今週でないときだけ「今週」ボタンを表示 (`goToCurrentWeek`)。
///
/// 状態は `selectedWeekStartProvider` が持ち、変更で
/// `MealsWeekNotifier.build()` が refetch する (F1 の配線)。
class MealWeekNav extends ConsumerWidget {
  const MealWeekNav({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final weekStart = ref.watch(selectedWeekStartProvider);
    final notifier = ref.read(selectedWeekStartProvider.notifier);
    final isCurrentWeek = isCurrentWeekStart(weekStart);

    return GlassCard(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              _NavIconButton(
                icon: LucideIcons.chevronLeft,
                tooltip: '前の週',
                onPressed: notifier.previousWeek,
              ),
              Text(
                formatWeekRange(weekStart),
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: IroriColors.textPrimary,
                ),
              ),
              _NavIconButton(
                icon: LucideIcons.chevronRight,
                tooltip: '次の週',
                onPressed: notifier.nextWeek,
              ),
            ],
          ),
          if (!isCurrentWeek)
            TextButton(
              onPressed: notifier.goToCurrentWeek,
              style: TextButton.styleFrom(
                minimumSize: const Size(44, 44),
                foregroundColor: IroriColors.textMuted,
              ),
              child: const Text('今週', style: TextStyle(fontSize: 12)),
            ),
        ],
      ),
    );
  }
}

/// 44px タッチターゲットのアイコンボタン (`BabyDateNav._NavIconButton` と同形)。
class _NavIconButton extends StatelessWidget {
  const _NavIconButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: Icon(icon, size: 18),
      tooltip: tooltip,
      onPressed: onPressed,
      color: IroriColors.textPrimary,
      // 44x44 の最小タッチ領域を保証 (CLAUDE.md / 原典 `min-h-11 min-w-11`)。
      constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
      padding: EdgeInsets.zero,
    );
  }
}
