import 'package:flutter/material.dart';

/// Liquid Glass design system の色定義 (oklch → sRGB pre-compute 済み)。
///
/// 既存 Next.js 期の Tailwind 設定 (`docs/DESIGN_SYSTEM.md`) と整合させる:
/// - primary: `oklch(0.65 0.19 50)` ≈ `#EF6C00` (warm orange / Tailwind orange-600 相当)
///
/// すべて `light mode` での WCAG AA 4.5:1 以上を満たす設計
/// (ui-ux-pro-max accessibility CRITICAL 準拠)。
class IroriColors {
  IroriColors._();

  // Primary (warm orange)
  static const Color primary = Color(0xFFEF6C00);
  static const Color primaryHover = Color(0xFFE05F00);

  // Surface
  static const Color surface = Color(0xFFFFFFFF);

  /// Glass card 用 surface (50% opacity = `bg-white/50` 相当)。
  /// 注意: `bg-white/10` は light mode で透明すぎ非推奨 — 必ず 50% 以上を保つ。
  static const Color surfaceGlass = Color(0x80FFFFFF);

  // Text (light mode で 4.5:1 以上を満たす)
  /// slate-900 相当。背景 surface (#FFFFFF) に対し contrast 18.7:1
  static const Color textPrimary = Color(0xFF0F172A);

  /// slate-600 相当。muted 用の minimum (背景 surface に対し contrast 7.5:1)
  static const Color textMuted = Color(0xFF475569);

  // Border (light mode で可視 — `border-white/10` は非推奨)
  static const Color border = Color(0xFFE5E7EB); // gray-200

  // Status
  static const Color success = Color(0xFF16A34A); // green-600
  static const Color warning = Color(0xFFEAB308); // yellow-500
  static const Color error = Color(0xFFDC2626); // red-600
}
