import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../../../core/theme/colors.dart';
import '../../../widgets/glass_card.dart';
import '../../settings/data/settings_provider.dart';
import '../data/approval_provider.dart';
import 'return_to.dart';

/// 承認待ちページ (Issue #74 / 元 `src/app/pending-approval/{page,
/// pending-content,actions}.tsx`)。
///
/// router の承認ゲート (fail-closed) が未承認・承認未確認のユーザーを
/// ここへ誘導する。挙動:
/// 1. mount で [approvalStatusProvider] が `profiles.is_approved` を取得
///    (確認中はスピナーのみ表示 — cold start の承認済みユーザーに
///    「承認待ち」文言を一瞬見せない)
/// 2. 承認済みと判明 → [from] (redirect が載せた元の目的地) へ自動遷移。
///    from 無し / 不正値は `/login` へ trampoline し、認証済み `/login` の
///    既存 redirect (`resolveLoginLandingPath`) が default_page 起点の landing
///    を解決する (web が approved を `/` へ redirect し page.tsx が
///    default_page を解決するのと同じ二段構え)
/// 3. 未承認 → 承認待ちカード (web `pending-content.tsx` の忠実移植:
///    状態再確認ボタン + ログアウト)
///
/// 「承認状態を確認」は provider の invalidate → refetch (web の
/// `router.refresh()` でミドルウェアを再評価させるのと同義)。web の 1.5s
/// 固定タイマーは feedback の無い refresh を補う演出のため移植せず、
/// Flutter は実 fetch の loading 状態をそのまま表示する (意図的差異)。
///
/// ログアウトは web `actions.ts` の `signOut()` 対応。settings の
/// `_SignOutButton` と同じく同期キャッシュ (`DefaultPageCache` /
/// [ApprovalCache]) を破棄してから `auth.signOut()` を呼び、遷移は
/// authNotifier (refreshListenable) → router redirect (未認証 → /login) に任せる。
class PendingApprovalPage extends ConsumerStatefulWidget {
  const PendingApprovalPage({this.from, this.onNavigate, super.key});

  /// 承認ゲートが誘導時に載せた元の目的地 (`?from=...`)。
  /// 承認確認後の戻り先。Open Redirect 系の不正値は [sanitizeReturnTo] で防御。
  final String? from;

  /// 承認確認後の遷移先を受け取るコールバック (テスト注入用)。
  /// null なら `context.go` (AuthCallbackPage の `onComplete` と同じ流儀)。
  final void Function(String destination)? onNavigate;

  @override
  ConsumerState<PendingApprovalPage> createState() =>
      _PendingApprovalPageState();
}

class _PendingApprovalPageState extends ConsumerState<PendingApprovalPage> {
  /// 自動遷移の多重発火ガード (build は provider 更新のたびに走る)。
  bool _forwarded = false;

  bool _signingOut = false;

  void _forward() {
    if (!mounted) return;
    // from 不正値 (絶対 URL / protocol-relative 等) は /login へ倒す。
    // 認証済み + 承認済みの /login は redirect が landing へ解決する。
    final destination = sanitizeReturnTo(widget.from, fallback: '/login');
    final onNavigate = widget.onNavigate;
    if (onNavigate != null) {
      onNavigate(destination);
    } else {
      context.go(destination);
    }
  }

  /// 承認状態の再確認 (web `handleCheck` の `router.refresh()` 相当)。
  void _check() {
    ref.invalidate(approvalStatusProvider);
  }

  Future<void> _signOut() async {
    if (_signingOut) return;

    // ref / messenger は await 後に widget が破棄されると使えないため先に解決する
    // (settings `_SignOutButton` と同じ流儀)。
    final messenger = ScaffoldMessenger.of(context);
    final defaultPageCache = ref.read(defaultPageCacheProvider);
    final approvalCache = ref.read(approvalCacheProvider);
    final auth = ref.read(supabaseClientProvider).auth;
    setState(() => _signingOut = true);

    try {
      // signOut より前に破棄する (後続処理の実行保証がないため)。
      defaultPageCache.value = null;
      approvalCache.clear();
      await auth.signOut().timeout(const Duration(seconds: 10));
      // 画面遷移はしない: authNotifier (refreshListenable) の signedOut 通知で
      // router redirect が /login へ送る。
    } on Object catch (e, st) {
      // 握り潰さない (CLAUDE.md)。
      debugPrint('PendingApprovalPage signOut 失敗: $e\n$st');
      if (!mounted) return;
      messenger.showSnackBar(
        const SnackBar(content: Text('ログアウトに失敗しました')),
      );
    } finally {
      if (mounted) setState(() => _signingOut = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // fetch 失敗は provider が fail-closed で false に変換済み。ここに来る
    // error は未認証 StateError 等の想定外のみ — log して承認待ちカード表示
    // (fail-closed) へ縮退する。遷移は router redirect に任せる。
    ref.listen<AsyncValue<bool>>(approvalStatusProvider, (previous, next) {
      if (next.hasError) {
        debugPrint(
          'PendingApprovalPage approvalStatus error: '
          '${next.error}\n${next.stackTrace}',
        );
      }
    });

    final approvalAsync = ref.watch(approvalStatusProvider);
    // Riverpod 3.x で `valueOrNull` は廃止 → nullable な `value` を使う。
    final approved = approvalAsync.value == true;
    if (approved && !_forwarded) {
      _forwarded = true;
      // build 中の navigation を避ける (AuthCallbackPage と同じ post-frame)。
      WidgetsBinding.instance.addPostFrameCallback((_) => _forward());
    }

    // 初回確認中 (値も error も無い) と承認判明後 (遷移待ち) はスピナーのみ。
    final initialLoading =
        approvalAsync.isLoading &&
        !approvalAsync.hasValue &&
        !approvalAsync.hasError;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: (approved || initialLoading)
              ? const CircularProgressIndicator()
              : SingleChildScrollView(
                  // web: flex min-h-dvh items-center justify-center px-4
                  //      + max-w-sm。
                  padding: const EdgeInsets.all(16),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 384),
                    child: _PendingCard(
                      checking: approvalAsync.isLoading,
                      signingOut: _signingOut,
                      onCheck: _check,
                      onSignOut: _signOut,
                    ),
                  ),
                ),
        ),
      ),
    );
  }
}

/// 承認待ちカード本体 (web `pending-content.tsx:32-83` の忠実移植)。
class _PendingCard extends StatelessWidget {
  const _PendingCard({
    required this.checking,
    required this.signingOut,
    required this.onCheck,
    required this.onSignOut,
  });

  final bool checking;
  final bool signingOut;
  final VoidCallback onCheck;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    return GlassCard(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // web: size-12 rounded-full bg-amber-500/10 + Clock size-6 amber。
          // amber は本プロジェクトの warning トークンへ写す (approval_card と同じ)。
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: IroriColors.warning.withValues(alpha: 0.1),
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: const Icon(
              LucideIcons.clock,
              size: 24,
              color: IroriColors.warning,
            ),
          ),
          const SizedBox(height: 16),
          Text(
            '承認待ち',
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              color: context.colors.textPrimary,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            '管理者の承認をお待ちください。承認されると自動的にアプリをご利用いただけます。',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, color: context.colors.textMuted),
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: (checking || signingOut) ? null : onCheck,
              icon: checking
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(LucideIcons.refreshCw, size: 16),
              label: Text(checking ? '確認中...' : '承認状態を確認'),
              style: FilledButton.styleFrom(
                // 44px タッチターゲット (web: min-h-11)。
                minimumSize: const Size.fromHeight(44),
              ),
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: double.infinity,
            child: TextButton.icon(
              onPressed: signingOut ? null : onSignOut,
              icon: signingOut
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(LucideIcons.logOut, size: 16),
              label: const Text('ログアウト'),
              style: TextButton.styleFrom(
                // web: variant ghost + text-muted-foreground。
                foregroundColor: context.colors.textMuted,
                minimumSize: const Size.fromHeight(44),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
