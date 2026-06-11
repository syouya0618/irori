import 'dart:async';

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
import 'package:irori/features/settings/data/settings_provider.dart';
import 'package:irori/features/settings/data/settings_repository.dart';
import 'package:irori/features/settings/presentation/settings_page.dart';
import 'package:irori/features/shopping/data/household_members_provider.dart';
import 'package:irori/features/shopping/data/shopping_items_notifier.dart';
import 'package:irori/features/shopping/data/shopping_repository.dart';
import 'package:irori/features/shopping/domain/shopping_item.dart';
import 'package:irori/features/shopping/presentation/shopping_page.dart';
import 'package:irori/features/stock/data/stock_items_notifier.dart';
import 'package:irori/features/stock/domain/stock_item.dart';
import 'package:irori/features/stock/presentation/stock_page.dart';
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

    testWidgets('認証済みで /shopping に到達できる (F4 追加ケース)', (tester) async {
      final container = _authedShellContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );

      container.read(appRouterProvider).go('/shopping');
      await tester.pump();
      await tester.pumpAndSettle();

      expect(find.byType(ShoppingPage), findsOneWidget);
      expect(find.byType(NavigationBar), findsOneWidget);
      // AppShell は AppBar を持たないため、ページ自前の 1 つだけ。
      expect(find.byType(AppBar), findsOneWidget);
      expect(find.text('買い物リスト'), findsOneWidget);
    });

    testWidgets('BottomNav の「買い物」タップで /shopping ブランチへ切り替わる (F4 追加ケース)', (
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

      // 「買い物」タブへ (web タブ順: 献立 → 買い物 → 育児)。
      await tester.tap(find.text('買い物'));
      await tester.pumpAndSettle();
      expect(find.byType(ShoppingPage), findsOneWidget);
      expect(find.byType(MealsPage), findsNothing);

      // 「育児」タブへ → ShoppingPage は Offstage になり finder から消える。
      await tester.tap(find.text('育児'));
      await tester.pumpAndSettle();
      expect(find.byType(BabyDashboardPage), findsOneWidget);
      expect(find.byType(ShoppingPage), findsNothing);
    });

    testWidgets('未認証で /shopping にアクセスすると /login へ redirect される (F4 追加ケース)', (
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

      container.read(appRouterProvider).go('/shopping');
      await tester.pump();
      await tester.pump();

      expect(find.byType(LoginPage), findsOneWidget);
      expect(find.byType(ShoppingPage), findsNothing);
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

    testWidgets('認証済みで /stock に到達できる (F6 追加ケース)', (tester) async {
      final container = _authedShellContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );

      container.read(appRouterProvider).go('/stock');
      await tester.pump();
      await tester.pumpAndSettle();

      expect(find.byType(StockPage), findsOneWidget);
      expect(find.byType(NavigationBar), findsOneWidget);
      // AppBar は StockPage 自前の 1 つだけ (シェルは持たない)。
      expect(find.byType(AppBar), findsOneWidget);
    });

    testWidgets('BottomNav の在庫タブで /meals → /stock → /baby を切り替える (F6 追加ケース)', (
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

      // 「在庫」タブへ (タブ順は web: 献立 → 在庫 → 育児)。
      await tester.tap(find.text('在庫'));
      await tester.pumpAndSettle();
      expect(find.byType(StockPage), findsOneWidget);
      expect(find.byType(MealsPage), findsNothing);

      // 「育児」タブへ → 在庫ブランチは Offstage になる。
      await tester.tap(find.text('育児'));
      await tester.pumpAndSettle();
      expect(find.byType(BabyDashboardPage), findsOneWidget);
      expect(find.byType(StockPage), findsNothing);

      // 「在庫」タブへ戻れる。
      await tester.tap(find.text('在庫'));
      await tester.pumpAndSettle();
      expect(find.byType(StockPage), findsOneWidget);
      expect(find.byType(BabyDashboardPage), findsNothing);
    });

    testWidgets('未認証で /stock にアクセスすると /login へ redirect される (F6 追加ケース)', (
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

      container.read(appRouterProvider).go('/stock');
      await tester.pump();
      await tester.pump();

      expect(find.byType(LoginPage), findsOneWidget);
      expect(find.byType(StockPage), findsNothing);
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

    testWidgets('認証済みで /settings に到達できる (P2.5-H 追加ケース)', (tester) async {
      final container = _authedShellContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const _RouterHarness(),
        ),
      );

      container.read(appRouterProvider).go('/settings');
      await tester.pump();
      await tester.pumpAndSettle();

      expect(find.byType(SettingsPage), findsOneWidget);
      expect(find.byType(NavigationBar), findsOneWidget);
      // AppBar は SettingsPage 自前の 1 つだけ (シェルは持たない)。
      expect(find.byType(AppBar), findsOneWidget);
    });

    testWidgets(
      '未認証で /settings にアクセスすると /login へ redirect される (P2.5-H 追加ケース)',
      (
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

        container.read(appRouterProvider).go('/settings');
        await tester.pump();
        await tester.pump();

        expect(find.byType(LoginPage), findsOneWidget);
        expect(find.byType(SettingsPage), findsNothing);
      },
    );

    testWidgets(
      'BottomNav の「設定」タップで /settings ブランチへ切り替わり、表示ごとに refetch する '
      '(P2.5-H 追加ケース)',
      (tester) async {
        // profiles / households は Realtime 非対象のため、タブ表示ごとに
        // AppShell が settingsProvider を invalidate して refetch する設計を
        // fetch 回数で固定する。
        var fetchCount = 0;
        final container = _authedShellContainer(
          settingsFetch: (ref) async {
            fetchCount++;
            return _settingsData();
          },
        );
        addTearDown(container.dispose);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const _RouterHarness(),
          ),
        );

        // 設定ページ内にも「献立」「設定」等のテキストが存在するため、
        // タブ操作は NavigationBar 配下に絞って一意にする。
        Finder navLabel(String label) => find.descendant(
          of: find.byType(NavigationBar),
          matching: find.text(label),
        );

        container.read(appRouterProvider).go('/meals');
        await tester.pump();
        await tester.pumpAndSettle();
        expect(find.byType(MealsPage), findsOneWidget);

        // 「設定」タブへ (web タブ順 5 番目)。初回表示で fetch #1。
        await tester.tap(navLabel('設定'));
        await tester.pumpAndSettle();
        expect(find.byType(SettingsPage), findsOneWidget);
        expect(find.byType(MealsPage), findsNothing);
        expect(fetchCount, 1);

        // 他タブへ離れて戻ると invalidate → fetch #2 (タブ表示ごと refetch)。
        await tester.tap(navLabel('献立'));
        await tester.pumpAndSettle();
        expect(find.byType(MealsPage), findsOneWidget);

        await tester.tap(navLabel('設定'));
        await tester.pumpAndSettle();
        expect(find.byType(SettingsPage), findsOneWidget);
        expect(fetchCount, 2);
      },
    );

    testWidgets(
      '認証済み /login は default_page キャッシュがあればその branch へ redirect される '
      '(P2.5-H best-effort 適用)',
      (tester) async {
        final container = _authedShellContainer();
        addTearDown(container.dispose);
        // 設定 fetch / 起動タブ更新成功で温まる同期キャッシュを模す。
        container.read(defaultPageCacheProvider).value = 'stock';

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const _RouterHarness(),
          ),
        );

        container.read(appRouterProvider).go('/login');
        await tester.pump();
        await tester.pumpAndSettle();

        expect(find.byType(StockPage), findsOneWidget);
        expect(find.byType(LoginPage), findsNothing);
      },
    );

    testWidgets(
      'default_page キャッシュが whitelist 外なら /baby へ fallback する (P2.5-H)',
      (tester) async {
        final container = _authedShellContainer();
        addTearDown(container.dispose);
        // DB 値の汚染や将来の page 追加に備え、redirect 側でも whitelist する。
        container.read(defaultPageCacheProvider).value = 'settings';

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
      },
    );
  });

  group('resolveLoginLandingPath (P2.5-H)', () {
    test('whitelist 内のキャッシュ値は /<page> を返す', () {
      expect(resolveLoginLandingPath('meals'), '/meals');
      expect(resolveLoginLandingPath('shopping'), '/shopping');
      expect(resolveLoginLandingPath('stock'), '/stock');
      expect(resolveLoginLandingPath('baby'), '/baby');
    });

    test('未取得 (null) は /baby へ fallback する', () {
      expect(resolveLoginLandingPath(null), '/baby');
    });

    test('whitelist 外は /baby へ fallback する (任意 path への redirect を防ぐ)', () {
      expect(resolveLoginLandingPath('settings'), '/baby');
      expect(resolveLoginLandingPath(''), '/baby');
      expect(resolveLoginLandingPath('../evil'), '/baby');
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

/// 空の買い物リストを返す AsyncNotifier (シェル配線テスト用 — F4 追加)。
class _EmptyShoppingItemsNotifier extends ShoppingItemsNotifier {
  @override
  Future<List<ShoppingItem>> build() async => const [];
}

/// 空の在庫一覧を返す AsyncNotifier (シェル配線テスト用)。
class _EmptyStockNotifier extends StockItemsNotifier {
  @override
  Future<List<StockItem>> build() async => const [];
}

/// 設定ブランチ用の canned バンドル (P2.5-H — 配線テストの焦点は到達性のみ)。
SettingsData _settingsData() => (
  settings: const HouseholdSettings(
    displayName: '太郎',
    role: 'owner',
    defaultPage: 'meals',
    householdId: 'hh-1',
    householdName: 'いろり家',
    autoStockCategories: ['baby', 'cleaning', 'hygiene'],
    babyName: null,
    babyBirthDate: null,
  ),
  email: 'taro@example.com',
);

/// 認証済み (initialUser 固定) の ProviderContainer。
///
/// シェル内ブランチ (`MealsPage` / `BabyDashboardPage`) が build 時に
/// 実 Supabase へ触れないよう、各データ provider も fake に差し替える
/// (焦点は「router 配線でページに到達できるか」のみ)。
///
/// [settingsFetch] は設定タブの refetch 回数検証用の差し替え口
/// (P2.5-H 追加 — 既存呼び出しは引数なしで挙動不変)。
ProviderContainer _authedShellContainer({
  FutureOr<SettingsData> Function(Ref ref)? settingsFetch,
}) {
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
      // shopping ブランチのデータ層 fake (F4 追加 — 既存 override は不変)。
      shoppingItemsNotifierProvider.overrideWith(
        _EmptyShoppingItemsNotifier.new,
      ),
      householdMembersProvider.overrideWith((ref) async => const []),
      shoppingMutationContextProvider.overrideWith(
        (ref) async => (householdId: 'hh-1', userId: 'user-1'),
      ),
      // stock ブランチのデータ層 fake (F6)。
      stockItemsNotifierProvider.overrideWith(_EmptyStockNotifier.new),
      // settings ブランチのデータ層 fake (P2.5-H 追加 — 既存 override は不変)。
      settingsProvider.overrideWith(
        settingsFetch ?? (ref) async => _settingsData(),
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
