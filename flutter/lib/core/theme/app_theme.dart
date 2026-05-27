import 'package:flutter/material.dart';

import 'colors.dart';

/// irori の Material 3 ベース ThemeData。
///
/// Liquid Glass design system は `GlassCard` 等の custom widget で上層 wrap として実装し、
/// この ThemeData は Material 標準コンポーネントの基盤色 / typography / animation を整える。
///
/// dark mode は Phase 4 cutover 後の改善 task として保留 (Section 7.5.2)。
final ThemeData iroriTheme = ThemeData(
  useMaterial3: true,
  colorScheme: ColorScheme.fromSeed(
    seedColor: IroriColors.primary,
    brightness: Brightness.light,
  ).copyWith(
    primary: IroriColors.primary,
    surface: IroriColors.surface,
    onSurface: IroriColors.textPrimary,
    error: IroriColors.error,
  ),
  scaffoldBackgroundColor: const Color(0xFFFFF7ED), // orange-50 (warm 背景)
  textTheme: const TextTheme(
    displayLarge: TextStyle(
      fontSize: 32,
      height: 1.3,
      fontWeight: FontWeight.w700,
      color: IroriColors.textPrimary,
    ),
    titleLarge: TextStyle(
      fontSize: 20,
      height: 1.4,
      fontWeight: FontWeight.w600,
      color: IroriColors.textPrimary,
    ),
    bodyLarge: TextStyle(
      fontSize: 16,
      height: 1.6, // ui-ux-pro-max: 1.5-1.75 を満たす
      color: IroriColors.textPrimary,
    ),
    bodyMedium: TextStyle(
      fontSize: 14,
      height: 1.5,
      color: IroriColors.textPrimary,
    ),
    bodySmall: TextStyle(
      fontSize: 13,
      height: 1.5,
      color: IroriColors.textMuted,
    ),
  ),
  appBarTheme: const AppBarTheme(
    backgroundColor: IroriColors.surface,
    foregroundColor: IroriColors.textPrimary,
    elevation: 0,
    centerTitle: false,
  ),
  // Touch target 44x44 以上 (M3 default kMinInteractiveDimension=48 で自動充足)
  // hover/tap feedback は Material default の InkWell ripple を維持
  // Page transitions: 150-300ms に収まる Material default
  pageTransitionsTheme: const PageTransitionsTheme(
    builders: {
      TargetPlatform.android: ZoomPageTransitionsBuilder(),
      TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
    },
  ),
);
