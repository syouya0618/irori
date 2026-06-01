import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/radii.dart';
import '../../../../core/theme/shadows.dart';
import '../../domain/baby_weekly_summary.dart';
import '../baby_display_utils.dart';
import 'baby_bar_chart.dart';

/// 週間サマリー (直近 7 日)。原典 `weekly-summary/baby-weekly-summary.tsx` を移植。
///
/// 上段に授乳/睡眠/おむつの週間合計 (StatHeader 3 列)、下段に各 metric の
/// 棒グラフ (`BabyBarChart`) を縦に並べる。[days] は
/// `buildBabyWeeklySummary` の結果 (古い順 7 日)。
///
/// 表示専用 (provider 非依存)。データ取得は `babyWeeklySummaryProvider`、
/// 描画組み込みは `BabyDashboardPage` 側が担う。
class BabyWeeklySummary extends StatelessWidget {
  const BabyWeeklySummary({required this.days, super.key});

  final List<BabyWeeklySummaryDay> days;

  // 原典 Tailwind 配色 (light mode 固定値)。
  static const _amberBg = Color(0xFFFEF3C7); // amber-100
  static const _amberFg = Color(0xFFB45309); // amber-700
  static const _amberBar = Color(0xFFF59E0B); // amber-500
  static const _violetBg = Color(0xFFEDE9FE); // violet-100
  static const _violetFg = Color(0xFF6D28D9); // violet-700
  static const _violetBar = Color(0xFF8B5CF6); // violet-500
  static const _skyBg = Color(0xFFE0F2FE); // sky-100
  static const _skyFg = Color(0xFF0369A1); // sky-700
  static const _skyBar = Color(0xFF0EA5E9); // sky-500

  static String _shortDate(String ymd) {
    final parts = ymd.split('-');
    final month = int.parse(parts[1]);
    final day = int.parse(parts[2]);
    return '$month/$day';
  }

  static String _countLabel(int count) => '$count回';

  @override
  Widget build(BuildContext context) {
    final totals = totalBabyWeeklySummary(days);
    final labels = days.map((d) => _shortDate(d.date)).toList();

    final feedingData = <BabyBarChartDatum>[
      for (var i = 0; i < days.length; i++)
        (label: labels[i], value: days[i].feedingCount.toDouble()),
    ];
    final sleepData = <BabyBarChartDatum>[
      for (var i = 0; i < days.length; i++)
        (label: labels[i], value: days[i].sleepMinutes.toDouble()),
    ];
    final diaperData = <BabyBarChartDatum>[
      for (var i = 0; i < days.length; i++)
        (label: labels[i], value: days[i].diaperCount.toDouble()),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 4),
          child: Text(
            '週間サマリー',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.8,
              color: Color(0xFF475569),
            ),
          ),
        ),
        const SizedBox(height: 8),
        DecoratedBox(
          decoration: BoxDecoration(
            color: const Color(0x80FFFFFF), // glass surface (timeline と同流儀)
            borderRadius: BorderRadius.circular(IroriRadii.card),
            boxShadow: IroriShadows.card,
          ),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: _StatHeader(
                        icon: LucideIcons.milk,
                        label: '授乳',
                        value: _countLabel(totals.feedingCount),
                        bg: _amberBg,
                        fg: _amberFg,
                      ),
                    ),
                    Expanded(
                      child: _StatHeader(
                        icon: LucideIcons.moon,
                        label: '睡眠',
                        value: formatElapsedMinutes(totals.sleepMinutes),
                        bg: _violetBg,
                        fg: _violetFg,
                      ),
                    ),
                    Expanded(
                      child: _StatHeader(
                        icon: LucideIcons.droplets,
                        label: 'おむつ',
                        value: _countLabel(totals.diaperCount),
                        bg: _skyBg,
                        fg: _skyFg,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                _MetricBlock(
                  label: '授乳',
                  total: _countLabel(totals.feedingCount),
                  child: BabyBarChart(
                    ariaLabel: '直近7日の授乳回数',
                    data: feedingData,
                    barColor: _amberBar,
                    maxValue: babyWeeklyChartBaseline.feedingCount.toDouble(),
                    valueFormatter: (v) => _countLabel(v.round()),
                  ),
                ),
                const SizedBox(height: 16),
                _MetricBlock(
                  label: '睡眠',
                  total: formatElapsedMinutes(totals.sleepMinutes),
                  child: BabyBarChart(
                    ariaLabel: '直近7日の睡眠時間',
                    data: sleepData,
                    barColor: _violetBar,
                    maxValue: babyWeeklyChartBaseline.sleepMinutes.toDouble(),
                    valueFormatter: (v) => formatElapsedMinutes(v.round()),
                  ),
                ),
                const SizedBox(height: 16),
                _MetricBlock(
                  label: 'おむつ',
                  total: _countLabel(totals.diaperCount),
                  child: BabyBarChart(
                    ariaLabel: '直近7日のおむつ交換回数',
                    data: diaperData,
                    barColor: _skyBar,
                    maxValue: babyWeeklyChartBaseline.diaperCount.toDouble(),
                    valueFormatter: (v) => _countLabel(v.round()),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// 上段の合計表示 1 列。原典 `StatHeader`。
class _StatHeader extends StatelessWidget {
  const _StatHeader({
    required this.icon,
    required this.label,
    required this.value,
    required this.bg,
    required this.fg,
  });

  final IconData icon;
  final String label;
  final String value;
  final Color bg;
  final Color fg;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 32,
          height: 32,
          decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
          child: Icon(icon, size: 16, color: fg),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: const TextStyle(fontSize: 10, color: Color(0xFF475569)),
              ),
              Text(
                value,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: Color(0xFF0F172A),
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// 各 metric の見出し (ラベル + 合計) + 棒グラフ。原典の 1 metric ブロック。
class _MetricBlock extends StatelessWidget {
  const _MetricBlock({
    required this.label,
    required this.total,
    required this.child,
  });

  final String label;
  final String total;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                label,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: Color(0xFF0F172A),
                ),
              ),
              Text(
                total,
                style: const TextStyle(
                  fontSize: 12,
                  color: Color(0xFF475569),
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
        child,
      ],
    );
  }
}
