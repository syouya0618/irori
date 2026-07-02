import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/supabase/auth_notifier.dart';
import '../core/utils/app_origin.dart';
import '../features/auth/data/approval_provider.dart';
import '../features/auth/presentation/auth_callback_page.dart';
import '../features/auth/presentation/invite_page.dart';
import '../features/auth/presentation/login_page.dart';
import '../features/auth/presentation/pending_approval_page.dart';
import '../features/baby/presentation/baby_dashboard_page.dart';
import '../features/meals/presentation/meals_page.dart';
import '../features/settings/data/settings_provider.dart';
import '../features/settings/data/settings_repository.dart';
import '../features/settings/presentation/settings_page.dart';
import '../features/shopping/presentation/shopping_page.dart';
import '../features/stock/presentation/stock_page.dart';
import '../features/welcome/welcome_page.dart';
import 'app_shell.dart';

// originProvider は issue #76 (InviteCard) で core/utils/app_origin.dart へ
// 移動した (feature 層からの参照で feature→app の循環 import を避けるため)。
// 既存参照 (router_wiring_test 等) の互換のためここから再 export する。
export '../core/utils/app_origin.dart' show originProvider;

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

/// 認証済みユーザーが `/login` に居る時の landing 先を解決する (P2.5-H)。
///
/// `profiles.default_page` の **best-effort 適用** (設計裁定):
/// - GoRouter の redirect は同期評価のため、ここで profiles を非同期取得する
///   とチラつき/デッドロックの恐れがある。よって [DefaultPageCache] の
///   **同期キャッシュのみ** を読み、未取得 (null) は従来どおり `/baby`。
/// - キャッシュ値は whitelist ([kValidDefaultPages]) で再検証する。DB 値の
///   汚染や将来の page 追加で任意 path へ redirect しないための防御。
/// - cold start での完全適用 (splash で profiles fetch を待つ) はスコープ外。
@visibleForTesting
String resolveLoginLandingPath(String? cachedDefaultPage) {
  if (cachedDefaultPage != null &&
      kValidDefaultPages.contains(cachedDefaultPage)) {
    return '/$cachedDefaultPage';
  }
  return '/baby';
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
/// 承認ゲート (Issue #74 / web `src/proxy.ts:57-93` の移植):
/// 認証済みでも `profiles.is_approved` が確認できるまで保護ルートへ通さない
/// **fail-closed** 設計。redirect は同期評価のため DB は引かず、
/// `ApprovalCache` (userId キー付き同期キャッシュ) を参照する — 未取得 (null)
/// は「未承認」扱いで `/pending-approval` へ誘導し、同ページの
/// `approvalStatusProvider` fetch が確認を担う。web の毎リクエスト検証との
/// 差分 (承認取り消しの検知遅延等) は `ApprovalCache` の doc 参照。
///
/// シェル構成 (F2 / F4 / F6 / P2.5-H): `/meals` / `/shopping` / `/stock` /
/// `/baby` / `/settings` は `StatefulShellRoute.indexedStack` のブランチに
/// 置き、`AppShell` (BottomNav) で包む。redirect は `state.matchedLocation`
/// ベースのため、シェル化してもパスは変わらず上記ガードはそのまま効く
/// (シェル内パスはいずれも `isPublic` に該当しない)。
///
/// 認証済み `/login` の landing は P2.5-H で `/baby` 固定から
/// `resolveLoginLandingPath` (default_page キャッシュの best-effort 適用) へ
/// 変更。未取得時の挙動は従来どおり `/baby`。
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
        // /pending-approval も未認証なら /login へ (web parity: public 扱いしない)。
        return '/login';
      }
      if (!loggedIn) {
        return null;
      }

      // ── 承認ゲート (Issue #74 / web src/proxy.ts:57-93) ──
      // fail-closed: キャッシュ未取得 (null) も「未承認」として扱い、確認が
      // 取れるまで保護ルートへ通さない (ApprovalCache の doc 参照)。
      final isPendingRoute = loc == '/pending-approval';
      final isApproved =
          ref
              .read(approvalCacheProvider)
              .isApprovedFor(authNotifier.user!.id) ??
          false;

      if (!isApproved) {
        // web は /pending-approval・/invite/* 以外すべて誘導する (invite は
        // accept_invitation が is_approved=true を設定する承認導線のため除外)。
        // Flutter 固有の追加除外は 2 つ:
        // - '/' — 公開 welcome ページ (web に相当 route なし。個人データなし)
        // - '/auth/callback' — exchangeCodeForSession 進行中のページ。ここで
        //   弾くと returnTo チェーンが切れる。callback 後の遷移先で本ゲートが
        //   再評価されるため fail-closed は保たれる。
        final isExempt =
            isPendingRoute ||
            loc.startsWith('/invite/') ||
            loc == '/' ||
            loc == '/auth/callback';
        if (!isExempt) {
          // 元の目的地を from に載せる (cold start では承認済みユーザーも一度
          // /pending-approval で確認を経由するため、確認後に戻れるように)。
          return '/pending-approval'
              '?from=${Uri.encodeQueryComponent(state.uri.toString())}';
        }
        return null;
      }

      // 承認済み: /login・/pending-approval に居るなら landing へ
      // (web proxy.ts:84-92 の「approved は public/pending → /」に対応)。
      if (loc == '/login' || isPendingRoute) {
        // default_page の best-effort 適用 (P2.5-H)。同期キャッシュのみ参照
        // (resolveLoginLandingPath の doc 参照)。redirect は同期評価のため
        // ref.read で即値を取る (watch にすると GoRouter 再構築の恐れ)。
        return resolveLoginLandingPath(
          ref.read(defaultPageCacheProvider).value,
        );
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
        path: '/pending-approval',
        builder: (context, state) {
          // 承認ゲートが誘導時に載せた元の目的地 (承認確認後の戻り先)。
          return PendingApprovalPage(
            from: state.uri.queryParameters['from'],
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
      // ブランチ順は web bottom-nav.tsx のタブ順
      // (献立 → 買い物 → 在庫 → 育児 → 設定)。
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
          // 設定タブ (P2.5-H)。AppShell.kSettingsBranchIndex (= 4) と
          // 対応する — ブランチ順を変える時は両方を更新すること。
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/settings',
                builder: (context, state) => const SettingsPage(),
              ),
            ],
          ),
        ],
      ),
    ],
  );
});
