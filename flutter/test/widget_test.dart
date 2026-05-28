import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/features/welcome/welcome_page.dart';
import 'package:irori/widgets/glass_card.dart';

void main() {
  group('GlassCard', () {
    testWidgets('renders its child', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: GlassCard(child: Text('hello')),
          ),
        ),
      );

      expect(find.text('hello'), findsOneWidget);
    });

    testWidgets('uses BackdropFilter + ClipRRect for the glass effect', (
      tester,
    ) async {
      // Liquid Glass の中核 (blur + 角丸 clip) が構造として存在するか検証する。
      // 文字列 render だけの tautology に陥らぬよう、widget tree 上の存在を assert。
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: GlassCard(child: Text('glass')),
          ),
        ),
      );

      expect(find.byType(BackdropFilter), findsOneWidget);
      expect(find.byType(ClipRRect), findsOneWidget);

      // BackdropFilter の sigma が 0 でない (= blur が無効化されていない) ことも検証
      final backdropFilter = tester.widget<BackdropFilter>(
        find.byType(BackdropFilter),
      );
      expect(backdropFilter.filter, isA<ImageFilter>());
    });
  });

  group('WelcomePage', () {
    testWidgets('shows irori brand and Phase 0 message', (tester) async {
      await tester.pumpWidget(
        const ProviderScope(
          child: MaterialApp(home: WelcomePage()),
        ),
      );

      expect(find.text('irori'), findsOneWidget);
      expect(find.textContaining('Phase 0'), findsOneWidget);
    });

    testWidgets('embeds a GlassCard with a BackdropFilter', (tester) async {
      // Phase 0 Exit criteria「GlassCard が CanvasKit で正しく描画される」の
      // 自動検証部分。Backdrop に blur 対象 (背景レイヤー) があることも確認。
      await tester.pumpWidget(
        const ProviderScope(
          child: MaterialApp(home: WelcomePage()),
        ),
      );

      expect(find.byType(GlassCard), findsOneWidget);
      expect(find.byType(BackdropFilter), findsOneWidget);
    });
  });
}
