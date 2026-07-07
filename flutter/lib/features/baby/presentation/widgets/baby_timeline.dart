import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../core/theme/shadows.dart';
import '../../domain/baby_log.dart';
import 'baby_timeline_item.dart';

/// タイムライン。Next.js 原典 `baby-timeline.tsx` を移植。
///
/// - [logs] が空なら空状態 (Lucide Baby アイコン + "まだ記録がありません")。
/// - 非空なら見出し "タイムライン" + glass カード内に `BabyTimelineItem` を
///   区切り線付きで並べる。
/// - [onItemTap]: 各行のタップコールバック。ダッシュボードが編集シート
///   (`showBabyLogFormSheet`) を開く配線済み (#61)。
class BabyTimeline extends StatelessWidget {
  const BabyTimeline({
    required this.logs,
    this.onItemTap,
    super.key,
  });

  final List<BabyLog> logs;
  final void Function(BabyLog log)? onItemTap;

  @override
  Widget build(BuildContext context) {
    if (logs.isEmpty) {
      return const _EmptyState();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text(
            'タイムライン',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.8,
              color: context.colors.textMuted,
            ),
          ),
        ),
        const SizedBox(height: 4),
        DecoratedBox(
          decoration: BoxDecoration(
            color: context.colors.surfaceGlass, // glass surface
            borderRadius: BorderRadius.circular(IroriRadii.card),
            boxShadow: IroriShadows.card,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = 0; i < logs.length; i++) ...[
                if (i > 0)
                  const Divider(
                    height: 1,
                    thickness: 1,
                    color: Color(0x4DE5E7EB), // border/30 相当
                  ),
                BabyTimelineItem(log: logs[i], onTap: onItemTap),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// 空状態。原典: Baby アイコン (薄色) + "まだ記録がありません"。
class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            LucideIcons.baby,
            size: 48,
            color: context.colors.textMuted.withValues(alpha: 0.3),
          ),
          const SizedBox(height: 12),
          Text(
            'まだ記録がありません',
            style: TextStyle(fontSize: 14, color: context.colors.textMuted),
          ),
        ],
      ),
    );
  }
}
