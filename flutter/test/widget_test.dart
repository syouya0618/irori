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
  });
}
