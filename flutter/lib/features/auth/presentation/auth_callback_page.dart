import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import 'return_to.dart';

/// Magic Link クリック後の callback ページ
/// (Issue #48 / 元 `src/app/auth/callback/route.ts`)。
///
/// 処理:
/// 1. `CircularProgressIndicator` を表示しつつ
///    `supabase.auth.exchangeCodeForSession(code)` を実行
/// 2. 成功 → `sanitizeReturnTo(returnTo)` 先へ遷移
/// 3. 失敗 / code 欠落 → `/login?error=auth` へ遷移
///
/// `code` / `returnTo` はコンストラクタ引数で受け取る (GoRouter の
/// `state.uri.queryParameters` から取り出して渡すのは親の router wiring 側の責務。
/// constraint #1 により本 PR では router.dart を編集しない)。
///
/// `onComplete` は遷移先 path を受け取るコールバック。default は `context.go`。
/// テストでは spy を注入し、実 GoRouter 無しで遷移先を検証する。
///
/// E2E (実 Magic Link → PKCE code → session 確立) は実 Supabase + 実ブラウザが
/// 必要なため worktree では検証不能。本 widget test は mock 注入で
/// 「exchange が code 付きで呼ばれ、結果に応じた遷移先が選ばれる」ところまで検証する。
class AuthCallbackPage extends ConsumerStatefulWidget {
  const AuthCallbackPage({
    required this.code,
    this.returnTo,
    this.onComplete,
    super.key,
  });

  /// PKCE auth code (`?code=...`)。null なら認証失敗扱い。
  final String? code;

  /// 認証後の戻り先 (`?returnTo=...`)。Open Redirect は [sanitizeReturnTo] で防御。
  final String? returnTo;

  /// 遷移先 path を受け取るコールバック (テスト注入用)。null なら `context.go`。
  final void Function(String destination)? onComplete;

  @override
  ConsumerState<AuthCallbackPage> createState() => _AuthCallbackPageState();
}

class _AuthCallbackPageState extends ConsumerState<AuthCallbackPage> {
  @override
  void initState() {
    super.initState();
    // build 完了後に副作用を起こす (initState 中の navigation を避ける)。
    WidgetsBinding.instance.addPostFrameCallback((_) => _handleCallback());
  }

  Future<void> _handleCallback() async {
    final code = widget.code;

    if (code == null || code.isEmpty) {
      debugPrint('AuthCallbackPage: code が無いため認証失敗扱い');
      _complete('/login?error=auth');
      return;
    }

    final client = ref.read(supabaseClientProvider);
    try {
      await client.auth
          .exchangeCodeForSession(code)
          .timeout(const Duration(seconds: 10));
      final destination = sanitizeReturnTo(widget.returnTo);
      _complete(destination);
    } on AuthException catch (e) {
      // CLAUDE.md「エラー握り潰し禁止」: plain object を構造化ログ。
      debugPrint(
        'AuthCallbackPage.exchangeCodeForSession AuthException: '
        'message=${e.message}, statusCode=${e.statusCode}, code=${e.code}',
      );
      _complete('/login?error=auth');
    } on Object catch (e, stack) {
      // timeout / ネットワーク等。詳細を握り潰さずログ。
      debugPrint('AuthCallbackPage.exchangeCodeForSession error: $e\n$stack');
      _complete('/login?error=auth');
    }
  }

  void _complete(String destination) {
    if (!mounted) return;
    final onComplete = widget.onComplete;
    if (onComplete != null) {
      onComplete(destination);
    } else {
      context.go(destination);
    }
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 16),
            Text('ログイン処理中...'),
          ],
        ),
      ),
    );
  }
}
