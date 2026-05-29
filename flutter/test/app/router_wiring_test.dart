import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/app/router.dart';
import 'package:irori/core/supabase/auth_notifier.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/auth/presentation/auth_callback_page.dart';
import 'package:irori/features/auth/presentation/login_page.dart';
import 'package:irori/features/baby/presentation/baby_dashboard_page.dart';

import '../support/fake_supabase.dart';

/// Issue #55: route wiring の統合テスト。
///
/// 狙い (PR review / advisor 指摘): 各 page の widget unit test は
/// `onComplete`/`onAccepted` spy や `emailRedirectTo` を **注入** して検証するため、
/// router.dart の配線が wrong value を渡しても緑のまま通る。ここでは **実 GoRouter
/// を drive** し、「path/query から各 page に正しい値が渡る」配線そのものを検証する。
///
/// flutter-test VM では `Uri.base` が `file:` scheme で `Uri.origin` が throw する
/// ため、`originProvider` を必ず override する。
void main() {
  group('buildEmailRedirectTo (Issue #55)', () {
    test('returnTo なしは callback base のみ', () {
      expect(
        buildEmailRedirectTo(origin: 'https://test.example'),
        'https://test.example/auth/callback',
      );
    });

    test('returnTo を encode して埋め、decode で原値に復元できる', () {
      final url = buildEmailRedirectTo(
        origin: 'https://test.example',
        returnTo: '/invite/abc',
      );
      final uri = Uri.parse(url);
      expect(uri.path, '/auth/callback');
      // 二重 encode/decode (login query → 再 encode) を経ても原値に戻る。
      // ここが切れると invite-after-login が silently 壊れる。
      expect(uri.queryParameters['returnTo'], '/invite/abc');
    });

    test('空 returnTo は callback base のみ', () {
      expect(
        buildEmailRedirectTo(origin: 'https://test.example', returnTo: ''),
        'https://test.example/auth/callback',
      );
    });
  });

  group('appRouterProvider 配線 (Issue #55, 実 GoRouter drive)', () {
    testWidgets('/login?returnTo=X → LoginPage.emailRedirectTo に X が伝播する', (
      tester,
    ) async {
      final container = _unauthedContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );

      container
          .read(appRouterProvider)
          .go('/login?returnTo=${Uri.encodeQueryComponent('/invite/abc')}');
      await tester.pump();
      await tester.pump();

      final loginPage = tester.widget<LoginPage>(find.byType(LoginPage));
      final redirectUri = Uri.parse(loginPage.emailRedirectTo);
      expect(redirectUri.path, '/auth/callback');
      // decode-assert: contains('invite') ではなく原値一致を確認。
      expect(redirectUri.queryParameters['returnTo'], '/invite/abc');
    });

    testWidgets('未認証で /baby にアクセスすると /login へ redirect される', (tester) async {
      final container = _unauthedContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );

      container.read(appRouterProvider).go('/baby');
      await tester.pump();
      await tester.pump();

      expect(find.byType(LoginPage), findsOneWidget);
      expect(find.byType(BabyDashboardPage), findsNothing);
    });

    testWidgets('未認証で /invite/:token は returnTo 付きで /login へ redirect される', (
      tester,
    ) async {
      final container = _unauthedContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );

      container.read(appRouterProvider).go('/invite/tok-xyz');
      await tester.pump();
      await tester.pump();

      // /login に着地し、emailRedirectTo に元の invite URL が returnTo として乗る。
      final loginPage = tester.widget<LoginPage>(find.byType(LoginPage));
      final redirectUri = Uri.parse(loginPage.emailRedirectTo);
      final returnTo = redirectUri.queryParameters['returnTo'];
      expect(returnTo, isNotNull);
      expect(Uri.parse(returnTo!).path, '/invite/tok-xyz');
    });

    testWidgets(
      '/auth/callback?code=X&returnTo=Y → AuthCallbackPage が code/returnTo を受け取る',
      (
        tester,
      ) async {
        // exchange は成功させる (fake)。focus は「配線で code/returnTo が渡る」こと。
        final container = _unauthedContainer(
          client: FakeSupabaseClient(auth: FakeGoTrueClient()),
        );
        addTearDown(container.dispose);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const _RouterHarness(),
          ),
        );

        container
            .read(appRouterProvider)
            .go('/auth/callback?code=xyz&returnTo=/baby');
        await tester.pump();
        await tester.pump(); // GoRouter 遷移完了で AuthCallbackPage が build される

        final callback = tester.widget<AuthCallbackPage>(
          find.byType(AuthCallbackPage),
        );
        expect(callback.code, 'xyz');
        expect(callback.returnTo, '/baby');

        // postFrame の exchange (fake 成功) → context.go → redirect を有限 pump で流す。
        // AuthCallbackPage の CircularProgressIndicator は infinite animation ゆえ
        // pumpAndSettle は使わない (未認証なので最終的に /login へ着地)。
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
      },
    );
  });
}

/// 未認証 (AuthNotifier に stream を渡さない → user=null) の ProviderContainer。
/// originProvider は test 用に固定 origin で override (Uri.base.origin 回避)。
ProviderContainer _unauthedContainer({FakeSupabaseClient? client}) {
  return ProviderContainer(
    overrides: [
      originProvider.overrideWithValue('https://test.example'),
      supabaseClientProvider.overrideWithValue(client ?? FakeSupabaseClient()),
      authNotifierProvider.overrideWith((ref) {
        final notifier = AuthNotifier(); // stream なし = 未認証 (user==null)
        ref.onDispose(notifier.dispose);
        return notifier;
      }),
    ],
  );
}

/// `appRouterProvider` を `MaterialApp.router` に流すテスト用ハーネス。
class _RouterHarness extends ConsumerWidget {
  const _RouterHarness();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);
    return MaterialApp.router(
      routerConfig: router,
      debugShowCheckedModeBanner: false,
    );
  }
}
