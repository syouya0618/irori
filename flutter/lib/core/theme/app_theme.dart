import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';

import 'colors.dart';

/// irori の Material 3 ベース ThemeData (light / dark)。
///
/// Liquid Glass design system は `GlassCard` 等の custom widget で上層 wrap として実装し、
/// この ThemeData は Material 標準コンポーネントの基盤色 / typography / animation を整える。
///
/// neutral 色は [IroriColorsExt] (light / dark) を単一の真実源とし、ThemeData の
/// `extensions` に装着する。widget 側は `context.colors.textPrimary` 等で参照するため、
/// `themeMode` の切替でこの extension ごと light ⇄ dark が反転する。
/// warm orange の primary と status 色は両モード共通 (`IroriColors` の静的 const)。
ThemeData _buildIroriTheme(IroriColorsExt c, Brightness brightness) {
  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme:
        ColorScheme.fromSeed(
          seedColor: IroriColors.primary,
          brightness: brightness,
        ).copyWith(
          primary: IroriColors.primary,
          surface: c.surface,
          onSurface: c.textPrimary,
          onSurfaceVariant: c.textMuted,
          outlineVariant: c.border,
          error: IroriColors.error,
        ),
    scaffoldBackgroundColor: c.scaffoldBackground,
    extensions: [c],
    textTheme: TextTheme(
      displayLarge: TextStyle(
        fontSize: 32,
        height: 1.3,
        fontWeight: FontWeight.w700,
        color: c.textPrimary,
      ),
      titleLarge: TextStyle(
        fontSize: 20,
        height: 1.4,
        fontWeight: FontWeight.w600,
        color: c.textPrimary,
      ),
      bodyLarge: TextStyle(
        fontSize: 16,
        height: 1.6, // ui-ux-pro-max: 1.5-1.75 を満たす
        color: c.textPrimary,
      ),
      bodyMedium: TextStyle(
        fontSize: 14,
        height: 1.5,
        color: c.textPrimary,
      ),
      bodySmall: TextStyle(
        fontSize: 13,
        height: 1.5,
        color: c.textMuted,
      ),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: c.surface,
      foregroundColor: c.textPrimary,
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
}

/// light テーマ。`MaterialApp.theme` に渡す。
final ThemeData iroriLightTheme = _buildIroriTheme(
  IroriColorsExt.light,
  Brightness.light,
);

/// dark テーマ。`MaterialApp.darkTheme` に渡す。
final ThemeData iroriDarkTheme = _buildIroriTheme(
  IroriColorsExt.dark,
  Brightness.dark,
);
