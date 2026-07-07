import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../../core/theme/colors.dart';
import '../../../../core/theme/radii.dart';
import '../../../../widgets/glass_card.dart';
import '../../data/theme_mode_provider.dart';

/// テーマ切替の選択肢 (web `theme-card.tsx` の THEME_OPTIONS と同順・同ラベル)。
const _kThemeOptions = [
  (mode: ThemeMode.light, label: 'ライト', icon: LucideIcons.sun),
  (mode: ThemeMode.dark, label: 'ダーク', icon: LucideIcons.moon),
  (mode: ThemeMode.system, label: 'システム', icon: LucideIcons.monitor),
];

/// テーマ (light / dark / system) カード。Next.js 原典 `theme-card.tsx` の
/// Flutter 移植。web の deferred だった Theme カードを実装する。
///
/// 状態は [themeModeProvider] (アプリ全体) を単一の真実源とし、タップで
/// [ThemeModeNotifier.setThemeMode] を呼ぶ。永続化 (SharedPreferences) と
/// `MaterialApp.themeMode` への反映は provider が担う。
class ThemeModeCard extends ConsumerWidget {
  const ThemeModeCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selected = ref.watch(themeModeProvider);
    final notifier = ref.read(themeModeProvider.notifier);

    return GlassCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // web: <Sun size={18} /> テーマ
              Icon(
                LucideIcons.sun,
                size: 18,
                color: context.colors.textPrimary,
              ),
              const SizedBox(width: 8),
              Text(
                'テーマ',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: context.colors.textPrimary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          // 原典: `flex gap-1 rounded-xl bg-muted/50 p-1` のセグメント。
          Container(
            padding: const EdgeInsets.all(4),
            decoration: BoxDecoration(
              color: context.colors.muted.withValues(alpha: 0.5),
              borderRadius: BorderRadius.circular(IroriRadii.button),
            ),
            child: Row(
              children: [
                for (final (index, option) in _kThemeOptions.indexed) ...[
                  if (index > 0) const SizedBox(width: 4),
                  Expanded(
                    child: _ThemeSegment(
                      label: option.label,
                      icon: option.icon,
                      active: selected == option.mode,
                      onTap: () => notifier.setThemeMode(option.mode),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// セグメント 1 個 (default_page_card の `_SegmentButton` と同形 + アイコン)。
class _ThemeSegment extends StatelessWidget {
  const _ThemeSegment({
    required this.label,
    required this.icon,
    required this.active,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // 原典: active = bg-primary text-primary-foreground。
    final fg = active ? Colors.white : context.colors.textMuted;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        // 44px タッチターゲット (CLAUDE.md)。
        constraints: const BoxConstraints(minHeight: 44),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: active ? IroriColors.primary : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: fg),
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                label,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  color: fg,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
