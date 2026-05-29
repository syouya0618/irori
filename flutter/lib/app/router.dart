import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/supabase/auth_notifier.dart';
import '../features/welcome/welcome_page.dart';

/// `GoRouter` 設定 provider。
///
/// 設計意図 (設計書 Section 7.1.5 / Issue #47):
/// `GoRouter` は **Provider create 内で 1 度だけ構築**し、auth state 変化は
/// `refreshListenable: authNotifier` 経由で redirect 再評価だけ起こす。
/// `ref.watch(authStateChangeProvider)` を Provider 内で呼ぶ anti-pattern を
/// 取らないことで NavigatorState を破棄せずに保つ。
///
/// redirect 内では `authNotifier.user` を直接読むこと。
/// `currentUserProvider` 経由にすると、AuthNotifier listener と
/// currentUserProvider listener の発火順序差で redirect 評価時に値が
/// stale になりうる (go_router 公式 redirection.dart と同じ pattern を採用)。
///
/// 認証ガード方針:
/// - 未認証で `/baby` 等の保護ページにアクセス → `/login` へ
/// - 認証済みで `/login` にいる → `/baby` へ
/// - `/` (WelcomePage) は Phase 0 既存。Phase 2 cutover 時に廃止予定。
///
/// `/login` と `/baby` の本実装は Issue #48 以降。本 PR ではガード動作の
/// 検証用 placeholder Scaffold を置く (redirect 先が 404 にならないように)。
final appRouterProvider = Provider<GoRouter>((ref) {
  final authNotifier = ref.read(authNotifierProvider);

  return GoRouter(
    initialLocation: '/',
    refreshListenable: authNotifier,
    redirect: (context, state) {
      // notifier 自体が user を保持するため subscription race なく即時参照可能。
      final loggedIn = authNotifier.isAuthenticated;
      final location = state.matchedLocation;
      final isLoginPage = location == '/login';
      final isPublicPage = location == '/';

      if (!loggedIn && !isLoginPage && !isPublicPage) {
        return '/login';
      }
      if (loggedIn && isLoginPage) {
        return '/baby';
      }
      return null;
    },
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => const WelcomePage(),
      ),
      // Issue #48 で Magic Link 入力 UI に差し替え予定。
      GoRoute(
        path: '/login',
        builder: (context, state) => const _PlaceholderPage(
          title: 'Login',
          message: 'Login page (Issue #48 で実装予定)',
        ),
      ),
      // Issue #49 以降で baby dashboard に差し替え予定。
      GoRoute(
        path: '/baby',
        builder: (context, state) => const _PlaceholderPage(
          title: 'Baby',
          message: 'Baby dashboard (後続 Issue で実装予定)',
        ),
      ),
    ],
  );
});

/// Issue #48 以降に置き換えられる placeholder。
/// `/login` `/baby` route が存在しないと redirect 先が 404 になるため
/// 最低限の Scaffold を置く。
class _PlaceholderPage extends StatelessWidget {
  const _PlaceholderPage({required this.title, required this.message});

  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: Center(child: Text(message)),
    );
  }
}
