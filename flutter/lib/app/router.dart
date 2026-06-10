import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/supabase/auth_notifier.dart';
import '../features/auth/presentation/auth_callback_page.dart';
import '../features/auth/presentation/invite_page.dart';
import '../features/auth/presentation/login_page.dart';
import '../features/baby/presentation/baby_dashboard_page.dart';
import '../features/meals/presentation/meals_page.dart';
import '../features/shopping/presentation/shopping_page.dart';
import '../features/stock/presentation/stock_page.dart';
import '../features/welcome/welcome_page.dart';
import 'app_shell.dart';

/// Web origin (Magic Link callback URL 組み立て用)。
///
/// 本番 Web では `Uri.base.origin` (例: `https://irori-flutter.vercel.app`)。
/// flutter-test VM では `Uri.base` が `file:` scheme になり `Uri.origin` が
/// `StateError` を投げるため、**テストでは必ず override する**
/// (例: `originProvider.overrideWithValue('https://test.example')`)。
final originProvider = Provider<String>((ref) {
  final base = Uri.base;
  // 本番 Web は http(s) で origin が取れる。flutter-test VM は `file:` scheme で
  // `Uri.origin` が StateError を投げるため空文字を fallback とする
  // (テストでは originProvider を override して固定 origin を使う想定)。
  if (base.isScheme('http') || base.isScheme('https')) {
    return base.origin;
  }
  return '';
});

/// Magic Link callback URL を組み立てる。
///
/// `returnTo` (認証後の戻り先) を `?returnTo=` クエリに埋めて伝播させる。これを
/// 怠ると invite-after-login (招待リンク → 未認証 → login → 認証 → 招待ページへ
/// 戻る) のチェーンが切れる。`returnTo` は受け手 (AuthCallbackPage) 側で
/// `sanitizeReturnTo` により Open Redirect 防御される。
@visibleForTesting
String buildEmailRedirectTo({required String origin, String? returnTo}) {
  final base = '$origin/auth/callback';
  if (returnTo == null || returnTo.isEmpty) return base;
  return '$base?returnTo=${Uri.encodeQueryComponent(returnTo)}';
}

/// `GoRouter` 設定 provider。
///
/// 設計意図 (設計書 Section 7.1.5 / Issue #47):
/// `GoRouter` は **Provider create 内で 1 度だけ構築**し、auth state 変化は
/// `refreshListenable: authNotifier` 経由で redirect 再評価だけ起こす。
/// `ref.watch(authStateChangeProvider)` を Provider 内で呼ぶ anti-pattern を
/// 取らないことで NavigatorState を破棄せずに保つ。
///
/// redirect 内では `authNotifier.user` を直接読むこと。`currentUserProvider`
/// 経由にすると AuthNotifier listener との発火順序差で stale になりうる。
///
/// 認証ガード (Issue #55 で 5 route に配線 / F2 でシェル化後も契約不変):
/// - public: `/` (welcome) / `/login` / `/auth/callback`
/// - `/invite/:token` は認証必須。未認証なら `?returnTo=<元 URL>` 付きで `/login` へ
/// - 他の保護 page (`/meals` / `/baby` 等) も未認証なら `/login` へ
/// - 認証済みで `/login` にいるなら `/baby` へ
///
/// シェル構成 (F2 / F4): `/meals` / `/shopping` / `/baby` は
/// `StatefulShellRoute.indexedStack` のブランチに置き、`AppShell` (BottomNav)
/// で包む。redirect は `state.matchedLocation` ベースのため、シェル化しても
/// パスは変わらず上記ガードはそのまま効く (`/meals` / `/shopping` も
/// `isPublic` に該当しない)。
final appRouterProvider = Provider<GoRouter>((ref) {
  final authNotifier = ref.read(authNotifierProvider);
  // origin は build 時に 1 度だけ解決 (test では originProvider を override)。
  final origin = ref.read(originProvider);

  return GoRouter(
    initialLocation: '/',
    refreshListenable: authNotifier,
    redirect: (context, state) {
      final loggedIn = authNotifier.isAuthenticated;
      final loc = state.matchedLocation;
      final isPublic = loc == '/' || loc == '/login' || loc == '/auth/callback';

      // 招待リンクは認証必須。未認証なら returnTo に元 URL を載せて login へ。
      // (login → Magic Link → callback で returnTo に戻り、認証済みで再訪する)
      if (!loggedIn && loc.startsWith('/invite/')) {
        final full = state.uri.toString();
        return '/login?returnTo=${Uri.encodeQueryComponent(full)}';
      }
      if (!loggedIn && !isPublic) {
        return '/login';
      }
      if (loggedIn && loc == '/login') {
        return '/baby';
      }
      return null;
    },
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => const WelcomePage(),
      ),
      GoRoute(
        path: '/login',
        builder: (context, state) {
          final returnTo = state.uri.queryParameters['returnTo'];
          return LoginPage(
            emailRedirectTo: buildEmailRedirectTo(
              origin: origin,
              returnTo: returnTo,
            ),
          );
        },
      ),
      GoRoute(
        path: '/auth/callback',
        builder: (context, state) {
          // NOTE: 認証成功後 AuthCallbackPage は context.go(returnTo) する。
          // onAuthStateChange が authNotifier に伝播する前に go が走ると、
          // refreshListenable 発火で /baby→/login→/baby と一瞬 bounce しうるが
          // 自己収束する (実 session が要るため deploy 後検証 / 恒久対応は #54 圏)。
          return AuthCallbackPage(
            code: state.uri.queryParameters['code'],
            returnTo: state.uri.queryParameters['returnTo'],
          );
        },
      ),
      GoRoute(
        path: '/invite/:token',
        builder: (context, state) {
          final token = state.pathParameters['token']!;
          // 未認証は上の redirect が /login へ弾くため、ここでは認証済み。
          final userId = authNotifier.user!.id;
          return InvitePage(token: token, userId: userId);
        },
      ),
      // 認証後のメイン画面群。IndexedStack でブランチごとの Navigator /
      // スクロール位置を保持し、AppShell が BottomNav を提供する。
      // ブランチ順は web bottom-nav.tsx のタブ順 (献立 → 買い物 → 在庫 → 育児)。
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) =>
            AppShell(shell: navigationShell),
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/meals',
                builder: (context, state) => const MealsPage(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/shopping',
                builder: (context, state) => const ShoppingPage(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/stock',
                builder: (context, state) => const StockPage(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/baby',
                builder: (context, state) => const BabyDashboardPage(),
              ),
            ],
          ),
        ],
      ),
    ],
  );
});
