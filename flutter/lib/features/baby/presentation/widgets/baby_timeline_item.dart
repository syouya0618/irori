import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../domain/baby_log.dart';
import '../baby_display_utils.dart';

/// ログ種別ごとのアイコン / 配色。原典 `baby-timeline-item.tsx` の `logTypeConfig`。
class _LogTypeStyle {
  const _LogTypeStyle({
    required this.icon,
    required this.bg,
    required this.fg,
  });

  final IconData icon;
  final Color bg;
  final Color fg;
}

/// 原典 Tailwind 配色 (light mode 値で固定)。
const Map<BabyLogType, _LogTypeStyle> _logTypeStyles = {
  BabyLogType.feeding: _LogTypeStyle(
    icon: LucideIcons.milk,
    bg: Color(0xFFFEF3C7), // amber-100
    fg: Color(0xFFB45309), // amber-700
  ),
  BabyLogType.diaper: _LogTypeStyle(
    icon: LucideIcons.droplets,
    bg: Color(0xFFE0F2FE), // sky-100
    fg: Color(0xFF0369A1), // sky-700
  ),
  BabyLogType.sleep: _LogTypeStyle(
    icon: LucideIcons.moon,
    bg: Color(0xFFEDE9FE), // violet-100
    fg: Color(0xFF6D28D9), // violet-700
  ),
  BabyLogType.temperature: _LogTypeStyle(
    icon: LucideIcons.thermometer,
    bg: Color(0xFFFFE4E6), // rose-100
    fg: Color(0xFFBE123C), // rose-700
  ),
  BabyLogType.growth: _LogTypeStyle(
    icon: LucideIcons.ruler,
    bg: Color(0xFFCCFBF1), // teal-100
    fg: Color(0xFF0F766E), // teal-700
  ),
  BabyLogType.memo: _LogTypeStyle(
    icon: LucideIcons.stickyNote,
    bg: Color(0xFFF3F4F6), // gray-100
    fg: Color(0xFF4B5563), // gray-600
  ),
};

/// タイムライン 1 行。原典 `baby-timeline-item.tsx` を移植。
///
/// 種別アイコン丸背景 + `getLogSummary` 要約 + (あれば) memo 補足 +
/// `formatTimeJst` の右端時刻 + chevron。
///
/// [onTap]: optional コールバック。ダッシュボードが編集シートを開く配線済み
/// (#61)。未指定なら no-op (InkWell は表示するがアクションなし)。
/// タップ領域は >=44px 高を確保する。
class BabyTimelineItem extends StatelessWidget {
  const BabyTimelineItem({
    required this.log,
    this.onTap,
    super.key,
  });

  final BabyLog log;

  /// 行タップ時のコールバック。ダッシュボードが編集シートを開く配線で使う (#61)。
  /// 未指定 = no-op (InkWell は表示するがアクションなし)。
  final void Function(BabyLog log)? onTap;

  @override
  Widget build(BuildContext context) {
    final style = _logTypeStyles[log.logType]!;
    final memo = log.memo;
    final hasMemo = memo != null && memo.isNotEmpty;

    return InkWell(
      onTap: onTap == null ? null : () => onTap!(log),
      child: ConstrainedBox(
        // 44px タッチターゲット (CLAUDE.md)。
        constraints: const BoxConstraints(minHeight: 44),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: style.bg,
                  shape: BoxShape.circle,
                ),
                child: Icon(style.icon, size: 18, color: style.fg),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      getLogSummary(log),
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                        color: Color(0xFF0F172A),
                      ),
                    ),
                    if (hasMemo)
                      Text(
                        memo,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 12,
                          color: Color(0xFF475569),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    formatTimeJst(log.loggedAt),
                    style: const TextStyle(
                      fontSize: 12,
                      // 原典 `font-mono` の意図 = 時刻の数字幅を揃える。
                      // font 非依存で効く tabular figures を使う (advisor 指摘)。
                      fontFeatures: [FontFeature.tabularFigures()],
                      color: Color(0xFF475569),
                    ),
                  ),
                  const SizedBox(width: 4),
                  const Icon(
                    LucideIcons.chevronsRight,
                    size: 12,
                    color: Color(0xFF475569),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
