import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/welcome/welcome_page.dart';

/// GoRouter 設定 provider。
///
/// Phase 0 では `/` (Welcome) のみ。
/// Phase 1 以降で追加予定:
/// - `/auth/callback` — Magic Link redirect
/// - `/invite/:token` — 世帯招待 token 受け取り
/// - `/baby` — 赤ちゃんログ dashboard
/// - `/meals` — 1 週間献立 view
/// - `/shopping` — 買い物リスト
/// - `/stock` — 在庫管理
///
/// Web URL sync は GoRouter のデフォルトで有効 (browser history 対応)。
///
/// FIXME(phase-1): 本 Provider は現状 ref.watch を使っておらぬから安全だが、
/// Phase 1 で auth state による redirect を加える際、`ref.watch(authStateChangeProvider)`
/// を Provider 内で呼ぶと auth 変化のたびに GoRouter 全体が再構築され
/// NavigatorState が破棄される (Riverpod Discussion #1357 で Remi Rousselet が警告)。
/// 必ず `refreshListenable` パターンに書き換えること。詳細は
/// docs/plans/2026-05-27-flutter-migration-design.md Section 7.1.5 参照。
final appRouterProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => const WelcomePage(),
      ),
    ],
  );
});
