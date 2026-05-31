import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/radii.dart';
import '../../../../core/theme/shadows.dart';
import '../../domain/baby_log.dart';
import '../baby_display_utils.dart';

/// 授乳経過 / おむつ回数 / 睡眠状態の 3 カラムサマリー。
/// Next.js 原典 `baby-summary-bar.tsx` を移植。
///
/// 引数 (原典 props 同等):
/// - [lastFeeding]: 最後の授乳ログ (null なら "---")。
/// - [diaperCount]: おむつ回数。
/// - [activeSleep]: 進行中の睡眠 (あれば睡眠経過、なければ覚醒経過を表示)。
/// - [lastSleepEndedAt]: 最後に起きた時刻 (覚醒経過の基準)。
/// - [now]: 経過計算の基準時刻 (ダッシュボードが 60s ごとに更新する)。
///
/// 経過計算は原典と一致 (`minutesBetween` + `formatElapsedMinutes`)。
/// アイコンは Lucide (Milk/Droplets/Moon/Sun)。GlassCard 風の 3 セルを grid 配置。
class BabySummaryBar extends StatelessWidget {
  const BabySummaryBar({
    required this.lastFeeding,
    required this.diaperCount,
    required this.activeSleep,
    required this.lastSleepEndedAt,
    required this.now,
    super.key,
  });

  final BabyLog? lastFeeding;
  final int diaperCount;
  final BabyLog? activeSleep;
  final DateTime? lastSleepEndedAt;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final feeding = lastFeeding;
    final feedingElapsed = feeding != null
        ? minutesBetween(feeding.loggedAt, now)
        : null;

    final sleep = activeSleep;
    final sleepElapsed = sleep != null
        ? minutesBetween(sleep.loggedAt, now)
        : null;

    // 覚醒時間: 起きている + 最後に起きた時刻がある場合のみ。
    final lastEnded = lastSleepEndedAt;
    final awakeElapsed = (sleep == null && lastEnded != null)
        ? minutesBetween(lastEnded, now)
        : null;

    final isSleeping = sleep != null;

    // IntrinsicHeight で stretch が「最も高いセルの高さ」に解決される。
    // これが無いと ListView 内の unbounded 縦方向で stretch が無限大に発散し
    // RenderFlex overflow (9999996px) になる。3 セルを等高 grid 風に揃える。
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: _SummaryCell(
              icon: LucideIcons.milk,
              iconColor: _amberFg,
              iconBg: _amberBg,
              label: '授乳',
              value: feedingElapsed != null
                  ? '${formatElapsedMinutes(feedingElapsed)}前'
                  : '---',
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: _SummaryCell(
              icon: LucideIcons.droplets,
              iconColor: _skyFg,
              iconBg: _skyBg,
              label: 'おむつ',
              value: diaperCount > 0 ? '$diaperCount回' : '---',
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: _SummaryCell(
              icon: isSleeping ? LucideIcons.moon : LucideIcons.sun,
              iconColor: isSleeping ? _violetFg : _emeraldFg,
              iconBg: isSleeping ? _violetBg : _emeraldBg,
              label: isSleeping ? '睡眠中' : '起きてる',
              value: sleepElapsed != null
                  ? formatElapsedMinutes(sleepElapsed)
                  : awakeElapsed != null
                  ? formatElapsedMinutes(awakeElapsed)
                  : '---',
            ),
          ),
        ],
      ),
    );
  }
}

/// 1 カラムの glass セル。アイコン丸背景 + ラベル + 値。
class _SummaryCell extends StatelessWidget {
  const _SummaryCell({
    required this.icon,
    required this.iconColor,
    required this.iconBg,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final Color iconColor;
  final Color iconBg;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: const Color(0x80FFFFFF), // glass surface (bg-white/50 相当)
        borderRadius: BorderRadius.circular(IroriRadii.card),
        boxShadow: IroriShadows.card,
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 32,
              height: 32,
              decoration: BoxDecoration(color: iconBg, shape: BoxShape.circle),
              child: Icon(icon, size: 16, color: iconColor),
            ),
            const SizedBox(height: 6),
            Text(
              label,
              style: const TextStyle(fontSize: 10, color: Color(0xFF475569)),
            ),
            const SizedBox(height: 2),
            Text(
              value,
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                // 原典 `font-mono` の意図 = 数字幅を揃える。Flutter では
                // `'monospace'` family は登録済み alias でなく無効化されうるため、
                // font 非依存で効く tabular figures を使う (advisor 指摘)。
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// 原典 Tailwind の色 (amber/sky/violet/emerald 100/700) を light mode で固定。
const _amberBg = Color(0xFFFEF3C7); // amber-100
const _amberFg = Color(0xFFB45309); // amber-700
const _skyBg = Color(0xFFE0F2FE); // sky-100
const _skyFg = Color(0xFF0369A1); // sky-700
const _violetBg = Color(0xFFEDE9FE); // violet-100
const _violetFg = Color(0xFF6D28D9); // violet-700
const _emeraldBg = Color(0xFFD1FAE5); // emerald-100
const _emeraldFg = Color(0xFF047857); // emerald-700
