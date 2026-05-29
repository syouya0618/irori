import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/auth/presentation/auth_callback_page.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

/// AuthCallbackPage は無限ループする `CircularProgressIndicator` を持つため
/// `pumpAndSettle()` は settle せず timeout する。post-frame callback +
/// 非同期 exchange (canned future) を流すのに十分な固定回数だけ pump する。
Future<void> _settle(WidgetTester tester) async {
  await tester.pump(); // post-frame callback 発火
  await tester.pump(const Duration(milliseconds: 50)); // exchange await 解決
  await tester.pump(const Duration(milliseconds: 50)); // _complete 反映
}

void main() {
  group('AuthCallbackPage', () {
    Widget wrap(
      FakeSupabaseClient client, {
      String? code,
      String? returnTo,
      required void Function(String destination) onComplete,
    }) {
      return ProviderScope(
        overrides: [supabaseClientProvider.overrideWithValue(client)],
        child: MaterialApp(
          home: AuthCallbackPage(
            code: code,
            returnTo: returnTo,
            onComplete: onComplete,
          ),
        ),
      );
    }

    testWidgets('処理中は CircularProgressIndicator を表示する', (tester) async {
      final auth = FakeGoTrueClient();
      await tester.pumpWidget(
        wrap(
          FakeSupabaseClient(auth: auth),
          code: 'abc',
          onComplete: (_) {},
        ),
      );
      // pump 前 (exchange await 中) は indicator が出ている
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await _settle(tester);
    });

    testWidgets('code 成功 → sanitize 済み returnTo へ onComplete', (tester) async {
      final auth = FakeGoTrueClient();
      String? dest;
      await tester.pumpWidget(
        wrap(
          FakeSupabaseClient(auth: auth),
          code: 'the-code',
          returnTo: '/invite/xyz',
          onComplete: (d) => dest = d,
        ),
      );
      await _settle(tester);

      expect(auth.exchangeCallCount, 1);
      expect(auth.lastAuthCode, 'the-code');
      expect(dest, '/invite/xyz');
    });

    testWidgets('returnTo が open redirect なら安全 default /baby へ', (
      tester,
    ) async {
      final auth = FakeGoTrueClient();
      String? dest;
      await tester.pumpWidget(
        wrap(
          FakeSupabaseClient(auth: auth),
          code: 'the-code',
          returnTo: '//evil.com',
          onComplete: (d) => dest = d,
        ),
      );
      await _settle(tester);
      expect(dest, '/baby');
    });

    testWidgets('returnTo 無し → /baby へ', (tester) async {
      final auth = FakeGoTrueClient();
      String? dest;
      await tester.pumpWidget(
        wrap(
          FakeSupabaseClient(auth: auth),
          code: 'the-code',
          onComplete: (d) => dest = d,
        ),
      );
      await _settle(tester);
      expect(dest, '/baby');
    });

    testWidgets('exchange 失敗 → /login?error=auth へ', (tester) async {
      final auth = FakeGoTrueClient(
        exchangeError: const AuthException('bad code', statusCode: '400'),
      );
      String? dest;
      await tester.pumpWidget(
        wrap(
          FakeSupabaseClient(auth: auth),
          code: 'bad',
          onComplete: (d) => dest = d,
        ),
      );
      await _settle(tester);
      expect(dest, '/login?error=auth');
    });

    testWidgets('code が null → exchange せず /login?error=auth へ', (
      tester,
    ) async {
      final auth = FakeGoTrueClient();
      String? dest;
      await tester.pumpWidget(
        wrap(
          FakeSupabaseClient(auth: auth),
          code: null,
          onComplete: (d) => dest = d,
        ),
      );
      await _settle(tester);
      expect(auth.exchangeCallCount, 0);
      expect(dest, '/login?error=auth');
    });
  });
}
