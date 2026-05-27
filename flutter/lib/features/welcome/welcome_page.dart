import 'package:flutter/material.dart';

import '../../core/theme/colors.dart';
import '../../widgets/glass_card.dart';

/// Phase 0 の Hello World ページ。
///
/// 目的:
/// - GlassCard が CanvasKit renderer で正しく描画されることを実機確認
/// - oklch → sRGB pre-compute した primary 色が既存 Next.js 版と視覚的に一致するか確認
/// - 4.5:1 contrast (text on glass surface) が成立しているか確認
///
/// Phase 1 着手時にこの page は廃止し、`/auth/callback` への redirect に置き換える。
class WelcomePage extends StatelessWidget {
  const WelcomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // 背景は ThemeData.scaffoldBackgroundColor (orange-50 #FFF7ED)
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: GlassCard(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'irori',
                      style: Theme.of(context).textTheme.displayLarge?.copyWith(
                            color: IroriColors.primary,
                          ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'Phase 0: Flutter migration in progress.',
                      style: Theme.of(context).textTheme.bodyLarge,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'See docs/plans/2026-05-27-flutter-migration-design.md for the full plan.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
