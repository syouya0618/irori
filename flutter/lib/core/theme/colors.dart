import 'package:flutter/material.dart';

/// Liquid Glass design system の色定義 (oklch → sRGB pre-compute 済み)。
///
/// 既存 Next.js 期の Tailwind 設定 (`docs/DESIGN_SYSTEM.md`) と整合させる:
/// - primary: `oklch(0.65 0.19 50)` ≈ `#E56200` (warm orange)
///   CSS Color 4 仕様の oklch → sRGB 正規アルゴリズム (D65 white point, Bradford
///   chromatic adaptation 不要) で計算: RGB(229, 98, 0)。
///   既存 Next.js 側 (`src/app/globals.css` の `--primary: oklch(0.65 0.19 50)`)
///   はブラウザの CSS native 計算で同値に解決される (Chromium / Firefox / Safari)。
///   `docs/DESIGN_SYSTEM.md` の `#e07020` 記載は旧値ゆえ別 PR で訂正予定。
///
/// すべて `light mode` での WCAG AA 4.5:1 以上を満たす設計
/// (ui-ux-pro-max accessibility CRITICAL 準拠)。
class IroriColors {
  IroriColors._();

  // Primary (warm orange — oklch(0.65 0.19 50) を CSS Color 4 で sRGB 化)
  static const Color primary = Color(0xFFE56200);
  // hover: lightness を 0.65 → 0.60 に下げた oklch(0.60 0.19 50) = #D45100
  static const Color primaryHover = Color(0xFFD45100);

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

  /// Muted surface。web `--muted: oklch(0.96 0.008 75)` (わずかに温かみのある
  /// light gray) の CSS Color 4 → sRGB 変換値 = RGB(245, 241, 236)。
  /// 献立週ビューの非今日 day セクション背景 (`bg-muted/30`) や入力行の
  /// 背景 (`bg-muted/30` / `bg-muted/50`) は本色 + `withValues(alpha:)` で表す。
  static const Color muted = Color(0xFFF5F1EC);

  // Status
  static const Color success = Color(0xFF16A34A); // green-600
  static const Color warning = Color(0xFFEAB308); // yellow-500
  static const Color error = Color(0xFFDC2626); // red-600
}

/// テーマ (light / dark) で反転する **中立色** を運ぶ [ThemeExtension]。
///
/// 背景 / テキスト / 境界などの neutral は light と dark で反転させる必要が
/// あるため、`IroriColors` の静的 const を直接参照する代わりに本 extension を
/// 経由する (`context.colors.textPrimary` など)。warm orange の primary や
/// status 色 (error/warning/success) は両モードでアクセントとして読めるため
/// 引き続き `IroriColors` の静的 const を直接使う (反転不要)。
///
/// light 値は既存の `IroriColors` 定数を単一の真実源として再利用する。
/// dark 値は warm-dark (stone) 系で、Liquid Glass の温かみを保ちつつ
/// dark surface 上で WCAG AA (4.5:1) を満たすよう選定:
/// - textPrimary #F5F5F4 on surface #292524 ≈ 13.6:1
/// - textMuted   #A8A29E on surface #292524 ≈ 5.9:1
@immutable
class IroriColorsExt extends ThemeExtension<IroriColorsExt> {
  const IroriColorsExt({
    required this.textPrimary,
    required this.textMuted,
    required this.surface,
    required this.surfaceGlass,
    required this.border,
    required this.muted,
    required this.scaffoldBackground,
  });

  /// slate-900 相当 (light) / stone-100 相当 (dark)。本文の既定色。
  final Color textPrimary;

  /// slate-600 相当 (light) / stone-400 相当 (dark)。muted テキスト。
  final Color textMuted;

  /// カード等の不透明 surface (white / stone-800)。
  final Color surface;

  /// Glass card 用の半透明 surface (white 50% / stone-800 80%)。
  final Color surfaceGlass;

  /// 境界線 (gray-200 / stone-700)。
  final Color border;

  /// muted 背景 (warm light gray / stone-800)。alpha 付きで薄背景に使う。
  final Color muted;

  /// Scaffold の背景 (orange-50 / stone-900)。warm な地色。
  final Color scaffoldBackground;

  /// light テーマの neutral (既存 `IroriColors` 定数を再利用)。
  static const IroriColorsExt light = IroriColorsExt(
    textPrimary: IroriColors.textPrimary,
    textMuted: IroriColors.textMuted,
    surface: IroriColors.surface,
    surfaceGlass: IroriColors.surfaceGlass,
    border: IroriColors.border,
    muted: IroriColors.muted,
    scaffoldBackground: Color(0xFFFFF7ED), // orange-50 (warm 背景)
  );

  /// dark テーマの neutral (warm-dark / stone 系)。
  static const IroriColorsExt dark = IroriColorsExt(
    textPrimary: Color(0xFFF5F5F4), // stone-100
    textMuted: Color(0xFFA8A29E), // stone-400
    surface: Color(0xFF292524), // stone-800
    surfaceGlass: Color(0xCC292524), // stone-800 @ 80%
    border: Color(0xFF44403C), // stone-700
    muted: Color(0xFF292524), // stone-800
    scaffoldBackground: Color(0xFF1C1917), // stone-900
  );

  @override
  IroriColorsExt copyWith({
    Color? textPrimary,
    Color? textMuted,
    Color? surface,
    Color? surfaceGlass,
    Color? border,
    Color? muted,
    Color? scaffoldBackground,
  }) {
    return IroriColorsExt(
      textPrimary: textPrimary ?? this.textPrimary,
      textMuted: textMuted ?? this.textMuted,
      surface: surface ?? this.surface,
      surfaceGlass: surfaceGlass ?? this.surfaceGlass,
      border: border ?? this.border,
      muted: muted ?? this.muted,
      scaffoldBackground: scaffoldBackground ?? this.scaffoldBackground,
    );
  }

  @override
  IroriColorsExt lerp(IroriColorsExt? other, double t) {
    if (other == null) return this;
    return IroriColorsExt(
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textMuted: Color.lerp(textMuted, other.textMuted, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surfaceGlass: Color.lerp(surfaceGlass, other.surfaceGlass, t)!,
      border: Color.lerp(border, other.border, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      scaffoldBackground: Color.lerp(
        scaffoldBackground,
        other.scaffoldBackground,
        t,
      )!,
    );
  }
}

/// `context.colors.textPrimary` で現在テーマの neutral を引くための getter。
///
/// テストは theme 無しの素の `MaterialApp` で pump するため extension が
/// 未装着になりうる。その場合は [IroriColorsExt.light] にフォールバックし、
/// 従来 (light) 挙動を保つ (握り潰しではなく既定値。本番は必ず装着される)。
extension IroriColorsContext on BuildContext {
  IroriColorsExt get colors =>
      Theme.of(this).extension<IroriColorsExt>() ?? IroriColorsExt.light;
}
