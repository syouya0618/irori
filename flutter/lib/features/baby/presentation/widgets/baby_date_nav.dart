import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../data/baby_repository.dart';
import '../../data/selected_baby_date_provider.dart';
import '../baby_display_utils.dart';

/// 日付ナビゲーション。Next.js 原典 `baby-date-nav.tsx` を移植。
///
/// - `selectedBabyDateProvider` を watch し、`formatBabyDateLabel` で
///   "今日" / "昨日" / "M/D（曜）" を表示。
/// - 前/次ボタンは `goToPreviousDay` / `goToNextDay`。
/// - 今日でなければ「今日」ボタンを出す (`goToToday`)。
/// - 次ボタンは今日のとき disabled (未来日へは進めない)。
/// - アイコンボタンは 44px タッチターゲット (CLAUDE.md / 原典 `size-11`)。
class BabyDateNav extends ConsumerWidget {
  const BabyDateNav({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selectedDate = ref.watch(selectedBabyDateProvider);
    final notifier = ref.read(selectedBabyDateProvider.notifier);
    final today = formatJstDate();
    final isToday = selectedDate == today;

    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          formatBabyDateLabel(selectedDate, todayYmd: today),
          style: Theme.of(context).textTheme.titleLarge?.copyWith(
            fontWeight: FontWeight.bold,
            color: IroriColors.textPrimary,
          ),
        ),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _NavIconButton(
              icon: LucideIcons.chevronLeft,
              tooltip: '前の日',
              onPressed: notifier.goToPreviousDay,
            ),
            if (!isToday)
              TextButton(
                onPressed: notifier.goToToday,
                style: TextButton.styleFrom(
                  minimumSize: const Size(44, 44),
                  foregroundColor: IroriColors.textMuted,
                ),
                child: const Text('今日', style: TextStyle(fontSize: 12)),
              ),
            _NavIconButton(
              icon: LucideIcons.chevronRight,
              tooltip: '次の日',
              // 今日のときは未来日へ進めない。
              onPressed: isToday ? null : notifier.goToNextDay,
            ),
          ],
        ),
      ],
    );
  }
}

/// 44px タッチターゲットを満たすアイコンボタン (原典 `size-11` = 44px)。
class _NavIconButton extends StatelessWidget {
  const _NavIconButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: Icon(icon, size: 18),
      tooltip: tooltip,
      onPressed: onPressed,
      color: IroriColors.textPrimary,
      // 44x44 の最小タッチ領域を保証 (CLAUDE.md)。
      constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
      padding: EdgeInsets.zero,
    );
  }
}
