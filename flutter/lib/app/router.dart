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
