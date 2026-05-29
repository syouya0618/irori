import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/auth/presentation/login_page.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../support/fake_supabase.dart';

Widget _wrap(FakeSupabaseClient client) {
  return ProviderScope(
    overrides: [supabaseClientProvider.overrideWithValue(client)],
    child: const MaterialApp(home: LoginPage(emailRedirectTo: 'https://x/cb')),
  );
}

void main() {
  group('LoginPage', () {
    testWidgets('email 入力 + 送信ボタンを表示する', (tester) async {
      await tester.pumpWidget(_wrap(FakeSupabaseClient()));

      expect(find.widgetWithText(TextFormField, 'メールアドレス'), findsOneWidget);
      expect(find.byType(FilledButton), findsOneWidget);
    });

    testWidgets('空 email で送信すると validator が出て signInWithOtp は呼ばれない', (
      tester,
    ) async {
      final auth = FakeGoTrueClient();
      await tester.pumpWidget(_wrap(FakeSupabaseClient(auth: auth)));

      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      expect(find.textContaining('メールアドレスを入力'), findsOneWidget);
      expect(auth.signInCallCount, 0);
    });

    testWidgets('不正な email で validator が出る', (tester) async {
      final auth = FakeGoTrueClient();
      await tester.pumpWidget(_wrap(FakeSupabaseClient(auth: auth)));

      await tester.enterText(find.byType(TextFormField), 'not-an-email');
      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      expect(auth.signInCallCount, 0);
    });

    testWidgets('正しい email で signInWithOtp が呼ばれ送信済みビューに切替わる', (tester) async {
      final auth = FakeGoTrueClient();
      await tester.pumpWidget(_wrap(FakeSupabaseClient(auth: auth)));

      await tester.enterText(find.byType(TextFormField), 'taro@example.com');
      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      expect(auth.signInCallCount, 1);
      expect(auth.lastEmail, 'taro@example.com');
      expect(auth.lastEmailRedirectTo, 'https://x/cb');
      // 送信済みビュー
      expect(find.text('メールを送信しました'), findsOneWidget);
      // 入力 form は消える
      expect(find.byType(TextFormField), findsNothing);
    });

    testWidgets('送信失敗時はエラー表示し form のまま留まる', (tester) async {
      final auth = FakeGoTrueClient(
        signInError: const AuthException('rate limited', statusCode: '429'),
      );
      await tester.pumpWidget(_wrap(FakeSupabaseClient(auth: auth)));

      await tester.enterText(find.byType(TextFormField), 'taro@example.com');
      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      expect(auth.signInCallCount, 1);
      // form に留まる (送信済みビューに行かない)
      expect(find.byType(TextFormField), findsOneWidget);
      expect(find.textContaining('失敗'), findsOneWidget);
    });

    testWidgets('送信済みビューから「別のメールアドレス」で form に戻れる', (tester) async {
      final auth = FakeGoTrueClient();
      await tester.pumpWidget(_wrap(FakeSupabaseClient(auth: auth)));

      await tester.enterText(find.byType(TextFormField), 'taro@example.com');
      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();

      await tester.tap(find.textContaining('別のメールアドレス'));
      await tester.pumpAndSettle();

      expect(find.byType(TextFormField), findsOneWidget);
    });

    testWidgets('送信済みビューの「再送する」で signInWithOtp を再度呼ぶ', (tester) async {
      final auth = FakeGoTrueClient();
      await tester.pumpWidget(_wrap(FakeSupabaseClient(auth: auth)));

      await tester.enterText(find.byType(TextFormField), 'taro@example.com');
      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();
      expect(auth.signInCallCount, 1);

      await tester.tap(find.textContaining('再送'));
      await tester.pumpAndSettle();

      // 同じアドレスに再送される (再入力不要)。
      expect(auth.signInCallCount, 2);
      expect(auth.lastEmail, 'taro@example.com');
      // 送信済みビューのまま。
      expect(find.text('メールを送信しました'), findsOneWidget);
    });

    testWidgets('送信済みビューで system back すると form に戻る (PopScope)', (tester) async {
      final auth = FakeGoTrueClient();
      await tester.pumpWidget(_wrap(FakeSupabaseClient(auth: auth)));

      await tester.enterText(find.byType(TextFormField), 'taro@example.com');
      await tester.tap(find.byType(FilledButton));
      await tester.pumpAndSettle();
      expect(find.byType(TextFormField), findsNothing);

      // system back を発火 (PopScope.canPop=false ＋ onPopInvoked で form 復帰)。
      final didPop = await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      // ページからは抜けない (pop は handled されず canPop=false)。
      expect(didPop, isTrue);
      // form に戻る。
      expect(find.byType(TextFormField), findsOneWidget);
    });
  });
}
