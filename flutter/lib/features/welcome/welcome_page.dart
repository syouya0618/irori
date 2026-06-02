import 'package:flutter/material.dart';

import '../../core/theme/colors.dart';
import '../../widgets/glass_card.dart';

/// Phase 0 の Hello World ページ。
///
/// 目的:
/// - GlassCard の BackdropFilter blur が CanvasKit renderer で正しく機能するかを
///   実機確認する。**単色 scaffold 背景では blur が視認できぬ**ため、Container で
///   gradient + 装飾 dot を敷き、その上に GlassCard を載せる構造にしている。
/// - oklch → sRGB pre-compute した primary 色 (#E56200) が既存 Next.js 版
///   (ブラウザ native oklch() 計算結果) と視覚的に一致するか確認する。
/// - 4.5:1 contrast (text on glass surface) が成立しているか確認する。
///
/// Phase 1 着手時にこの page は廃止し、`/auth/callback` への redirect に置き換える。
class WelcomePage extends StatelessWidget {
  const WelcomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          // 背景レイヤー: gradient + 装飾 dot で BackdropFilter blur の効果を視認可能にする
          const _BlurBackdrop(),
          SafeArea(
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
                          style: Theme.of(context).textTheme.displayLarge
                              ?.copyWith(
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
                          'See the repository README for details.',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// GlassCard の BackdropFilter blur 効果を視認するための背景レイヤー。
///
/// gradient + 4 つの装飾 dot を敷くことで、GlassCard 越しに blur が
/// 効いていることが目視確認できる。blur が壊れている場合は dot が
/// シャープに見え、機能していれば滲んで見える。
class _BlurBackdrop extends StatelessWidget {
  const _BlurBackdrop();

  @override
  Widget build(BuildContext context) {
    return const DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Color(0xFFFFF7ED), // orange-50
            Color(0xFFFFEDD5), // orange-100
          ],
        ),
      ),
      child: Stack(
        children: [
          Positioned(
            top: 80,
            left: 40,
            child: _Dot(color: IroriColors.primary, size: 120),
          ),
          Positioned(
            top: 220,
            right: 50,
            child: _Dot(color: Color(0xFFFED7AA), size: 180), // orange-200
          ),
          Positioned(
            bottom: 100,
            left: 60,
            child: _Dot(color: Color(0xFFFBA74D), size: 100), // orange-400
          ),
          Positioned(
            bottom: 60,
            right: 30,
            child: _Dot(color: Color(0xFFF97316), size: 140), // orange-500
          ),
        ],
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.color, required this.size});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.7),
        shape: BoxShape.circle,
      ),
    );
  }
}
