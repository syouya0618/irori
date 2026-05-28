import 'dart:ui';

import 'package:flutter/material.dart';

import '../core/theme/colors.dart';
import '../core/theme/radii.dart';
import '../core/theme/shadows.dart';

/// Liquid Glass design system の基本パーツ。
///
/// 内部実装:
/// - `ClipRRect` で角丸 (16px / `rounded-2xl` 相当)
/// - `BackdropFilter` + `ImageFilter.blur(sigmaX: 10, sigmaY: 10)` で背景ぼかし
/// - 50% opacity の白で glass 質感、light mode で 4.5:1 contrast を保つ
/// - `IroriShadows.card` で柔らかい影
/// - `IroriColors.border` で light mode 可視性を担保
///
/// 注意 (設計書 Section 7.1.2):
/// 子要素に重ねて `GlassCard` を使うと frame budget 圧迫リスク。
/// 1 階層に留めること (rendering tree の sibling 配置を意識)。
class GlassCard extends StatelessWidget {
  const GlassCard({
    required this.child,
    this.padding = const EdgeInsets.all(16),
    super.key,
  });

  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(IroriRadii.card),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: IroriColors.surfaceGlass,
            borderRadius: BorderRadius.circular(IroriRadii.card),
            border: Border.all(color: IroriColors.border),
            boxShadow: IroriShadows.card,
          ),
          child: Padding(padding: padding, child: child),
        ),
      ),
    );
  }
}
