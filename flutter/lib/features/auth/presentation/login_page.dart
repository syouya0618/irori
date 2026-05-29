import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../../core/supabase/supabase_providers.dart';
import '../../../core/theme/colors.dart';
import '../../../core/theme/radii.dart';
import '../../../widgets/glass_card.dart';

/// Magic Link ログイン入力ページ (Issue #48 / 元 `src/app/(auth)/login/page.tsx`)。
///
/// フロー:
/// 1. email 入力 → validator (空 + 形式) で検証
/// 2. `supabase.auth.signInWithOtp(email, emailRedirectTo)` を呼ぶ
/// 3. 成功で `_SentView` (送信済み) に `AnimatedSwitcher` で切替
/// 4. 失敗は SnackBar + form に留まる
///
/// `emailRedirectTo` はコンストラクタで受け取る (web origin + `/auth/callback`
/// を組み立てるのは親 / main の責務。テスト時は固定値を注入できる)。
///
/// E2E (実際の Magic Link メール送受信 + リンク踏破) は実 Supabase 接続が
/// 必要なため worktree では検証不能。本 widget test は mock 注入で
/// 「signInWithOtp が正しい引数で呼ばれ、UI が送信済みに切替わる」ところまで検証する。
class LoginPage extends ConsumerStatefulWidget {
  const LoginPage({required this.emailRedirectTo, super.key});

  /// Magic Link クリック後に戻る URL (例: `https://app/auth/callback?returnTo=/baby`)。
  final String emailRedirectTo;

  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends ConsumerState<LoginPage> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();

  bool _isLoading = false;
  bool _sent = false;

  @override
  void dispose() {
    _emailController.dispose();
    super.dispose();
  }

  String? _validateEmail(String? value) {
    final email = value?.trim() ?? '';
    if (email.isEmpty) {
      return 'メールアドレスを入力してください';
    }
    if (!RegExp(r'^[^@]+@[^@]+\.[^@]+$').hasMatch(email)) {
      return 'メールアドレスの形式が正しくありません';
    }
    return null;
  }

  Future<void> _submit() async {
    final form = _formKey.currentState;
    if (form == null || !form.validate()) {
      return;
    }
    await _sendMagicLink(_emailController.text.trim());
  }

  /// 送信済みビューからの再送 (同じアドレスに再度 Magic Link を送る)。
  Future<void> _resend() => _sendMagicLink(_emailController.text.trim());

  /// `signInWithOtp` を実行する共通処理。submit / resend の両方から呼ばれる。
  Future<void> _sendMagicLink(String email) async {
    if (_isLoading || email.isEmpty) return;
    setState(() => _isLoading = true);

    final client = ref.read(supabaseClientProvider);
    try {
      await client.auth
          .signInWithOtp(
            email: email,
            emailRedirectTo: widget.emailRedirectTo,
          )
          .timeout(const Duration(seconds: 10));
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _sent = true;
      });
    } on AuthException catch (e) {
      // CLAUDE.md「エラー握り潰し禁止」: plain object を構造化ログ。
      debugPrint(
        'LoginPage.signInWithOtp AuthException: '
        'message=${e.message}, statusCode=${e.statusCode}, code=${e.code}',
      );
      _onSubmitError();
    } on Object catch (e, stack) {
      // timeout / ネットワーク等。詳細を握り潰さずログ。
      debugPrint('LoginPage.signInWithOtp error: $e\n$stack');
      _onSubmitError();
    }
  }

  void _onSubmitError() {
    if (!mounted) return;
    setState(() => _isLoading = false);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('送信に失敗しました。もう一度お試しください。')),
    );
  }

  void _reset() {
    setState(() {
      _sent = false;
      _emailController.clear();
    });
  }

  /// 送信済みビューでの戻る操作 = form に戻す (ページからは抜けない)。
  /// 送信中はダブル操作 / 中断防止のため pop を抑止する。
  bool get _canPop => !_sent && !_isLoading;

  void _onPopInvoked(bool didPop, Object? result) {
    if (didPop) return;
    // 送信済みビューで戻る → form に戻す。
    if (_sent && !_isLoading) {
      _reset();
    }
  }

  @override
  Widget build(BuildContext context) {
    // WillPopScope は非推奨ゆえ PopScope を使う (constraint #7)。
    // 送信済み / 送信中はページ離脱を抑止し、戻る操作は form 復帰に充てる。
    return PopScope(
      canPop: _canPop,
      onPopInvokedWithResult: _onPopInvoked,
      child: Scaffold(
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _Branding(),
                    const SizedBox(height: 32),
                    GlassCard(
                      padding: const EdgeInsets.all(24),
                      child: AnimatedSwitcher(
                        duration: const Duration(milliseconds: 250),
                        child: _sent
                            ? _SentView(
                                key: const ValueKey('sent'),
                                email: _emailController.text.trim(),
                                isLoading: _isLoading,
                                onResend: _resend,
                                onReset: _reset,
                              )
                            : _LoginForm(
                                key: const ValueKey('form'),
                                formKey: _formKey,
                                emailController: _emailController,
                                isLoading: _isLoading,
                                validateEmail: _validateEmail,
                                onSubmit: _submit,
                              ),
                      ),
                    ),
                    const SizedBox(height: 24),
                    Text(
                      'パスワード不要。メールアドレスだけでログインできます。',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Branding extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          width: 64,
          height: 64,
          decoration: BoxDecoration(
            color: IroriColors.primary.withValues(alpha: 0.1),
            borderRadius: BorderRadius.circular(IroriRadii.card),
          ),
          child: const Icon(
            LucideIcons.flame,
            size: 32,
            color: IroriColors.primary,
          ),
        ),
        const SizedBox(height: 16),
        Text(
          'うちのログ',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 4),
        Text(
          '夫婦の献立・買い物・暮らしをひとつに',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}

class _LoginForm extends StatelessWidget {
  const _LoginForm({
    required this.formKey,
    required this.emailController,
    required this.isLoading,
    required this.validateEmail,
    required this.onSubmit,
    super.key,
  });

  final GlobalKey<FormState> formKey;
  final TextEditingController emailController;
  final bool isLoading;
  final FormFieldValidator<String> validateEmail;
  final Future<void> Function() onSubmit;

  @override
  Widget build(BuildContext context) {
    return Form(
      key: formKey,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextFormField(
            controller: emailController,
            enabled: !isLoading,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            autovalidateMode: AutovalidateMode.onUserInteraction,
            decoration: const InputDecoration(
              labelText: 'メールアドレス',
              hintText: 'example@email.com',
              prefixIcon: Icon(LucideIcons.mail),
            ),
            validator: validateEmail,
            onFieldSubmitted: (_) {
              if (!isLoading) onSubmit();
            },
          ),
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            child: FilledButton(
              onPressed: isLoading ? null : onSubmit,
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
              ),
              child: isLoading
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: Colors.white,
                      ),
                    )
                  : const Text('マジックリンクを送信'),
            ),
          ),
        ],
      ),
    );
  }
}

class _SentView extends StatelessWidget {
  const _SentView({
    required this.email,
    required this.isLoading,
    required this.onResend,
    required this.onReset,
    super.key,
  });

  final String email;
  final bool isLoading;
  final Future<void> Function() onResend;
  final VoidCallback onReset;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: IroriColors.primary.withValues(alpha: 0.1),
            shape: BoxShape.circle,
          ),
          child: const Icon(
            LucideIcons.mail,
            size: 24,
            color: IroriColors.primary,
          ),
        ),
        const SizedBox(height: 16),
        Text(
          'メールを送信しました',
          style: Theme.of(context).textTheme.titleLarge,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 8),
        Text.rich(
          TextSpan(
            children: [
              TextSpan(
                text: email,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              const TextSpan(
                text:
                    ' にログインリンクを送信しました。'
                    'メールを確認してリンクをタップしてください。',
              ),
            ],
          ),
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium,
        ),
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          child: FilledButton.tonal(
            onPressed: isLoading ? null : onResend,
            style: FilledButton.styleFrom(
              minimumSize: const Size.fromHeight(44),
            ),
            child: isLoading
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('メールを再送する'),
          ),
        ),
        const SizedBox(height: 4),
        TextButton(
          onPressed: isLoading ? null : onReset,
          style: TextButton.styleFrom(
            minimumSize: const Size.fromHeight(44),
          ),
          child: const Text('別のメールアドレスで試す'),
        ),
      ],
    );
  }
}
