import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irori/app/router.dart';
import 'package:irori/core/supabase/auth_notifier.dart';
import 'package:irori/core/supabase/supabase_providers.dart';
import 'package:irori/features/auth/presentation/auth_callback_page.dart';
import 'package:irori/features/auth/presentation/login_page.dart';
import 'package:irori/features/baby/data/baby_logs_notifier.dart';
import 'package:irori/features/baby/data/baby_weekly_summary_provider.dart';
import 'package:irori/features/baby/data/last_sleep_provider.dart';
import 'package:irori/features/baby/data/now_ticker_provider.dart';
import 'package:irori/features/baby/domain/baby_log.dart';
import 'package:irori/features/baby/presentation/baby_dashboard_page.dart';
import 'package:irori/features/meals/data/meals_repository.dart';
import 'package:irori/features/meals/data/meals_week_notifier.dart';
import 'package:irori/features/meals/domain/meal.dart';
import 'package:irori/features/meals/presentation/meals_page.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

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

  group('StatefulShellRoute 配線 (F2, 追加ケース)', () {
    testWidgets('認証済みで /meals に到達できる (BottomNav あり / AppBar はページの 1 つ)', (
      tester,
    ) async {
      final container = _authedShellContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );

      container.read(appRouterProvider).go('/meals');
      await tester.pump();
      await tester.pumpAndSettle();

      expect(find.byType(MealsPage), findsOneWidget);
      expect(find.byType(NavigationBar), findsOneWidget);
      // AppShell は AppBar を持たないため、ページ自前の 1 つだけ (二重表示なし)。
      expect(find.byType(AppBar), findsOneWidget);
    });

    testWidgets('BottomNav タップで /meals ⇄ /baby のブランチを切り替える', (tester) async {
      final container = _authedShellContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );

      container.read(appRouterProvider).go('/meals');
      await tester.pump();
      await tester.pumpAndSettle();
      expect(find.byType(MealsPage), findsOneWidget);

      // 「育児」タブへ (非アクティブブランチは Offstage になり finder から消える)。
      await tester.tap(find.text('育児'));
      await tester.pumpAndSettle();
      expect(find.byType(BabyDashboardPage), findsOneWidget);
      expect(find.byType(MealsPage), findsNothing);
      // ブランチ切替後も AppBar はアクティブページの 1 つだけ。
      expect(find.byType(AppBar), findsOneWidget);

      // 「献立」タブへ戻る。
      await tester.tap(find.text('献立'));
      await tester.pumpAndSettle();
      expect(find.byType(MealsPage), findsOneWidget);
      expect(find.byType(BabyDashboardPage), findsNothing);
    });

    testWidgets('未認証で /meals にアクセスすると /login へ redirect される', (tester) async {
      final container = _unauthedContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );

      container.read(appRouterProvider).go('/meals');
      await tester.pump();
      await tester.pump();

      expect(find.byType(LoginPage), findsOneWidget);
      expect(find.byType(MealsPage), findsNothing);
    });

    testWidgets('認証済みの /login は /baby へ redirect される (シェル化後も契約不変)', (
      tester,
    ) async {
      final container = _authedShellContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );

      container.read(appRouterProvider).go('/login');
      await tester.pump();
      await tester.pumpAndSettle();

      expect(find.byType(BabyDashboardPage), findsOneWidget);
      expect(find.byType(LoginPage), findsNothing);
      expect(find.byType(NavigationBar), findsOneWidget);
    });
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

/// 空の献立週を返す AsyncNotifier (シェル配線テスト用)。
class _EmptyWeekNotifier extends MealsWeekNotifier {
  @override
  Future<List<Meal>> build() async => const [];
}

/// 空の育児ログを返す AsyncNotifier (シェル配線テスト用)。
class _EmptyLogsNotifier extends BabyLogsNotifier {
  @override
  Future<List<BabyLog>> build() async => const [];
}

/// 認証済み (initialUser 固定) の ProviderContainer。
///
/// シェル内ブランチ (`MealsPage` / `BabyDashboardPage`) が build 時に
/// 実 Supabase へ触れないよう、各データ provider も fake に差し替える
/// (焦点は「router 配線でページに到達できるか」のみ)。
ProviderContainer _authedShellContainer() {
  return ProviderContainer(
    overrides: [
      originProvider.overrideWithValue('https://test.example'),
      supabaseClientProvider.overrideWithValue(FakeSupabaseClient()),
      authNotifierProvider.overrideWith((ref) {
        final notifier = AuthNotifier(
          initialUser: const User(
            id: 'user-1',
            appMetadata: {},
            userMetadata: {},
            aud: 'authenticated',
            createdAt: '2026-01-01T00:00:00.000Z',
          ),
        );
        ref.onDispose(notifier.dispose);
        return notifier;
      }),
      // meals ブランチのデータ層 fake。
      mealsWeekNotifierProvider.overrideWith(_EmptyWeekNotifier.new),
      mealsMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
      // baby ブランチのデータ層 fake (baby_dashboard_page_test と同じ流儀)。
      babyLogsNotifierProvider.overrideWith(_EmptyLogsNotifier.new),
      nowTickerProvider.overrideWith(
        (ref) => Stream.value(DateTime.utc(2026, 1, 1, 12)),
      ),
      lastSleepEndedAtProvider.overrideWith((ref) async => null),
      babyWeeklySummaryProvider.overrideWith((ref) async => const []),
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
